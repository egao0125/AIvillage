#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# setup-secrets.sh — Populate AWS Secrets Manager after `terraform apply`
#
# Run once after the initial terraform apply.
# Idempotent: safe to re-run (put-secret-value overwrites the placeholder).
#
# Usage:
#   chmod +x scripts/setup-secrets.sh
#   AWS_PROFILE=ai-village ./scripts/setup-secrets.sh
#
# Prerequisites:
#   - AWS CLI configured (aws configure sso --profile ai-village)
#   - terraform apply completed (secrets exist in Secrets Manager)
#   - jq installed (brew install jq)
# ---------------------------------------------------------------------------

set -euo pipefail

PROFILE="${AWS_PROFILE:-ai-village}"
REGION="${AWS_REGION:-ap-northeast-1}"

echo "Using AWS profile: $PROFILE / region: $REGION"
echo ""

# ---- Helper ----
put_secret() {
  local secret_id="$1"
  local secret_json="$2"
  aws secretsmanager put-secret-value \
    --region "$REGION" \
    --profile "$PROFILE" \
    --secret-id "$secret_id" \
    --secret-string "$secret_json"
  echo "  ✓ $secret_id"
}

# ---- 1. ENCRYPTION_KEY (32-byte random hex) ----
echo "[1/5] Generating ENCRYPTION_KEY..."
ENCRYPTION_KEY=$(openssl rand -hex 32)
put_secret "ai-village/encryption-key" "{\"ENCRYPTION_KEY\":\"${ENCRYPTION_KEY}\"}"

# ---- 2. DEV_ADMIN_TOKEN (leave empty for production — server rejects non-empty in prod) ----
echo "[2/5] Setting DEV_ADMIN_TOKEN (empty for production)..."
put_secret "ai-village/dev-admin-token" "{\"DEV_ADMIN_TOKEN\":\"\"}"

# ---- 3. DB app user password ----
echo "[3/5] DB app user credentials — get RDS host from terraform output:"
RDS_HOST=$(cd terraform && terraform output -raw rds_host 2>/dev/null || echo "REPLACE_WITH_RDS_HOST")
DB_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
echo "  RDS host: $RDS_HOST"
echo "  Generated DB password (save this!): $DB_PASS"
echo ""
echo "  IMPORTANT: You must also CREATE the DB user in RDS:"
echo "    psql -h $RDS_HOST -U postgres -c \"CREATE USER aivillage_app WITH PASSWORD '$DB_PASS';\""
echo "    psql -h $RDS_HOST -U postgres -c \"GRANT ALL PRIVILEGES ON DATABASE aivillage TO aivillage_app;\""
echo ""
put_secret "ai-village/db-app-user" \
  "{\"username\":\"aivillage_app\",\"password\":\"${DB_PASS}\",\"host\":\"${RDS_HOST}\",\"port\":\"5432\",\"dbname\":\"aivillage\"}"

# ---- 4. Anthropic API keys (global — narrator/recap + agent fallback) ----
echo "[4/6] Anthropic API keys"
echo "  Global keys power village-wide AI features:"
echo "    ANTHROPIC_API_KEY   → narrator commentary, storyline detection, weekly recap"
echo "                          + fallback for agents without a per-agent BYOK key"
echo "    ANTHROPIC_API_KEY_2 → optional 2nd key for rate-limit round-robin"
echo "                          (odd-indexed agents use KEY_2 when set)"
echo "  Each agent can also carry its own key set via the app UI (BYOK, takes priority)."
echo ""
echo "  Enter ANTHROPIC_API_KEY (sk-ant-...) or press Enter to skip narrator/recap: "
read -r -s ANTHROPIC_KEY
if [ -n "$ANTHROPIC_KEY" ]; then
  put_secret "ai-village/anthropic-api-key" "{\"ANTHROPIC_API_KEY\":\"${ANTHROPIC_KEY}\"}"
else
  echo "  Skipped — narrator/recap/agent-fallback disabled until set."
fi

echo "  Enter ANTHROPIC_API_KEY_2 (optional, for rate-limit spreading) or press Enter to skip: "
read -r -s ANTHROPIC_KEY_2
if [ -n "$ANTHROPIC_KEY_2" ]; then
  put_secret "ai-village/anthropic-api-key-2" "{\"ANTHROPIC_API_KEY_2\":\"${ANTHROPIC_KEY_2}\"}"
else
  echo "  Skipped (all agents share KEY_1)"
fi

# ---- 5. Summary ----
echo ""
echo "[6/6] GitHub Actions secrets to set:"
echo "  (Settings → Secrets and variables → Actions)"
echo ""
DEPLOY_ROLE=$(cd terraform && terraform output -raw github_deploy_role_arn 2>/dev/null || echo "REPLACE_WITH_DEPLOY_ROLE_ARN")
CERT_ARN=$(cd terraform && terraform output -raw acm_certificate_arn 2>/dev/null || echo "")
ZONE_ID=$(cd terraform && terraform output -raw route53_zone_id 2>/dev/null || echo "")

echo "  AWS_DEPLOY_ROLE_ARN = $DEPLOY_ROLE"
[ -n "$CERT_ARN" ]  && echo "  HTTPS_CERT_ARN      = $CERT_ARN"
[ -n "$ZONE_ID" ]   && echo "  HOSTED_ZONE_ID      = $ZONE_ID"
echo ""
echo "Done. Run 'git push origin main' to trigger the first deployment."
