FROM node:22-slim

# Install pnpm
RUN npm install -g pnpm@9

WORKDIR /app

# Copy package files first for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/ai-engine/package.json packages/ai-engine/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

# Install all dependencies (need devDeps for building client)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/ packages/

# Build client (Vite produces static files in packages/client/dist)
RUN cd packages/client && pnpm exec vite build

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

WORKDIR /app/packages/server

CMD ["npx", "tsx", "src/index.ts"]
