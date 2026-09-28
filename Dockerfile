# syntax=docker/dockerfile:1
#
# Multi-stage build for the Railway / self-hosted path.
#
# Vercel does NOT use this file — it builds Next.js natively with zero config.
# This exists so the same codebase can also run as a container via `node server.js`.

# ---------- deps ----------
FROM oven/bun:1.3.4-alpine AS deps
WORKDIR /app

COPY package.json bun.lock* ./
# Install with the frozen lockfile when one is present so builds are reproducible.
RUN if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile; else bun install; fi

# ---------- builder ----------
FROM oven/bun:1.3.4-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The standalone tracer reads these at build time. Sentry stays off unless a
# DSN is supplied, matching the committed configs.
ARG NEXT_PUBLIC_SENTRY_DSN=""
ARG NEXT_PUBLIC_SITE_URL=""
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN bun run build

# ---------- runner ----------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# `output: "standalone"` emits a self-contained server plus only the traced deps.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
