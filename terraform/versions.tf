terraform {
  required_version = ">= 1.7.0, < 2.0.0"

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
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # ---------------------------------------------------------------------------
  # Remote state backend — S3 + DynamoDB locking.
  # One-time bootstrap: cd terraform/bootstrap && terraform init && terraform apply
  # Then migrate:       cd .. && terraform init -reconfigure
  # ---------------------------------------------------------------------------
  backend "s3" {
    # us-east-1 backend — created by terraform/bootstrap (run once before terraform init)
    # Old ap-northeast-1 bucket: ai-village-terraform-state-YOUR_AWS_ACCOUNT_ID (keep until migration verified)
    # Replace YOUR_AWS_ACCOUNT_ID with your AWS account ID
    bucket         = "ai-village-tfstate-us1-YOUR_AWS_ACCOUNT_ID"
    key            = "infra/eks/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "ai-village-terraform-locks-us1"
    # profile omitted: local dev uses AWS_PROFILE env var; CI uses OIDC env var credentials
  }
}
