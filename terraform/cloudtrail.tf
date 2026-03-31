# ---------------------------------------------------------------------------
# CloudTrail — audit trail for all AWS API calls
# Ref: CIS AWS Foundations Benchmark 2.1-2.7, AWS Well-Architected SEC 4
#      NIST SP 800-53 AU-2, AU-12
#
# Design:
#   - Multi-region trail: captures all regions in this account (CIS 2.1)
#   - Log file validation: SHA-256 digest to detect tampering (CIS 2.2)
#   - CloudWatch Logs integration: enables metric filters and alerting
#   - S3 + KMS CMK encryption: CMK with key rotation (CIS 2.7)
#   - S3 public access fully blocked: logs never publicly accessible
#   - 1-year retention in S3, 90-day in CW Logs (CIS 2.6)
# ---------------------------------------------------------------------------

# KMS key — CloudTrail requires an explicit key policy granting the service
# kms:GenerateDataKey*; IAM policies alone are insufficient for CloudTrail CMK.
resource "aws_kms_key" "cloudtrail" {
  description             = "CMK for AI Village CloudTrail log encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableRootAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        # CloudTrail must be allowed to encrypt via key policy (IAM alone insufficient)
        Sid    = "AllowCloudTrailEncrypt"
        Effect = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = ["kms:GenerateDataKey*"]
        Resource  = "*"
        Condition = {
          StringLike = {
            "kms:EncryptionContext:aws:cloudtrail:arn" = "arn:aws:cloudtrail:*:${data.aws_caller_identity.current.account_id}:trail/*"
          }
        }
      },
      {
        Sid    = "AllowCloudTrailDescribeKey"
        Effect = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "kms:DescribeKey"
        Resource  = "*"
      },
      {
        # CloudWatch Logs service must decrypt to deliver log events
        Sid    = "AllowCloudWatchLogsDecrypt"
        Effect = "Allow"
        Principal = {
          Service = "logs.${var.aws_region}.amazonaws.com"
        }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
        Condition = {
          ArnLike = {
            "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/cloudtrail/ai-village"
          }
        }
      },
    ]
  })
  tags = var.tags
}

resource "aws_kms_alias" "cloudtrail" {
  name          = "alias/ai-village-cloudtrail"
  target_key_id = aws_kms_key.cloudtrail.key_id
}

# ---------------------------------------------------------------------------
# S3 bucket for CloudTrail logs
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "cloudtrail" {
  # Bucket name must be globally unique — account ID suffix ensures uniqueness
  bucket        = "ai-village-cloudtrail-${data.aws_caller_identity.current.account_id}"
  force_destroy = false  # Never auto-delete audit logs
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket                  = aws_s3_bucket.cloudtrail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.cloudtrail.arn
    }
    bucket_key_enabled = true  # Reduces KMS API call costs by ~99%
  }
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  versioning_configuration {
    status = "Enabled"  # Enables object lock for tamper-evidence
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  rule {
    id     = "cloudtrail-log-retention"
    status = "Enabled"
    filter {}
    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }
    expiration {
      days = 365  # CIS 2.6: retain audit logs ≥ 1 year
    }
  }
}

# Bucket policy: only CloudTrail (via SourceArn condition) may write logs
resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.cloudtrail.arn
        Condition = {
          StringEquals = {
            "aws:SourceArn" = "arn:aws:cloudtrail:${var.aws_region}:${data.aws_caller_identity.current.account_id}:trail/ai-village"
          }
        }
      },
      {
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.cloudtrail.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"  = "bucket-owner-full-control"
            "aws:SourceArn" = "arn:aws:cloudtrail:${var.aws_region}:${data.aws_caller_identity.current.account_id}:trail/ai-village"
          }
        }
      },
    ]
  })
  # Bucket policy must exist before CloudTrail can write
  depends_on = [aws_s3_bucket_public_access_block.cloudtrail]
}

# ---------------------------------------------------------------------------
# CloudWatch Logs — real-time trail delivery for alerting
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "cloudtrail" {
  name              = "/aws/cloudtrail/ai-village"
  retention_in_days = 90   # Operational query window; long-term archive is S3
  kms_key_id        = aws_kms_key.cloudtrail.arn
  tags              = var.tags
}

resource "aws_iam_role" "cloudtrail_cloudwatch" {
  name = "${var.cluster_name}-cloudtrail-cw"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cloudtrail.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "cloudtrail_cloudwatch" {
  name = "cloudwatch-logs-delivery"
  role = aws_iam_role.cloudtrail_cloudwatch.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
    }]
  })
}

# ---------------------------------------------------------------------------
# CloudTrail trail
# ---------------------------------------------------------------------------

resource "aws_cloudtrail" "main" {
  name                          = "ai-village"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  kms_key_id                    = aws_kms_key.cloudtrail.arn
  include_global_service_events = true   # Captures IAM, STS, CloudFront (CIS 2.1)
  is_multi_region_trail         = true   # CIS 2.1
  enable_log_file_validation    = true   # CIS 2.2 — SHA-256 digest per delivery
  cloud_watch_logs_group_arn    = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn     = aws_iam_role.cloudtrail_cloudwatch.arn
  tags                          = var.tags

  # S3 bucket policy must exist before trail creation
  depends_on = [aws_s3_bucket_policy.cloudtrail]
}
