# AI Production Incharge

A read-only AI monitoring + Q&A layer over **three** production systems —
[Order-to-Delivery (O2D)](../at-order-to-dispatch-backend),
[Jewel Factory](../../Jewel-Factory), and the ERP module (mounted on O2D's
own backend) — switchable from one source toggle at the top of the same
dashboard/chat UI. For whichever source is selected, it gives a production
incharge / manufacturer:

- **A live dashboard** — for O2D/Jewel Factory: delayed orders, stage
  bottlenecks, karigar workload, plus a short AI-written briefing,
  recomputed on every load. For ERP (which tracks metal/production flow,
  not customer orders): metal stock levels, department/karigar recovery %,
  alloy conversion loss, and a job pipeline.
- **A chat assistant** — ask anything in plain language (Hindi, English,
  or Hinglish — it replies in whatever language you used) and get an
  answer backed by the same live data, streamed back as it's generated.

This service **never writes to any database** — it only reads. See
[`CLAUDE.md`](CLAUDE.md) for full architecture/safety notes, including the
important distinction between Jewel Factory (a genuinely separate
database/connection) and ERP (same database as O2D, just different
tables).

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, DATABASE_URL_JEWEL_FACTORY,
                        # JWT_SECRET, OPENAI_API_KEY — see comments in the file
npm run dev             # http://localhost:3100
```

Sign in with the same User ID/password as an O2D Admin or Super Admin
account (this service has no login of its own — see `CLAUDE.md` → Auth).

For testing without a real login, set `SKIP_AUTH_IN_DEV=true` +
`NEXT_PUBLIC_SKIP_AUTH_IN_DEV=true`. Unlike a typical dev-only bypass,
this one is **not** gated on `NODE_ENV` — it works on a deployed Render
instance too, which is a deliberate (if risky) choice for early testing.
**If `DATABASE_URL` points at real production data, leaving this on means
anyone who reaches the URL sees that data with no login at all** — see
`CLAUDE.md` → Auth for the current status.

## Deploy

Single Docker image, single Render Web Service (no `render.yaml`) — see
`CLAUDE.md` → Deploy for the env vars Render needs. Runs `next start` on
the full build output, not `output: 'standalone'` — see the Dockerfile's
own comment for why.
