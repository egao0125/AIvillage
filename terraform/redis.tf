# ---------------------------------------------------------------------------
# ElastiCache Redis — used by Socket.IO Redis Adapter (multi-pod event bus)
# and the server-side rate limiter fallback.
#
# Placement: private subnets only. The security group allows inbound 6379
# exclusively from EKS nodes; no public access.
# ---------------------------------------------------------------------------

# Security group: allow Redis traffic only from EKS nodes.
resource "aws_security_group" "redis" {
  name        = "${var.cluster_name}-redis"
  description = "Allow Redis traffic from EKS nodes only"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "Redis from EKS nodes"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Name = "${var.cluster_name}-redis" })
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.cluster_name}-redis"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_elasticache_cluster" "redis" {
  cluster_id           = "${var.cluster_name}-redis"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.redis.name
  security_group_ids = [aws_security_group.redis.id]

  # Retain 1 day of automatic snapshots (free tier).
  snapshot_retention_limit = 1
  snapshot_window          = "03:00-04:00"   # UTC — adjust to off-peak for your region

  apply_immediately = true

  tags = merge(var.tags, { Name = "${var.cluster_name}-redis" })
}
