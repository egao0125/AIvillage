# ---------------------------------------------------------------------------
# ACM Certificate + Route 53 DNS validation
#
# Prerequisites:
#   1. Set domain_name in terraform.tfvars
#   2. Route53 hosted zone is managed in dns.tf (created or imported there)
#
# After apply:
#   - Certificate ARN: terraform output -raw acm_certificate_arn
#   - CI/CD injects this automatically into k8s/05-ingress.yaml
# ---------------------------------------------------------------------------

# Request ACM cert for the apex domain + www subdomain
resource "aws_acm_certificate" "app" {
  count                     = var.domain_name != "" ? 1 : 0
  domain_name               = var.domain_name
  subject_alternative_names = ["www.${var.domain_name}"]
  validation_method         = "DNS"

  # ACM cert renewal requires the DNS records to remain.
  # lifecycle.create_before_destroy prevents brief outages during renewal.
  lifecycle {
    create_before_destroy = true
  }

  tags = merge(var.tags, {
    Name = "${var.cluster_name}-acm-cert"
  })
}

# Route 53 DNS validation records (one per SAN)
resource "aws_route53_record" "cert_validation" {
  # try() returns {} if the cert hasn't been created yet (first apply).
  # After the cert exists, domain_validation_options is populated and records are created.
  for_each = try({
    for dvo in aws_acm_certificate.app[0].domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }, {})

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = aws_route53_zone.app[0].zone_id
}

# Wait for DNS propagation and ACM issuance
resource "aws_acm_certificate_validation" "app" {
  count                   = var.domain_name != "" ? 1 : 0
  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# Route 53 CNAME records pointing to the ALB
# Populated after ingress is created (second terraform apply or CI/CD).
resource "aws_route53_record" "app" {
  count   = var.domain_name != "" && var.alb_dns_name != "" ? 1 : 0
  zone_id = aws_route53_zone.app[0].zone_id
  name    = var.domain_name
  type    = "CNAME"
  ttl     = 60
  records = [var.alb_dns_name]
}

resource "aws_route53_record" "app_www" {
  count   = var.domain_name != "" && var.alb_dns_name != "" ? 1 : 0
  zone_id = aws_route53_zone.app[0].zone_id
  name    = "www.${var.domain_name}"
  type    = "CNAME"
  ttl     = 60
  records = [var.alb_dns_name]
}
