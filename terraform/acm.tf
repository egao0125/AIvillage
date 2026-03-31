# ---------------------------------------------------------------------------
# ACM Certificate + Route 53 DNS validation
#
# Prerequisites:
#   1. Register domain_name in variables.tf / terraform.tfvars
#   2. Create/verify hosted_zone_id in Route53 (or set to "" to skip DNS records)
#
# After apply:
#   - Certificate ARN is in terraform output: acm_certificate_arn
#   - Update k8s/05-ingress.yaml: replace REPLACE_WITH_ACM_CERTIFICATE_ARN
#     with the output value  (CI/CD does this automatically)
# ---------------------------------------------------------------------------

# Request ACM cert for the apex domain + www subdomain
resource "aws_acm_certificate" "app" {
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
  for_each = {
    for dvo in aws_acm_certificate.app.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
    # Only create records if a hosted zone is configured
    if var.hosted_zone_id != ""
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.hosted_zone_id
}

# Wait for DNS propagation and ACM issuance
resource "aws_acm_certificate_validation" "app" {
  count                   = var.hosted_zone_id != "" ? 1 : 0
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]
}

# Route 53 A-record pointing to the ALB (populated after ingress is created)
# This is a data source — it waits for the ALB to exist.
# The ALB hostname is emitted by the AWS Load Balancer Controller and stored
# in the Ingress status.loadBalancer.ingress[0].hostname field.
#
# NOTE: This record must be applied AFTER the EKS ingress is created.
#       Run `terraform apply -target=aws_route53_record.app` as a second step,
#       or use the CI/CD pipeline which handles ordering automatically.
resource "aws_route53_record" "app" {
  count   = var.hosted_zone_id != "" && var.alb_dns_name != "" ? 1 : 0
  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "CNAME"
  ttl     = 60
  records = [var.alb_dns_name]
}

resource "aws_route53_record" "app_www" {
  count   = var.hosted_zone_id != "" && var.alb_dns_name != "" ? 1 : 0
  zone_id = var.hosted_zone_id
  name    = "www.${var.domain_name}"
  type    = "CNAME"
  ttl     = 60
  records = [var.alb_dns_name]
}
