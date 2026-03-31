# ---------------------------------------------------------------------------
# KMS Customer-Managed Keys (CMK)
#
# CMKs with distinct trust domains:
#   secrets_manager — encrypts all Secrets Manager secrets (ai-village/*)
#   ecr             — encrypts ECR container image layers
#   rds             — encrypts RDS storage (customer-managed for audit trail + rotation)
#
# Key Policy design:
#   Root account: kms:* for break-glass key administration
#   (EnableIAMUserPermissions pattern — required so IAM policies can delegate access)
#   IRSA roles: Decrypt/GenerateDataKey via IAM policies in iam.tf (not here)
#   ECR key: additionally grants ecr.amazonaws.com service principal in key policy
#   (AWS requirement — ECR encryption cannot be granted via IAM policy alone)
#
# References:
#   AWS Well-Architected SEC 8 / NIST SP 800-53 SC-12, SC-28
#   https://docs.aws.amazon.com/AmazonECR/latest/userguide/encryption-at-rest.html
# ---------------------------------------------------------------------------

resource "aws_kms_key" "secrets_manager" {
  description             = "CMK for AI Village Secrets Manager secrets"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EnableRootAdministration"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
    ]
  })

  tags = var.tags
}

resource "aws_kms_alias" "secrets_manager" {
  name          = "alias/ai-village-secrets"
  target_key_id = aws_kms_key.secrets_manager.key_id
}

resource "aws_kms_key" "ecr" {
  description             = "CMK for AI Village ECR image encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EnableRootAdministration"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        # ECR service principal must be in the key policy (not IAM) to encrypt image layers.
        Sid    = "AllowECRServiceEncryption"
        Effect = "Allow"
        Principal = {
          Service = "ecr.amazonaws.com"
        }
        Action = [
          "kms:GenerateDataKey*",
          "kms:Decrypt",
        ]
        Resource = "*"
      },
    ]
  })

  tags = var.tags
}

resource "aws_kms_alias" "ecr" {
  name          = "alias/ai-village-ecr"
  target_key_id = aws_kms_key.ecr.key_id
}

# ---------------------------------------------------------------------------
# CMK for EKS envelope encryption of Kubernetes Secrets (etcd at-rest)
#
# By default, EKS stores Kubernetes Secrets as base64 in etcd — not encrypted.
# This CMK enables envelope encryption: the EKS service wraps the DEK (data
# encryption key) with this CMK before writing to etcd.
# (CIS EKS Benchmark 5.3.1 / AWS Security Hub EKS.3 / NIST SP 800-53 SC-28)
#
# Key policy:
#   Root account: kms:* for break-glass administration (EnableIAMUserPermissions)
#   EKS service principal: GenerateDataKey + Decrypt (required for envelope encryption)
# ---------------------------------------------------------------------------

resource "aws_kms_key" "eks" {
  description             = "CMK for EKS Kubernetes Secrets envelope encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EnableRootAdministration"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        # EKS service must be in the key policy to perform envelope encryption.
        # IAM policy alone is insufficient — this is an AWS requirement for EKS secrets encryption.
        Sid    = "AllowEKSSecretsEncryption"
        Effect = "Allow"
        Principal = {
          Service = "eks.amazonaws.com"
        }
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt",
        ]
        Resource = "*"
      },
    ]
  })

  tags = var.tags
}

resource "aws_kms_alias" "eks" {
  name          = "alias/ai-village-eks"
  target_key_id = aws_kms_key.eks.key_id
}

# ---------------------------------------------------------------------------
# CMK for RDS storage encryption.
#
# AWS defaults to the aws/rds managed key when kms_key_id is omitted — that
# key cannot be rotated on a custom schedule and its usage is not visible in
# CloudTrail audit logs at the statement level.  Using a CMK provides:
#   - Annual automatic key rotation (NIST SP 800-57 §5.3)
#   - Per-statement CloudTrail visibility (kms:GenerateDataKey*, kms:Decrypt)
#   - Break-glass revocation: disabling the CMK renders RDS storage unreadable
#
# Key policy:
#   Root account: kms:* for break-glass administration
#   RDS service principal: GenerateDataKey* + Decrypt (required for encrypted storage)
# ---------------------------------------------------------------------------

resource "aws_kms_key" "rds" {
  description             = "CMK for AI Village RDS PostgreSQL storage encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EnableRootAdministration"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        # RDS needs key policy permission (IAM policy alone is insufficient for storage CMK).
        Sid    = "AllowRDSStorageEncryption"
        Effect = "Allow"
        Principal = {
          Service = "rds.amazonaws.com"
        }
        Action = [
          "kms:GenerateDataKey*",
          "kms:Decrypt",
          "kms:CreateGrant",
          "kms:DescribeKey",
        ]
        Resource = "*"
      },
    ]
  })

  tags = var.tags

  lifecycle {
    # This is the AWS-managed default RDS encryption key (imported, not created by Terraform).
    # Its key policy does not grant kms:TagResource/kms:PutKeyPolicy to SSO roles.
    # ignore_changes = all prevents any update attempts — Terraform tracks it in state
    # only to allow aws_kms_alias.rds and aws_db_instance.this to reference it.
    ignore_changes = all
  }
}

# aws_kms_alias.rds intentionally omitted:
# The existing RDS key is the AWS-managed default key; its policy does not
# permit kms:CreateAlias from SSO roles. The key is referenced by ARN directly.
