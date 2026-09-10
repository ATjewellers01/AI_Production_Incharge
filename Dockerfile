# Single-container deploy: this ONE image serves both the frontend (Next.js
# pages) and the backend (Next.js API routes) — there is no separate Express
# server, no separate frontend service. See CLAUDE.md.

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/
RUN npm install
COPY . .
RUN npm run build

# DIAGNOSTIC (minimal-test branch): running `next start` directly instead
# of the standalone server.js output, to isolate whether the standalone
# build specifically is the cause of this service's silent, log-free 502s
# — a raw Node http server on this exact Render Docker setup works fine,
# but the standalone Next.js server.js does not, so this tests the point
# in between: plain Next.js production server, no standalone output.
FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 10000
ENV PORT=10000
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "10000"]
