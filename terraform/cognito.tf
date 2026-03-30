# ---------------------------------------------------------------------------
# Cognito User Pool — email-based auth, admin auth flow
# ---------------------------------------------------------------------------

resource "aws_cognito_user_pool" "this" {
  name = var.cluster_name

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = false
    require_uppercase                = true
    temporary_password_validity_days = 7
  }

  # Suppress welcome emails (we use AdminCreateUser + SUPPRESS)
  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  # Prevent user existence disclosure
  user_pool_add_ons {
    advanced_security_mode = "ENFORCED"
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  tags = var.tags
}

resource "aws_cognito_user_pool_client" "this" {
  name         = "${var.cluster_name}-server"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
  ]

  access_token_validity  = 60   # minutes
  refresh_token_validity = 30   # days
  id_token_validity      = 60   # minutes

  token_validity_units {
    access_token  = "minutes"
    refresh_token = "days"
    id_token      = "minutes"
  }

  prevent_user_existence_errors = "ENABLED"
}
