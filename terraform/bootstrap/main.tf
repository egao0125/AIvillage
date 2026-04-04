# ---------------------------------------------------------------------------
# Bootstrap: Terraform remote state backend
#
# Run this ONCE before running terraform in the parent directory:
#
#   cd terraform/bootstrap
#   terraform init
#   terraform apply
#   cd ..
#   terraform init   # migrates local state to S3
#
# This creates:
#   - S3 bucket  : ai-village-terraform-state-YOUR_AWS_ACCOUNT_ID  (versioning + AES256 + block public)
#   - DynamoDB   : ai-village-terraform-locks               (state locking, prevents concurrent apply)
#
# The bootstrap itself uses local state (safe — it only manages 2 resources).
# ---------------------------------------------------------------------------

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

variable "aws_region" {
  default = "us-east-1"
}

variable "aws_profile" {
  default = "ai-village"
}

locals {
  account_id  = "YOUR_AWS_ACCOUNT_ID"  # Replace with: aws sts get-caller-identity --query Account --output text
  # us-east-1 backend bucket — separate from the old ap-northeast-1 bucket
  # Old bucket: ai-village-terraform-state-YOUR_AWS_ACCOUNT_ID (ap-northeast-1, keep until migration verified)
  bucket_name = "ai-village-tfstate-us1-${local.account_id}"
  dynamodb    = "ai-village-terraform-locks-us1"
}

# --- S3 bucket for Terraform state ---

resource "aws_s3_bucket" "tf_state" {
  bucket        = local.bucket_name  # ai-village-tfstate-us1-YOUR_AWS_ACCOUNT_ID
  force_destroy = false # never accidentally delete state

  tags = {
    Project   = "ai-village"
    ManagedBy = "terraform-bootstrap"
    Purpose   = "terraform-remote-state"
  }
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket                  = aws_s3_bucket.tf_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# --- DynamoDB table for state locking ---

resource "aws_dynamodb_table" "tf_locks" {
  name         = local.dynamodb  # ai-village-terraform-locks-us1
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Project   = "ai-village"
    ManagedBy = "terraform-bootstrap"
    Purpose   = "terraform-state-lock"
  }
}

output "bucket_name" {
  value = aws_s3_bucket.tf_state.bucket
}

output "dynamodb_table" {
  value = aws_dynamodb_table.tf_locks.name
}

output "next_step" {
  value = "cd .. && terraform init -reconfigure"
}
