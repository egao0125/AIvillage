# ---------------------------------------------------------------------------
# AI Village — Development & Deployment Commands
# ---------------------------------------------------------------------------

.PHONY: dev test build deploy infra-bootstrap infra-apply infra-plan help

AWS_PROFILE ?= ai-village
AWS_REGION  ?= ap-northeast-1

# ---- Development ----

dev:
	@echo "Starting dev server + client..."
	pnpm --filter @ai-village/server dev &
	pnpm --filter @ai-village/client dev

test:
	@echo "Running tests..."
	pnpm --filter @ai-village/server exec vitest run --reporter=verbose

typecheck:
	@echo "TypeScript checks..."
	pnpm --filter @ai-village/server exec tsc --noEmit
	pnpm --filter @ai-village/client exec tsc --noEmit
	pnpm --filter @ai-village/ai-engine exec tsc --noEmit

# ---- Production Infrastructure ----

infra-bootstrap:
	@echo "==> Creating S3 backend + DynamoDB lock table..."
	cd terraform/bootstrap && terraform init && terraform apply -auto-approve
	@echo "==> Migrating state to S3..."
	cd terraform && terraform init -reconfigure

infra-plan:
	cd terraform && terraform plan -var-file=terraform.tfvars

infra-apply:
	@echo "==> Applying infrastructure (this takes ~15 min first time)..."
	cd terraform && terraform apply -var-file=terraform.tfvars
	@echo ""
	@echo "==> Post-apply checklist:"
	cd terraform && terraform output next_steps

infra-kubeconfig:
	aws eks update-kubeconfig \
		--region $(AWS_REGION) \
		--name ai-village \
		--profile $(AWS_PROFILE)

# ---- Secrets Setup ----

setup-secrets:
	@chmod +x scripts/setup-secrets.sh
	AWS_PROFILE=$(AWS_PROFILE) AWS_REGION=$(AWS_REGION) ./scripts/setup-secrets.sh

# ---- Kubernetes Deploy ----

k8s-deploy:
	@echo "Deploying k8s manifests..."
	kubectl apply -f k8s/
	kubectl rollout status deployment/ai-village -n ai-village --timeout=300s

k8s-migrate:
	kubectl delete job db-migrate -n ai-village --ignore-not-found
	kubectl apply -f k8s/08-db-migrate-job.yaml
	kubectl wait job/db-migrate -n ai-village --for=condition=complete --timeout=300s

k8s-logs:
	kubectl logs -n ai-village -l app=ai-village -f

k8s-status:
	@echo "=== Pods ==="
	kubectl get pods -n ai-village
	@echo ""
	@echo "=== Ingress ==="
	kubectl get ingress -n ai-village
	@echo ""
	@echo "=== HPA ==="
	kubectl get hpa -n ai-village

# ---- ECR Image Push ----

IMAGE_TAG ?= $(shell git rev-parse --short HEAD)
ECR_REPO  := 053442321898.dkr.ecr.$(AWS_REGION).amazonaws.com/ai-village

ecr-login:
	aws ecr get-login-password --region $(AWS_REGION) --profile $(AWS_PROFILE) | \
		docker login --username AWS --password-stdin $(ECR_REPO)

docker-build:
	DOCKER_BUILDKIT=1 docker build -t $(ECR_REPO):$(IMAGE_TAG) .

docker-push: ecr-login docker-build
	docker push $(ECR_REPO):$(IMAGE_TAG)
	@echo "Pushed: $(ECR_REPO):$(IMAGE_TAG)"

# ---- Full Production Deploy (manual) ----

deploy: docker-push k8s-migrate
	kubectl set image deployment/ai-village ai-village=$(ECR_REPO):$(IMAGE_TAG) -n ai-village
	kubectl rollout status deployment/ai-village -n ai-village --timeout=300s
	@echo "Deployed: $(IMAGE_TAG)"

# ---- Play Check ----

playcheck:
	cd packages/server && node playcheck.mjs

# ---- Help ----

help:
	@echo "AI Village — Available Commands"
	@echo ""
	@echo "  Development:"
	@echo "    make dev              Start dev server + client"
	@echo "    make test             Run unit tests"
	@echo "    make typecheck        TypeScript check all packages"
	@echo "    make playcheck        End-to-end play check against local server"
	@echo ""
	@echo "  First-time production setup:"
	@echo "    make infra-bootstrap  Create S3 state backend (run once)"
	@echo "    make infra-apply      Provision all AWS infrastructure"
	@echo "    make infra-kubeconfig Configure kubectl for EKS"
	@echo "    make setup-secrets    Populate Secrets Manager values"
	@echo "    make k8s-deploy       Apply k8s manifests"
	@echo ""
	@echo "  Ongoing deployment:"
	@echo "    make deploy           Build + push image + rollout (manual)"
	@echo "    git push origin main  Triggers GitHub Actions CI/CD (automated)"
	@echo ""
	@echo "  Operations:"
	@echo "    make k8s-status       Show pods / ingress / HPA status"
	@echo "    make k8s-logs         Tail application logs"
