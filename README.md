# AI Production Incharge

A read-only AI monitoring + Q&A layer for [Order-to-Delivery (O2D)](../at-order-to-dispatch-backend) —
gives a production incharge:

- **A live dashboard** — delayed orders, stage bottlenecks, karigar workload,
  plus a short AI-written briefing, recomputed on every load.
- **A chat assistant** — ask anything in plain language ("which urgent
  orders are late?", "how much work does Ramesh have?") and get an answer
  backed by the same live data.

This service **never writes to the database** — it only reads O2D's own
Postgres database and reports on it. See [`CLAUDE.md`](CLAUDE.md) for full
architecture/safety notes.

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, OPENAI_API_KEY — see comments in the file
npm run dev            # http://localhost:3100
```

Sign in with the same User ID/password as an O2D Admin or Super Admin
account (this service has no login of its own — see `CLAUDE.md` → Auth).

For local testing without a real login, set `SKIP_AUTH_IN_DEV=true` in
`.env` (dev-only, has no effect in production — see `CLAUDE.md`).

## Deploy

Single Docker image, single Render Web Service (no `render.yaml`) — see
`CLAUDE.md` → Deploy for the env vars Render needs.
