# IPTV Hub — xstream-player DaveAI build
#
# Upstream: https://github.com/jandersonss/xstream-player
# Base source: v1.5.1 plus DaveAI provider-vault, English UI, and larger HLS buffers.

FROM node:20-alpine AS deps
WORKDIR /app
ENV NODE_ENV=development
COPY source/package.json source/package-lock.json ./
RUN npm ci --include=dev

FROM node:20-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY source/ ./
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV IPTV_PRIVATE_DIR=/app/private

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

RUN mkdir -p /app/data /app/private && chown -R nextjs:nodejs /app/data /app/private

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
