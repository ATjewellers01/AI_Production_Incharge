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
# Runs `next start` on the full build output, NOT the standalone build.
# The standalone build (output: 'standalone' + its generated server.js) was
# diagnosed on 2026-09-10 to be unreachable on this Render Docker setup: the
# container logged a clean "Ready"/"live" boot on the correct port every
# time, but every single request — including a bare zero-dependency route —
# got a silent 502 straight from Render's own edge, with zero new backend
# log lines. A raw Node `http.createServer` on the identical Dockerfile
# pattern worked immediately, and switching this same app from the
# standalone server.js to plain `next start` also immediately worked (full
# login page + API responses), which isolated the fault specifically to the
# standalone build artifact on this environment, not Next.js generally, not
# the app's code, and not Render's routing. Don't switch back to
# `output: 'standalone'` without re-testing this exact scenario first — see
# CLAUDE.md/the git history around this commit for the full diagnostic
# trail before ever considering it again purely for image-size savings.
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules

# Render's Docker-runtime services can't have "Port" set manually in the
# dashboard (that field only exists for native/non-Docker runtimes) — it
# auto-detects the port purely from this EXPOSE + the container's actual
# listener. 10000 is Render's own documented convention/default for Docker
# web services.
EXPOSE 10000
ENV PORT=10000
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "10000"]
