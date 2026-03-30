# Retrieve current AWS account ID for use in IAM resource ARNs.
# Avoids hardcoding and ensures least-privilege (specific account only).
data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# IAM role for the AWS Load Balancer Controller (IRSA).
#
# IRSA (IAM Roles for Service Accounts) lets the LB controller pod assume an
# IAM role without storing credentials in a Secret. The EKS OIDC provider
# (enabled in eks.tf) makes this possible.
#
# The LB controller needs permission to create/manage ALBs, target groups,
# listeners, security groups, and WAF associations on behalf of Ingress objects.
# ---------------------------------------------------------------------------

# IAM policy for the AWS Load Balancer Controller.
# Policy JSON is vendored locally (terraform/lb-controller-iam-policy.json) rather than
# fetched at apply time from GitHub. This prevents supply chain attacks via repository
# compromise or tag rewriting, and removes the runtime network dependency.
# (AWS Well-Architected SEC 9 / NIST SP 800-161 supply chain risk management)
#
# To update: download the new version and replace the file:
#   curl -fsSL https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/vX.Y.Z/docs/install/iam_policy.json \
#     -o terraform/lb-controller-iam-policy.json
# Then update the version comment below and in helm.tf.
# Vendored from: v2.7.2
resource "aws_iam_policy" "lb_controller" {
  name        = "${var.cluster_name}-lb-controller"
  description = "IAM policy for the AWS Load Balancer Controller on cluster ${var.cluster_name}"
  policy      = file("${path.module}/lb-controller-iam-policy.json")
}

# IRSA role: trusted by the EKS OIDC provider for the specific service account.
module "lb_controller_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.39"

  role_name = "${var.cluster_name}-lb-controller"

  # Bind to the exact service account created by the Helm chart.
  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:aws-load-balancer-controller"]
    }
  }

  role_policy_arns = {
    lb_controller = aws_iam_policy.lb_controller.arn
  }

  tags = var.tags
}

# ---------------------------------------------------------------------------
# IRSA: External Secrets Operator — Secrets Manager read
# ---------------------------------------------------------------------------

# Supplemental KMS policy for ESO: attach_external_secrets_policy doesn't cover KMS.
# Required so ESO can decrypt CMK-encrypted Secrets Manager values.
resource "aws_iam_policy" "eso_kms" {
  name        = "${var.cluster_name}-eso-kms"
  description = "Allow ESO IRSA role to decrypt Secrets Manager CMK-encrypted secrets"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SecretsManagerKMSDecrypt"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:DescribeKey",
        ]
        Resource = aws_kms_key.secrets_manager.arn
      },
    ]
  })

  tags = var.tags
}

module "eso_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.39"

  role_name = "${var.cluster_name}-eso"

  attach_external_secrets_policy                 = true
  external_secrets_secrets_manager_arns = [
    # App secrets (all ai-village/* paths)
    "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:ai-village/*",
    # RDS-managed master password (rds!db-* path, used by db-migrate Job only)
    "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:rds!db-*",
  ]
  external_secrets_secrets_manager_create_permission = false

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["external-secrets:external-secrets"]
    }
  }

  role_policy_arns = {
    eso_kms = aws_iam_policy.eso_kms.arn
  }

  tags = var.tags
}

# ---------------------------------------------------------------------------
# IRSA: Application Pod — Secrets Manager read + Cognito admin API
# ---------------------------------------------------------------------------
module "app_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.39"

  role_name = "${var.cluster_name}-app"

  role_policy_arns = {
    secrets = aws_iam_policy.app_secrets.arn
  }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["ai-village:ai-village"]
    }
  }

  tags = var.tags
}

resource "aws_iam_policy" "app_secrets" {
  name        = "${var.cluster_name}-app-secrets"
  description = "Allow app pod to read Secrets Manager and call Cognito Admin API"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SecretsManagerRead"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:ai-village/*"
      },
      {
        Sid    = "CognitoAdminAPI"
        Effect = "Allow"
        Action = [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminSetUserPassword",
          "cognito-idp:AdminInitiateAuth",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminUserGlobalSignOut",
        ]
        Resource = aws_cognito_user_pool.this.arn
      },
      {
        # KMS: allow app pod to decrypt secrets encrypted with the Secrets Manager CMK.
        # EnableIAMUserPermissions pattern: key policy grants root kms:*,
        # so this IAM policy controls actual data-plane access.
        # (AWS Well-Architected SEC 8 / NIST SP 800-53 SC-28)
        Sid    = "SecretsManagerKMSDecrypt"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:DescribeKey",
        ]
        Resource = aws_kms_key.secrets_manager.arn
      },
    ]
  })

  tags = var.tags
}
