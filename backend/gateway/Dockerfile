# Multi-stage production build for SalesMesh-Ledger Ingestion Gateway
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Production runtime stage
FROM node:20-alpine AS runner

WORKDIR /usr/src/app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /usr/src/app/dist ./dist

# Non-root user execution for container security
USER node

EXPOSE 4000

# Liveness/readiness via /health (no curl/wget in the alpine runtime: use node's http module).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3   CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
