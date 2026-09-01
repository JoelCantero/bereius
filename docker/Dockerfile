# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

# Multi-stage build for the Next.js `app` container.
# Base image is Debian-slim (works on ARM64/Raspberry Pi and amd64/VPS) and
# includes OpenSSL for Prisma. Build and runtime share the same base so the
# Prisma engine matches the runtime platform (constitution Principle IV).
FROM node:24-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Non-interactive corepack: let it fetch the pinned pnpm without prompting.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global corepack@0.35.0 \
 && corepack enable
WORKDIR /app

# --- Dependencies ---
FROM base AS deps
# pnpm-workspace.yaml carries the build-script approvals (allowBuilds) pnpm needs
# to run the Prisma/sharp postinstall scripts during install. Copied one-by-one
# (single-source COPY) to keep the layout unambiguous.
COPY package.json ./
COPY pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./
COPY patches ./patches
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# --- Build ---
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Generate Prisma client (safe even when the schema has no models yet).
RUN pnpm exec prisma generate
# Next.js evaluates server route modules while collecting build metadata. Use
# explicit non-secret placeholders here; GitHub Actions injects the real values
# only when the production container starts.
RUN PROJECT_NAME=build \
	DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
	AUTH_SECRET=build-only-secret-not-used-at-runtime-000000 \
	NEXTAUTH_URL=http://localhost:3000 \
	BRAND_COLOR=#18181B \
	SUPPORT_EMAIL=support@example.test \
	pnpm run build

# --- Migrator (applies Prisma migrations at deploy time; no app build needed) ---
FROM base AS migrator
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# Invoke the Prisma CLI binary directly so no pnpm/corepack fetch is needed at runtime.
CMD ["/app/node_modules/.bin/prisma", "migrate", "deploy"]

# --- Runtime ---
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# Next.js standalone output (requires `output: "standalone"` in next.config.ts).
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
