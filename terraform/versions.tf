terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.27"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.13"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # ---------------------------------------------------------------------------
  # Remote state backend — S3 + DynamoDB locking.
  # Uncomment AFTER running the one-time bootstrap in bootstrap/README.md.
  #
  # terraform init -reconfigure
  # ---------------------------------------------------------------------------
  # backend "s3" {
  #   bucket         = "ai-village-terraform-state-<AWS_ACCOUNT_ID>"
  #   key            = "infra/eks/terraform.tfstate"
  #   region         = var.aws_region          # variables not allowed in backend
  #   encrypt        = true
  #   dynamodb_table = "ai-village-terraform-locks"
  # }
}
