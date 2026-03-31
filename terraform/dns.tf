# ---------------------------------------------------------------------------
# Route 53 — Hosted Zone (managed by Terraform)
#
# WORKFLOW:
#   Option A — Register domain in AWS Console first (recommended):
#     1. Go to Route53 → Registered domains → Register domain
#     2. AWS automatically creates a hosted zone and sets NS records
#     3. Import it: terraform import 'aws_route53_zone.app[0]' <ZONE_ID>
#
#   Option B — Let Terraform create the zone first:
#     1. Set domain_name in terraform.tfvars
#     2. terraform apply → note the route53_nameservers output
#     3. Register/transfer domain at any registrar, set those 4 NS records
#
# In both cases, set domain_name in terraform.tfvars to enable.
# ---------------------------------------------------------------------------

resource "aws_route53_zone" "app" {
  count = var.domain_name != "" ? 1 : 0
  name  = var.domain_name

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-zone"
  })
}

# ---------------------------------------------------------------------------
# Outputs — needed to configure the registrar NS records (Option B above)
# ---------------------------------------------------------------------------

output "route53_nameservers" {
  description = "Route53 NS records — set these at your registrar if you registered the domain outside AWS"
  value       = var.domain_name != "" ? aws_route53_zone.app[0].name_servers : []
}

output "route53_zone_id" {
  description = "Route53 Hosted Zone ID (use for terraform import if zone was created manually)"
  value       = var.domain_name != "" ? aws_route53_zone.app[0].zone_id : ""
}
