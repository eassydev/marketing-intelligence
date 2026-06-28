FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime: production-only deps (no tsx/drizzle-kit/vitest). The server and the
# migration runner both execute compiled JS, so only runtime deps are needed.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
EXPOSE 5100
# App entry. Migrations are run as an explicit one-off:
#   docker compose -f docker-compose.prod.yml run --rm mil node dist/scripts/migrate.js
CMD ["node", "dist/src/server.js"]
