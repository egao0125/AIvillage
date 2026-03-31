# ---------------------------------------------------------------------------
# RDS PostgreSQL 16 — Multi-AZ, encrypted, managed master password
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "this" {
  name       = var.cluster_name
  subnet_ids = module.vpc.private_subnets
  tags       = var.tags
}

resource "aws_security_group" "rds" {
  name        = "${var.cluster_name}-rds"
  description = "Allow PostgreSQL from EKS nodes only"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "PostgreSQL from EKS nodes"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

  # CIS AWS Foundations Benchmark 5.4: restrict egress to VPC CIDR only.
  # RDS does not initiate outbound connections to the internet; this eliminates
  # any compliance alert from SecurityHub / GuardDuty about unrestricted egress.
  egress {
    description = "Allow outbound only within VPC"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [module.vpc.vpc_cidr_block]
  }

  tags = var.tags
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${var.cluster_name}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
    }]
  })

  managed_policy_arns = ["arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"]
  tags                = var.tags
}

# ---------------------------------------------------------------------------
# RDS Parameter Group — hardened PostgreSQL 16 settings.
#
# Enables connection/disconnection logging and statement duration logging
# for security audit trail and anomaly detection.
# (CIS PostgreSQL Benchmark / NIST SP 800-53 AU-2, AU-12, CA-7)
# ---------------------------------------------------------------------------
resource "aws_db_parameter_group" "this" {
  name        = "${var.cluster_name}-postgres16"
  family      = "postgres16"
  description = "Hardened PostgreSQL 16 parameters for AI Village"

  # Log all connections (CIS PostgreSQL 3.1)
  parameter {
    name  = "log_connections"
    value = "1"
  }

  # Log all disconnections (CIS PostgreSQL 3.2)
  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  # Log statements taking longer than 1000ms (detect slow queries / DoS patterns)
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  # Log lock waits exceeding deadlock_timeout (detect contention)
  parameter {
    name  = "log_lock_waits"
    value = "1"
  }

  # Enforce SSL — reject non-SSL client connections
  # (NIST SP 800-53 SC-8: Transmission Confidentiality and Integrity)
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  tags = var.tags
}

resource "aws_db_instance" "this" {
  identifier        = "${var.cluster_name}-postgres"
  engine            = "postgres"
  engine_version    = "16"
  instance_class    = var.rds_instance_class
  allocated_storage = var.rds_allocated_storage
  max_allocated_storage = 100

  db_name  = "aivillage"
  username = "aivillage_admin"

  # RDS auto-creates & rotates master password in Secrets Manager
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.this.name

  multi_az            = true
  storage_encrypted   = true
  kms_key_id          = aws_kms_key.rds.arn  # CMK for audit trail + rotation; see kms.tf
  deletion_protection = true

  backup_retention_period = 14  # 14 days (AWS Well-Architected REL-11 minimum for production)
  backup_window           = "03:00-04:00"
  maintenance_window      = "Mon:04:00-Mon:05:00"

  monitoring_interval = 60
  monitoring_role_arn = aws_iam_role.rds_monitoring.arn

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  performance_insights_enabled          = true
  performance_insights_retention_period = 7  # days (free tier); set to 731 for 2-year retention (paid)

  skip_final_snapshot = false
  final_snapshot_identifier = "${var.cluster_name}-postgres-final"

  tags = var.tags
}
