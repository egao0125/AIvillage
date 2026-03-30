# ---------------------------------------------------------------------------
# EKS cluster — new, dedicated, no references to existing infrastructure.
#
# Key design decisions:
#   - OIDC provider enabled → IRSA (IAM Roles for Service Accounts) works
#   - Private endpoint enabled → API server not reachable from public internet
#   - Public endpoint also enabled → kubectl from a developer machine with SSO
#     (restrict to your corporate IP range via public_access_cidrs in prod)
#   - Managed node group in private subnets
# ---------------------------------------------------------------------------

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = var.cluster_name
  cluster_version = var.kubernetes_version

  # VPC from vpc.tf
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # Allow kubectl from developer machines; restrict to your IP in production.
  cluster_endpoint_public_access  = true
  cluster_endpoint_private_access = true
  # cluster_endpoint_public_access_cidrs = ["YOUR_IP/32"]

  # OIDC is required for IRSA (used by AWS Load Balancer Controller).
  enable_irsa = true

  # Cluster add-ons — kept up to date automatically.
  cluster_addons = {
    coredns = {
      most_recent = true
    }
    kube-proxy = {
      most_recent = true
    }
    vpc-cni = {
      most_recent = true
    }
    # aws-ebs-csi-driver omitted: this app uses ElastiCache, not EBS volumes.
    # Add back with service_account_role_arn (IRSA) if PersistentVolumes are needed.
  }

  # Managed node group — nodes run in private subnets.
  eks_managed_node_groups = {
    default = {
      name = "${var.cluster_name}-nodes"

      instance_types = [var.node_instance_type]
      ami_type       = "AL2_x86_64"

      min_size     = var.node_min_size
      max_size     = var.node_max_size
      desired_size = var.node_desired_size

      # Nodes live in private subnets; no public IP exposure.
      subnet_ids = module.vpc.private_subnets

      labels = {
        role = "application"
      }

      tags = {
        "k8s.io/cluster-autoscaler/enabled"              = "true"
        "k8s.io/cluster-autoscaler/${var.cluster_name}"  = "owned"
      }
    }
  }

  # Allow nodes to call the EKS API (required for cluster-autoscaler and LB controller).
  node_security_group_additional_rules = {
    ingress_self_all = {
      description = "Node-to-node all ports/protocols"
      protocol    = "-1"
      from_port   = 0
      to_port     = 0
      type        = "ingress"
      self        = true
    }
  }

  tags = var.tags
}
