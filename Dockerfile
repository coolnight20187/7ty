# Dockerfile
# Multi-stage build for "Tra cứu & Bán Bill"
# - Stage 1: build TypeScript to JS (uses Node 20)
# - Stage 2: production runtime (slim Node) with only runtime deps
# - Optimized for small image and secure runtime
#
# Usage:
#  docker build -t project-tra-cuu:latest .
#  docker run -e PORT=3000 -e NEW_API_BASE_URL='https://bill.7ty.vn/api' -p 3000:3000 project-tra-cuu:latest
#
# Notes:
#  - Keep SECRET env vars out of Dockerfile and pass them at runtime or via docker-compose / secret manager.
#  - If you deploy to container platforms (Fly, Render, Railway), set NODE_ENV=production and DATABASE_URL appropriately.

# --------------------
# Stage 0: dependencies install (cache layer)
# --------------------
FROM node:20-bullseye AS deps
WORKDIR /usr/src/app

# Copy package manifests only for dependency resolution (leverages Docker cache)
COPY package.json package-lock.json* ./
# If using pnpm/yarn, adapt accordingly
RUN npm ci --production=false

# --------------------
# Stage 1: build
# --------------------
FROM node:20-bullseye AS builder
WORKDIR /usr/src/app

# Copy source and node_modules from deps stage
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .

# Build TypeScript -> dist
ENV NODE_ENV=development
RUN npm run build

# --------------------
# Stage 2: production image
# --------------------
FROM node:20-slim AS runner
LABEL maintainer="Bạn <you@example.com>"
WORKDIR /usr/src/app

# Reduce attack surface: create non-root user
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser

# Copy only necessary runtime artifacts
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/package.json ./package.json
# If your app serves static files from public, copy them too
COPY --from=builder /usr/src/app/public ./public
COPY --from=builder /usr/src/app/.env.example ./.env.example

# Install only production dependencies
ENV NODE_ENV=production
RUN npm ci --production

# Set non-root user
USER appuser

# Expose port (documentational)
EXPOSE 3000

# Healthcheck (optional)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node:http').get({ host: '127.0.0.1', port: process.env.PORT||3000, path: '/api/health' }, res=>{ if(res.statusCode===200) process.exit(0); else process.exit(1); }).on('error', ()=>process.exit(1))"

# Default command (use env PORT to override)
ENV PORT=3000
CMD ["node", "dist/server.js"]
