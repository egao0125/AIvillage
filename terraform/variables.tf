# ---------------------------------------------------------------------------
# Copy terraform.tfvars.example → terraform.tfvars and fill in your values.
# terraform.tfvars is gitignored.
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region to deploy into. Must NOT overlap with regions used by existing resources unless the VPC CIDR is also changed."
  type        = string
  default     = "ap-northeast-1"
}

variable "aws_profile" {
  description = "AWS CLI profile to use (SSO profile name from ~/.aws/config)."
  type        = string
  default     = "default"
}

variable "cluster_name" {
  description = "EKS cluster name. Also used as a prefix for all created resources."
  type        = string
  default     = "ai-village"
}

variable "kubernetes_version" {
  description = "Kubernetes version for EKS. Check AWS docs for supported versions."
  type        = string
  default     = "1.29"
}

variable "vpc_cidr" {
  description = <<-EOT
    CIDR block for the new dedicated VPC.
    Change this if 10.100.0.0/16 conflicts with an existing VPC in your account.
    Check existing VPCs: aws ec2 describe-vpcs --query 'Vpcs[*].CidrBlock'
  EOT
  type        = string
  default     = "10.100.0.0/16"
}

variable "node_instance_type" {
  description = "EC2 instance type for EKS managed node group."
  type        = string
  default     = "t3.medium"
}

variable "node_min_size" {
  description = "Minimum number of nodes in the managed node group."
  type        = number
  default     = 1
}

variable "node_max_size" {
  description = "Maximum number of nodes in the managed node group."
  type        = number
  default     = 3
}

variable "node_desired_size" {
  description = "Desired number of nodes at creation time."
  type        = number
  default     = 2
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type."
  type        = string
  default     = "cache.t3.micro"
}

variable "ecr_image_tag_mutability" {
  description = "MUTABLE allows overwriting tags (e.g. 'latest'). IMMUTABLE enforces tag uniqueness."
  type        = string
  default     = "MUTABLE"
}

variable "tags" {
  description = "Tags applied to every resource. Add cost-center, owner, etc. as needed."
  type        = map(string)
  default = {
    Project     = "ai-village"
    ManagedBy   = "terraform"
    Environment = "production"
  }
}

variable "rds_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.medium"
}

variable "rds_allocated_storage" {
  description = "Initial RDS storage in GiB"
  type        = number
  default     = 20
}
