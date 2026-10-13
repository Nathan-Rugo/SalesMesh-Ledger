# SalesMesh PWA: standalone Next.js image (multi-stage).
# GATEWAY_URL is resolved at BUILD time: the /api/v1/* rewrite is compiled into the routes manifest.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
ARG GATEWAY_URL=http://gateway:4000
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ARG BUILD_ID
ENV GATEWAY_URL=$GATEWAY_URL NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL BUILD_ID=$BUILD_ID NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/offline >/dev/null || exit 1
CMD ["node", "server.js"]
