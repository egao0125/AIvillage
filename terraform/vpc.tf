# ---------------------------------------------------------------------------
# Dedicated VPC — completely isolated from any existing VPCs in this account.
#
# Layout (3 AZs for HA):
#   Public subnets  10.100.0.0/24 – 10.100.2.0/24   → ALB lives here
#   Private subnets 10.100.10.0/24 – 10.100.12.0/24  → EKS nodes + Redis
#
# Subnet tags are required by the AWS Load Balancer Controller to discover
# which subnets to place ALBs in.
# ---------------------------------------------------------------------------

locals {
  azs             = slice(data.aws_availability_zones.available.names, 0, 3)
  public_subnets  = [for i, az in local.azs : cidrsubnet(var.vpc_cidr, 8, i)]        # .0 .1 .2
  private_subnets = [for i, az in local.azs : cidrsubnet(var.vpc_cidr, 8, i + 10)]   # .10 .11 .12
}

data "aws_availability_zones" "available" {
  state = "available"
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.cluster_name}-vpc"
  cidr = var.vpc_cidr

  azs             = local.azs
  public_subnets  = local.public_subnets
  private_subnets = local.private_subnets

  # Single NAT gateway (cost-optimised). Use enable_nat_gateway = true +
  # one_nat_gateway_per_az = true for production HA.
  enable_nat_gateway     = true
  single_nat_gateway     = true
  enable_dns_hostnames   = true
  enable_dns_support     = true

  # ---------------------------------------------------------------------------
  # VPC Flow Logs — network traffic audit trail
  # Ref: CIS AWS Foundations Benchmark 2.9, AWS Well-Architected SEC 7
  # Logs to CloudWatch for real-time alerting capability.
  # KMS-encrypted log group using the existing Secrets Manager CMK.
  # ---------------------------------------------------------------------------
  enable_flow_log                              = true
  flow_log_destination_type                   = "cloud-watch-logs"
  create_flow_log_cloudwatch_log_group         = true
  create_flow_log_cloudwatch_iam_role          = true
  flow_log_max_aggregation_interval           = 60
  flow_log_cloudwatch_log_group_kms_key_id    = aws_kms_key.secrets_manager.arn

  # ---------------------------------------------------------------------------
  # Subnet tags required by AWS Load Balancer Controller:
  #   public  → internet-facing ALBs
  #   private → internal ALBs (not used yet, but tagged for future use)
  # ---------------------------------------------------------------------------
  public_subnet_tags = {
    "kubernetes.io/role/elb"                        = "1"
    "kubernetes.io/cluster/${var.cluster_name}"     = "shared"
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"               = "1"
    "kubernetes.io/cluster/${var.cluster_name}"     = "shared"
  }
}
