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

# Render's Docker-runtime services can't have "Port" set manually in the
# dashboard (that field only exists for native/non-Docker runtimes) — it
# auto-detects the port purely from this EXPOSE + the container's actual
# listener. 10000 is Render's own documented convention/default for Docker
# web services; using it (instead of this app's local-dev default of 3100)
# avoids relying on EXPOSE auto-detection picking up a non-standard port,
# which is the most likely explanation for a "live" deploy that still 502s
# on every route with zero backend logs (the request never reaches the
# container because Render's proxy is routing to a different port than the
# one Next.js is actually listening on).
EXPOSE 10000
ENV PORT=10000
CMD ["node", "server.js"]
