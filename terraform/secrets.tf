# ---------------------------------------------------------------------------
# Secrets Manager — app secrets (ESO syncs these into k8s Secret)
# lifecycle.ignore_changes prevents Terraform from overwriting after apply
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "encryption_key" {
  name                    = "ai-village/encryption-key"
  description             = "AES-256 encryption key for AI Village"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "encryption_key" {
  secret_id     = aws_secretsmanager_secret.encryption_key.id
  secret_string = jsonencode({ ENCRYPTION_KEY = "REPLACE_AFTER_APPLY" })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "dev_admin_token" {
  name                    = "ai-village/dev-admin-token"
  description             = "Dev admin bypass token for AI Village"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "dev_admin_token" {
  secret_id     = aws_secretsmanager_secret.dev_admin_token.id
  secret_string = jsonencode({ DEV_ADMIN_TOKEN = "REPLACE_AFTER_APPLY" })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "db_app_user" {
  name                    = "ai-village/db-app-user"
  description             = "PostgreSQL app user credentials for AI Village"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "db_app_user" {
  secret_id = aws_secretsmanager_secret.db_app_user.id
  secret_string = jsonencode({
    username = "aivillage_app"
    password = "REPLACE_AFTER_APPLY"
    host     = "REPLACE_AFTER_APPLY"
    port     = "5432"
    dbname   = "aivillage"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "redis_url" {
  name                    = "ai-village/redis-url"
  description             = "ElastiCache Redis URL for AI Village"
  recovery_window_in_days = 7
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id     = aws_secretsmanager_secret.redis_url.id
  secret_string = jsonencode({ REDIS_URL = "REPLACE_AFTER_APPLY" })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
