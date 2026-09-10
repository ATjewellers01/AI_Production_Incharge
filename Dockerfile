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

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
# Next.js standalone output bundles only the node_modules subset it actually
# needs, plus a minimal server.js — much smaller than copying node_modules
# wholesale.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 3100
ENV PORT=3100
CMD ["node", "server.js"]
