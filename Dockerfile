# syntax=docker/dockerfile:1
# Multi-stage build: deps -> builder -> runner

####################
# Stage: deps
####################
FROM node:20-bullseye AS deps
WORKDIR /usr/src/app

# Copy package manifests only to leverage Docker cache
COPY package.json package-lock.json* ./

# Install including dev dependencies so tsc is available for build
# If your npm is older and doesn't support --include=dev, use --production=false
RUN npm ci --include=dev

####################
# Stage: builder
####################
FROM node:20-bullseye AS builder
WORKDIR /usr/src/app

# Copy node_modules (with dev deps) and source
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=development

# Ensure local binaries are executable (fix permission issues when copying)
RUN if [ -d "./node_modules/.bin" ]; then chmod -R a+rx ./node_modules/.bin || true; fi

# Build TypeScript -> dist using local tsc
RUN npm exec --no -- tsc -p tsconfig.json

####################
# Stage: runner (production)
####################
FROM node:20-slim AS runner
LABEL maintainer="Bạn <you@example.com>"
WORKDIR /usr/src/app

# Create non-root user
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

# Copy only runtime artifacts
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/package.json ./package.json
COPY --from=builder /usr/src/app/public ./public
COPY --from=builder /usr/src/app/.env.example ./.env.example

ENV NODE_ENV=production

# Install only production dependencies
RUN npm ci --production

# Switch to non-root user
USER appuser

EXPOSE 3000
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node:http').get({ host: '127.0.0.1', port: process.env.PORT||3000, path: '/api/health' }, res=>{ if(res.statusCode===200) process.exit(0); else process.exit(1); }).on('error', ()=>process.exit(1))"

CMD ["node", "dist/server.js"]
