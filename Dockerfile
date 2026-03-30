# ─── Stage 1: build ──────────────────────────────────────────────────────────
# Full install (devDeps included) + compile TypeScript + Vite client bundle.
# Nothing from this stage reaches production except compiled artifacts.
FROM node:22-slim AS builder

# Use corepack (ships with Node 16+) to avoid an extra npm install -g
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

# Copy manifests first — Docker layer caches the install until a manifest changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json    packages/shared/
COPY packages/ai-engine/package.json packages/ai-engine/
COPY packages/server/package.json    packages/server/
COPY packages/client/package.json    packages/client/

# Install everything (devDeps needed: tsc, vite, eslint)
RUN pnpm install --frozen-lockfile

# Copy source and compile
COPY packages/ packages/
RUN pnpm --filter @ai-village/shared build && \
    pnpm --filter @ai-village/ai-engine build && \
    pnpm --filter @ai-village/server build && \
    pnpm --filter @ai-village/client exec vite build

# ─── Stage 2: production runtime ─────────────────────────────────────────────
# Lean image: only production deps, compiled JS, no source, no build tools.
FROM node:22-slim AS runner

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Create non-root user before installing anything
RUN corepack enable && corepack prepare pnpm@9 --activate && \
    groupadd --gid 1001 appgroup && \
    useradd --uid 1001 --gid appgroup --shell /bin/sh --create-home appuser

WORKDIR /app

# Workspace manifests needed for pnpm to resolve workspace:* links
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/shared/package.json    packages/shared/
COPY --from=builder /app/packages/ai-engine/package.json packages/ai-engine/
COPY --from=builder /app/packages/server/package.json    packages/server/
COPY --from=builder /app/packages/client/package.json    packages/client/

# Install production dependencies only — excludes tsx, tsc, vite, eslint
RUN pnpm install --frozen-lockfile --prod

# Download AWS global TLS CA bundle (RDS + ElastiCache).
# Amazon intermediate CAs are not all present in Node.js's bundled Mozilla store,
# so we fetch the authoritative bundle from AWS Trust Services and register it via
# NODE_EXTRA_CA_CERTS — the standard Node.js mechanism for adding trusted CAs.
# Source: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
# (Same bundle covers RDS and ElastiCache — both use Amazon Trust Services CAs)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -sSfL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
       -o /app/aws-ca-bundle.pem \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/app/aws-ca-bundle.pem

# Copy compiled dist artifacts from builder.
# Must happen after pnpm install so workspace symlinks already point to these dirs.
COPY --from=builder /app/packages/shared/dist    packages/shared/dist
COPY --from=builder /app/packages/ai-engine/dist packages/ai-engine/dist
COPY --from=builder /app/packages/server/dist    packages/server/dist
COPY --from=builder /app/packages/client/dist    packages/client/dist

# Hand all app files to the non-root user
RUN chown -R appuser:appgroup /app

USER appuser

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Health check uses Node 18+ built-in fetch — no curl/wget required in slim image.
# --start-period gives the simulation engine time to initialize before first check.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

WORKDIR /app/packages/server

# Run compiled JS with plain node — no TypeScript transpilation overhead in prod
CMD ["node", "dist/index.js"]
