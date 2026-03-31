# ---------------------------------------------------------------------------
# Secrets Manager — app secrets (ESO syncs these into k8s Secret)
#
# DESIGN: "skeleton-first" pattern
#   1. `terraform apply` creates the secret resources with placeholder values.
#   2. After apply, manually set real values via AWS CLI or Console (see below).
#   3. lifecycle.ignore_changes = [secret_string] prevents subsequent applies
#      from overwriting the real values with the placeholders.
#
# AFTER APPLY — replace each placeholder with real values:
#
#   # encryption-key  (32-byte random hex string recommended)
#   aws secretsmanager put-secret-value \
#     --secret-id ai-village/encryption-key \
#     --secret-string '{"ENCRYPTION_KEY":"<your-256-bit-key>"}'
#
#   # dev-admin-token  (strong random token for dev bypass)
#   aws secretsmanager put-secret-value \
#     --secret-id ai-village/dev-admin-token \
#     --secret-string '{"DEV_ADMIN_TOKEN":"<your-token>"}'
#
#   # db-app-user  (use the RDS endpoint from `terraform output rds_host`)
#   aws secretsmanager put-secret-value \
#     --secret-id ai-village/db-app-user \
#     --secret-string '{"username":"aivillage_app","password":"<db-password>","host":"<rds-host>","port":"5432","dbname":"aivillage"}'
#
#   # redis-url  (use the endpoint from `terraform output redis_endpoint`)
#   aws secretsmanager put-secret-value \
#     --secret-id ai-village/redis-url \
#     --secret-string '{"REDIS_URL":"<rediss://...>"}'
#
# WARNING: Do NOT run `terraform apply` again before replacing the placeholders,
# as ignore_changes will protect the real values once set. However, if the secret
# version resource is tainted or recreated, the placeholder will overwrite the
# real value and must be replaced again.
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "encryption_key" {
  name                    = "ai-village/encryption-key"
  description             = "AES-256 encryption key for AI Village"
  recovery_window_in_days = 7
  kms_key_id              = aws_kms_key.secrets_manager.arn
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
  kms_key_id              = aws_kms_key.secrets_manager.arn
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
  kms_key_id              = aws_kms_key.secrets_manager.arn
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

# Redis AUTH token — generated at apply time and stored in Secrets Manager.
# ElastiCache requires transit_encryption_enabled = true when auth_token is set (already done).
# The token is auto-generated with random_password so no manual step is needed.
# Rotation: update auth_token in redis.tf + Secrets Manager, then set
#   auth_token_update_strategy = "ROTATE" in aws_elasticache_replication_group.
resource "random_password" "redis_auth" {
  length  = 64
  # ElastiCache auth_token: printable ASCII only; @, ", /, and space are not allowed.
  special          = true
  # ElastiCache AUTH token valid special chars: !&#$^<>- only.
  # (%, *, (, ), _, =, +, [, ], {, }, ?, / are rejected by ElastiCache ModifyReplicationGroup)
  override_special = "!&#$^<>-"

  # Keep the same token across plan/apply cycles.
  lifecycle {
    ignore_changes = [result]
  }
}

resource "aws_secretsmanager_secret" "redis_auth_token" {
  name                    = "ai-village/redis-auth-token"
  description             = "ElastiCache Redis AUTH token for AI Village"
  recovery_window_in_days = 7
  kms_key_id              = aws_kms_key.secrets_manager.arn
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "redis_auth_token" {
  secret_id     = aws_secretsmanager_secret.redis_auth_token.id
  secret_string = jsonencode({ REDIS_AUTH_TOKEN = random_password.redis_auth.result })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "redis_url" {
  name                    = "ai-village/redis-url"
  description             = "ElastiCache Redis URL (with AUTH token) for AI Village"
  recovery_window_in_days = 7
  kms_key_id              = aws_kms_key.secrets_manager.arn
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "redis_url" {
  secret_id = aws_secretsmanager_secret.redis_url.id
  secret_string = jsonencode({
    REDIS_URL = "rediss://:${random_password.redis_auth.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------------
# Anthropic API keys — global keys (narrator + agent fallback)
#
# Usage in the engine:
#   1. Narrator / Storyline Detector / Recap Generator
#      → Village-wide commentary and weekly summaries.
#        Uses ANTHROPIC_API_KEY (KEY_1). Required for these features.
#
#   2. Agent fallback (for agents without a per-agent BYOK key)
#      → Round-robins between ANTHROPIC_API_KEY and ANTHROPIC_API_KEY_2.
#        KEY_2 helps stay under Anthropic rate limits when many agents
#        share the same key (odd-indexed agents use KEY_2).
#        Leave KEY_2 empty if you have few agents or all use BYOK.
#
# Per-agent keys (set via app UI) always take priority over these globals.
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "anthropic_api_key" {
  name                    = "ai-village/anthropic-api-key"
  description             = "Anthropic API KEY_1 — narrator/recap + odd-agent fallback"
  recovery_window_in_days = 7
  kms_key_id              = aws_kms_key.secrets_manager.arn
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "anthropic_api_key" {
  secret_id     = aws_secretsmanager_secret.anthropic_api_key.id
  secret_string = jsonencode({ ANTHROPIC_API_KEY = "" })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "anthropic_api_key_2" {
  name                    = "ai-village/anthropic-api-key-2"
  description             = "Anthropic API KEY_2 — optional second key for even-agent round-robin (rate-limit spreading)"
  recovery_window_in_days = 7
  kms_key_id              = aws_kms_key.secrets_manager.arn
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "anthropic_api_key_2" {
  secret_id     = aws_secretsmanager_secret.anthropic_api_key_2.id
  secret_string = jsonencode({ ANTHROPIC_API_KEY_2 = "" })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------------
# Cognito app client secret — auto-populated by Terraform (no REPLACE_AFTER_APPLY).
# Terraform reads aws_cognito_user_pool_client.this.client_secret directly.
# No lifecycle.ignore_changes — Terraform owns this value.
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "cognito_client_secret" {
  name                    = "ai-village/cognito-client-secret"
  description             = "Cognito app client secret for SecretHash computation (generate_secret=true)"
  recovery_window_in_days = 7
  kms_key_id              = aws_kms_key.secrets_manager.arn
  tags                    = var.tags
}

resource "aws_secretsmanager_secret_version" "cognito_client_secret" {
  secret_id = aws_secretsmanager_secret.cognito_client_secret.id
  secret_string = jsonencode({
    COGNITO_CLIENT_SECRET = aws_cognito_user_pool_client.this.client_secret
  })
  # No lifecycle.ignore_changes: Terraform writes and owns this value automatically.
  # If the Cognito client is recreated, Terraform updates this secret automatically.
}
