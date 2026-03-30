output "cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "EKS API server endpoint (for kubectl config)"
  value       = module.eks.cluster_endpoint
}

output "configure_kubectl" {
  description = "Run this command to configure kubectl after apply"
  value       = "aws eks update-kubeconfig --region ${var.aws_region} --name ${module.eks.cluster_name} --profile ${var.aws_profile}"
}

output "ecr_repository_url" {
  description = "ECR image URL — use this in k8s/03-deployment.yaml"
  value       = aws_ecr_repository.ai_village.repository_url
}

output "ecr_push_commands" {
  description = "Commands to authenticate and push a Docker image to ECR"
  value       = <<-EOT
    aws ecr get-login-password --region ${var.aws_region} --profile ${var.aws_profile} | \
      docker login --username AWS --password-stdin ${aws_ecr_repository.ai_village.repository_url}

    docker build -t ${var.cluster_name} ${path.root}/..
    docker tag ${var.cluster_name}:latest ${aws_ecr_repository.ai_village.repository_url}:latest
    docker push ${aws_ecr_repository.ai_village.repository_url}:latest
  EOT
}

output "redis_endpoint" {
  description = "ElastiCache Redis primary endpoint (TLS) — use as REDIS_URL in Secrets Manager"
  value       = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
  # sensitive: connection string reveals internal hostname — suppress from terraform apply output.
  # Access with: terraform output -raw redis_endpoint
  sensitive   = true
}

output "vpc_id" {
  description = "ID of the newly created VPC (ai-village dedicated)"
  value       = module.vpc.vpc_id
}

output "rds_endpoint" {
  description = "RDS instance endpoint (host:port)"
  value       = aws_db_instance.this.endpoint
  sensitive   = true
}

output "rds_master_secret_arn" {
  description = "ARN of the RDS-managed master password secret in Secrets Manager (use in 02b-rds-master-external-secret.yaml)"
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
  # sensitive: ARN reveals account ID + secret path — suppress from terminal output.
  # Access with: terraform output -raw rds_master_secret_arn
  sensitive   = true
}

output "rds_host" {
  description = "RDS instance hostname"
  value       = aws_db_instance.this.address
  sensitive   = true
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID"
  value       = aws_cognito_user_pool.this.id
}

output "cognito_client_id" {
  description = "Cognito User Pool Client ID"
  value       = aws_cognito_user_pool_client.this.id
}

output "cognito_jwks_uri" {
  description = "Cognito JWKS URI for JWT verification"
  value       = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.this.id}/.well-known/jwks.json"
}

output "app_irsa_role_arn" {
  description = "IRSA role ARN for the application pod"
  value       = module.app_irsa.iam_role_arn
}

output "eso_irsa_role_arn" {
  description = "IRSA role ARN for External Secrets Operator"
  value       = module.eso_irsa.iam_role_arn
}
