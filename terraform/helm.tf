# ---------------------------------------------------------------------------
# Helm releases installed into the EKS cluster.
#
# Depends on the cluster being ready (handled by Terraform dependency graph
# via module.eks). Both releases are applied in a single `terraform apply`.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# AWS Load Balancer Controller
# Converts Ingress objects → ALBs and Service[type=LoadBalancer] → NLBs.
# Version must match the IAM policy URL pinned in iam.tf.
# ---------------------------------------------------------------------------
resource "helm_release" "lb_controller" {
  name       = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = "1.7.2"
  namespace  = "kube-system"

  # Wait until all pods are running before Terraform marks this as complete.
  wait    = true
  timeout = 300

  set {
    name  = "clusterName"
    value = module.eks.cluster_name
  }

  # Service account is created by the chart; annotated with the IRSA role ARN.
  set {
    name  = "serviceAccount.create"
    value = "true"
  }
  set {
    name  = "serviceAccount.name"
    value = "aws-load-balancer-controller"
  }
  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.lb_controller_irsa.iam_role_arn
  }

  # The controller needs the VPC ID to create target groups.
  set {
    name  = "vpcId"
    value = module.vpc.vpc_id
  }

  set {
    name  = "region"
    value = var.aws_region
  }

  depends_on = [module.eks]
}

# ---------------------------------------------------------------------------
# metrics-server
# Required for HorizontalPodAutoscaler to read CPU/memory metrics.
# ---------------------------------------------------------------------------
resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = "3.12.1"
  namespace  = "kube-system"

  wait    = true
  timeout = 180

  depends_on = [module.eks]
}

# ---------------------------------------------------------------------------
# External Secrets Operator — syncs Secrets Manager → k8s Secret
# ---------------------------------------------------------------------------
resource "helm_release" "external_secrets" {
  name             = "external-secrets"
  repository       = "https://charts.external-secrets.io"
  chart            = "external-secrets"
  version          = "0.9.18"
  namespace        = "external-secrets"
  create_namespace = true

  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.eso_irsa.iam_role_arn
  }

  depends_on = [module.eks]
}
