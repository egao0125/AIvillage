# ---------------------------------------------------------------------------
# Cognito User Pool — email-based auth, admin auth flow
# ---------------------------------------------------------------------------

resource "aws_cognito_user_pool" "this" {
  name = var.cluster_name

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    # OWASP ASVS v4.0 / NIST SP 800-63B: minimum 12 characters recommended
    minimum_length                   = 12
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
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

  # MFA — OPTIONAL allows per-user opt-in without breaking existing accounts.
  # Change to "ON" to enforce MFA for all users (OWASP ASVS v4.0 §2.8 / NIST SP 800-63B AAL2).
  mfa_configuration = "OPTIONAL"
  software_token_mfa_configuration {
    enabled = true
  }

  # Prevent accidental destruction of user accounts — irreversible in Cognito.
  # (AWS Well-Architected REL 9 / NIST SP 800-53 CP-9)
  deletion_protection = "ACTIVE"

  tags = var.tags
}

resource "aws_cognito_user_pool_client" "this" {
  name         = "${var.cluster_name}-server"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false

  # ALLOW_ADMIN_USER_PASSWORD_AUTH: required for server-side AdminInitiateAuth (auth.ts login/signup).
  # ALLOW_USER_SRP_AUTH: enables SRP-based client auth (recommended by AWS, avoids password on wire).
  # ALLOW_USER_PASSWORD_AUTH intentionally omitted: it allows clients to send plaintext passwords
  # directly to Cognito, bypassing SRP — violates OWASP ASVS v4.0 §2.1 and AWS Security Pillar.
  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
  ]

  access_token_validity  = 60   # minutes
  refresh_token_validity = 7    # days — reduced from 30 per OWASP ASVS v4.0 §3.3.2 / NIST SP 800-63B §7.1
  id_token_validity      = 60   # minutes

  token_validity_units {
    access_token  = "minutes"
    refresh_token = "days"
    id_token      = "minutes"
  }

  # Revoke refresh tokens on sign-out — ensures stolen refresh tokens can't be replayed
  # (OWASP ASVS v4.0 §3.3.3)
  enable_token_revocation = true

  prevent_user_existence_errors = "ENABLED"
}
