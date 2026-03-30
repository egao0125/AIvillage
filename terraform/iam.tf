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

# Download the official IAM policy from AWS. Pin the version to match the
# Helm chart version used in helm.tf.
data "http" "lb_controller_policy" {
  url = "https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.7.2/docs/install/iam_policy.json"
}

resource "aws_iam_policy" "lb_controller" {
  name        = "${var.cluster_name}-lb-controller"
  description = "IAM policy for the AWS Load Balancer Controller on cluster ${var.cluster_name}"
  policy      = data.http.lb_controller_policy.response_body
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
module "eso_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.39"

  role_name = "${var.cluster_name}-eso"

  attach_external_secrets_policy                 = true
  external_secrets_secrets_manager_arns          = ["arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:ai-village/*"]
  external_secrets_secrets_manager_create_permission = false

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["external-secrets:external-secrets"]
    }
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
        ]
        Resource = aws_cognito_user_pool.this.arn
      },
    ]
  })

  tags = var.tags
}
