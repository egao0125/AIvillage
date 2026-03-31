# ---------------------------------------------------------------------------
# Amazon GuardDuty — continuous threat detection for AWS account, EKS, and S3.
#
# Detects:
#   - Compromised EC2/EKS workloads (C2 callbacks, crypto mining, lateral movement)
#   - Unusual API calls (credential theft, privilege escalation)
#   - EKS audit log anomalies (pod exec, privileged container creation)
#   - S3 exfiltration (public bucket access, unusual GET patterns)
#
# GuardDuty findings are surfaced in SecurityHub (see securityhub.tf).
#
# References:
#   CIS AWS Foundations Benchmark 3.x / NIST SP 800-53 SI-4 (System Monitoring)
#   AWS Well-Architected Security Pillar SEC 4 (Detection)
# ---------------------------------------------------------------------------

resource "aws_guardduty_detector" "this" {
  enable = true

  datasources {
    # S3 data events — detect exfiltration and unusual access patterns
    s3_logs {
      enable = true
    }

    # EKS audit logs — detect suspicious API calls inside the cluster
    kubernetes {
      audit_logs {
        enable = true
      }
    }

    # EKS runtime monitoring — detect process/file anomalies inside pods
    # Requires EKS add-on: aws-guardduty-agent (auto-managed when enabled)
    malware_protection {
      scan_ec2_instance_with_findings {
        ebs_volumes {
          enable = true
        }
      }
    }
  }

  tags = var.tags
}

# ---------------------------------------------------------------------------
# Amazon SecurityHub — aggregates GuardDuty findings + CIS Benchmark checks.
#
# Standards enabled:
#   - AWS Foundational Security Best Practices (FSBP) v1.0.0
#   - CIS AWS Foundations Benchmark v1.4.0
#
# References:
#   NIST SP 800-53 CA-7 (Continuous Monitoring) / AU-6 (Audit Review)
# ---------------------------------------------------------------------------

resource "aws_securityhub_account" "this" {
  # auto_enable_controls: automatically enable new controls as AWS adds them
  auto_enable_controls = true

  depends_on = [aws_guardduty_detector.this]
}

# AWS Foundational Security Best Practices — covers EC2, EKS, RDS, IAM, S3, KMS, etc.
resource "aws_securityhub_standards_subscription" "fsbp" {
  standards_arn = "arn:aws:securityhub:${var.aws_region}::standards/aws-foundational-security-best-practices/v/1.0.0"

  depends_on = [aws_securityhub_account.this]
}

# CIS AWS Foundations Benchmark v1.4.0
resource "aws_securityhub_standards_subscription" "cis" {
  standards_arn = "arn:aws:securityhub:${var.aws_region}::standards/cis-aws-foundations-benchmark/v/1.4.0"

  depends_on = [aws_securityhub_account.this]
}

# GuardDuty → SecurityHub integration: funnel GuardDuty findings into SecurityHub
# so operators have a single pane of glass for all security findings.
resource "aws_securityhub_finding_aggregator" "this" {
  linking_mode = "NO_LINKING"  # single-region deployment

  depends_on = [aws_securityhub_account.this]
}
