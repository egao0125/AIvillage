# ---------------------------------------------------------------------------
# AWS WAFv2 Web ACL — attached to the ALB via Ingress annotation.
#
# Rule set:
#   1. AmazonIpReputationList  — known malicious IPs (bots, scrapers, TOR exit nodes)
#   2. AWSManagedRulesCommonRuleSet — OWASP Top 10 (SQLi, XSS, path traversal, etc.)
#   3. AWSManagedRulesKnownBadInputsRuleSet — Log4Shell, Spring4Shell, SSRF patterns
#
# Default action: ALLOW (block only matched rule violations).
#
# References:
#   AWS WAF Developer Guide / CIS AWS Foundations Benchmark 6.7
#   NIST SP 800-53 SC-5 (Denial of Service Protection), SI-3 (Malicious Code Protection)
# ---------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "alb" {
  name        = "${var.cluster_name}-waf"
  description = "WAF Web ACL for AI Village ALB. OWASP Top 10 + IP reputation"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  # Rule 1: Block IPs with bad reputation (bots, scrapers, known attackers)
  rule {
    name     = "AmazonIpReputationList"
    priority = 0

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.cluster_name}-IpReputationList"
      sampled_requests_enabled   = true
    }
  }

  # Rule 2: OWASP Top 10 — SQLi, XSS, path traversal, common web exploits
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.cluster_name}-CommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  # Rule 3: Known bad inputs — Log4Shell (CVE-2021-44228), Spring4Shell, SSRF
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.cluster_name}-KnownBadInputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.cluster_name}-waf"
    sampled_requests_enabled   = true
  }

  tags = var.tags
}

output "waf_web_acl_arn" {
  description = "WAF Web ACL ARN — add to Ingress annotation: alb.ingress.kubernetes.io/wafv2-web-acl-arn"
  value       = aws_wafv2_web_acl.alb.arn
}
