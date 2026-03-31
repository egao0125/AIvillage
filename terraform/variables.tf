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
  # AWS Well-Architected REL 6: deploy across multiple AZs. min=1 risks complete data-plane
  # outage if the single node fails or is drained during a cluster upgrade.
  # Production: set to 2 (one per AZ minimum). Only use 1 for cost-sensitive dev environments.
  description = "Minimum number of nodes. Set to 2+ for production HA (prevents single-node outage)."
  type        = number
  default     = 2
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
  # IMMUTABLE: prevents tag overwriting — required to ensure deployed image integrity
  # and supply chain security (CIS ECR / AWS Well-Architected Security Pillar).
  # Use commit-SHA or semver tags (e.g. v1.2.3) instead of 'latest'.
  # Set to "MUTABLE" only during initial development when a fixed workflow isn't yet in place.
  description = "IMMUTABLE enforces tag uniqueness (recommended). MUTABLE allows overwriting tags."
  type        = string
  default     = "IMMUTABLE"
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

variable "eks_public_access_cidrs" {
  # CIS EKS Benchmark 5.4.2: restrict public API endpoint access to known CIDRs.
  # Add your corporate/VPN CIDR(s) here. Using ["0.0.0.0/0"] exposes the k8s
  # API server to the internet — only auth protects it, no network-layer defence.
  # To disable public access entirely: set cluster_endpoint_public_access = false in eks.tf.
  # Example terraform.tfvars: eks_public_access_cidrs = ["203.0.113.0/24"]
  description = "CIDRs allowed to reach the EKS public API endpoint. Restrict to VPN/corporate IPs. Must not be empty."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.eks_public_access_cidrs) > 0 && !contains(var.eks_public_access_cidrs, "0.0.0.0/0")
    error_message = "eks_public_access_cidrs must be set to specific CIDRs (e.g. VPN range). '0.0.0.0/0' and empty list are not allowed (CIS EKS 5.4.2)."
  }
}

variable "domain_name" {
  description = "Primary domain for the application (e.g. aivillage.example.com). Used for ACM cert + Route53."
  type        = string
  default     = ""
}

variable "alb_dns_name" {
  description = "ALB DNS name from kubectl get ingress (populated after first deploy, used for Route53 records)."
  type        = string
  default     = ""
}

variable "alb_hosted_zone_id" {
  description = "ALB canonical hosted zone ID (from aws elbv2 describe-load-balancers .CanonicalHostedZoneId). Used for Route53 ALIAS record at apex domain."
  type        = string
  default     = "Z14GRHDCWA56QT"  # ap-northeast-1 ALB canonical zone ID
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
