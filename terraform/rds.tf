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

  multi_az            = true
  storage_encrypted   = true
  deletion_protection = true

  backup_retention_period = 7
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
