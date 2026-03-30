# ---------------------------------------------------------------------------
# ECR repository for the ai-village Docker image.
#
# Push workflow (after `terraform apply`):
#   aws ecr get-login-password --region <REGION> | \
#     docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com
#
#   docker build -t ai-village .
#   docker tag ai-village:latest <ECR_REPO_URL>:latest
#   docker push <ECR_REPO_URL>:latest
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "ai_village" {
  name                 = var.cluster_name
  image_tag_mutability = var.ecr_image_tag_mutability

  # Scan each image on push for known CVEs.
  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.ecr.arn
  }
}

# Keep only the last 10 untagged images (e.g. dangling build artifacts).
# Tagged releases (v1.0.0, v1.1.0 …) are never deleted by this policy.
resource "aws_ecr_lifecycle_policy" "ai_village" {
  repository = aws_ecr_repository.ai_village.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Remove untagged images older than 10 images"
        selection = {
          tagStatus   = "untagged"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}
