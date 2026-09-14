# CLAUDE.md — AI Production Incharge

Guidance for Claude Code / any agent working in this repo.

## What this is

A **read-only AI monitoring/Q&A layer**, originally built on top of
Order-to-Delivery (O2D) — the separate, already-in-production system at
`C:\Users\ACER\Desktop\Order to delivery\at-order-to-dispatch-backend` +
`at-order-to-dispatch-frontend` — extended 2026-09-13 with Jewel Factory's
own production database (`C:\Users\ACER\Desktop\Jewel-Factory`), and
2026-09-14 with the ERP module (`C:\Users\ACER\Desktop\erp-new-frontend`'s
backend, which is mounted on the SAME at-order-to-dispatch-backend as O2D
— see "Three data sources" below for the important distinction between
"separate database" and "separate tables, same database"). One dashboard,
one login, ONE UI — a small source toggle at the top ("Order to Delivery"
/ "Jewel Factory" / "ERP") switches which data the identical-looking
dashboard/chat is reading, never more than one at once.

For whichever source is active, this gives a production incharge /
manufacturer two things:

1. **A fixed dashboard** — three always-shown insights (delayed orders,
   stage bottlenecks, karigar workload) plus a short AI-written narrative
   summarizing them, computed fresh on every page load (no caching, no
   scheduled job).
2. **A free-text chat** — the same underlying data, queryable in natural
   language ("which urgent orders are late?", "how much work does Ramesh
   have?"), via OpenAI function-calling over a FIXED set of tool functions,
   scoped to whichever source is currently selected.

**This service NEVER writes to either database.** No order is ever
changed, no karigar ever reassigned, no stage ever advanced from here. It
only observes and reports — see "Core rule: read-only, no exceptions"
below, which applies identically to both data sources.

## Why one repo, one deploy (not backend+frontend split)

Deployed as **one Render Web Service**, one Docker container, one process —
explicit product decision. So there is **no separate Express backend** —
everything (Prisma queries, OpenAI calls, the dashboard/chat UI) lives in
ONE Next.js app (App Router), with backend logic in `app/api/*/route.ts`
API routes rather than a separate server. Don't reintroduce a second
server/process "for cleanliness" — it would break the single-service
deploy model this was explicitly built for.

## Stack

Next.js 15 (App Router) + Prisma (same Postgres database O2D itself uses —
see "Database" below) + Tailwind v4 (CSS-first) + `openai` SDK (`gpt-4o` by
default) + `jsonwebtoken` (verifies O2D's own tokens, issues none of its
own). No separate ORM/API framework, no state-management library — this is
a small, single-page app (one dashboard+chat page, one login page).

## Three data sources — O2D, Jewel Factory, and ERP, never mixed

- **O2D** (`source: 'o2d'`, the default/original): `prisma/schema.prisma` +
  `lib/prisma.ts` (`prisma` client) + `lib/tools.ts` + O2D's own login.
- **Jewel Factory** (`source: 'jf'`, added 2026-09-13): a SEPARATE Prisma
  schema (`prisma/jewel-factory/schema.prisma`, generated into its own
  output path `node_modules/.prisma/client-jf` so it never collides with
  the O2D client) + `lib/prisma-jf.ts` (`prismaJf` client, its own
  `DATABASE_URL_JEWEL_FACTORY` connection) + `lib/tools-jf.ts`.
- **ERP** (`source: 'erp'`, added 2026-09-14): **NOT a separate database**
  — ERP (whose frontend lives at `C:\Users\ACER\Desktop\erp-new-frontend`)
  is mounted on the SAME `at-order-to-dispatch-backend` as O2D, at its own
  `/api/erp/v1` route prefix, sharing the same Postgres database, same
  `User`/JWT login. So ERP's models (`ProductionPlan`,
  `ProductionPlanningEntry`, `DepartmentIssueEntry`,
  `DepartmentReceiptEntry`, `KarigarIssueEntry`, `KarigarReceiptEntry`)
  were added directly into the EXISTING `prisma/schema.prisma`/`lib/
  prisma.ts` (`prisma` client) — NOT a new schema file or Prisma client
  like Jewel Factory got, since there is no second connection to make.
  `lib/tools-erp.ts` uses that same `prisma` client, just against these
  different tables.

All three of `lib/tools.ts`, `lib/tools-jf.ts`, and `lib/tools-erp.ts`
export the same five function names (`getSummary`, `getDelayedOrders`,
`getStageBottlenecks`, `getKarigarLoad`, `getOrderByNumber`,
`searchOrders`) with source-specific suffixed exports on the JF/ERP sides
(`getSummaryJf`/`getSummaryErp`, etc.) — `lib/openai.ts`'s
`getToolSchemas(source)`/`getSystemPrompt(source)`/`runTool(name, args,
user, source)` dispatch to the right file based on `source`, and
`app/api/insights/route.ts` (`?source=` query param) /
`app/api/chat/route.ts` (`source` in the request body) thread it through
from the frontend's tab selection. **Never let a chat request reach
another source's tools/database** — this is the whole reason `source` is
threaded explicitly through every layer instead of inferred.

**ERP tracks metal/production flow, not customer orders** — there's no
single "order" row per unit of work the way O2D has. `lib/tools-erp.ts`
re-interprets the three fixed insights around `KarigarIssueEntry`
(metal issued to a karigar) vs `KarigarReceiptEntry` (metal returned): an
issue with no receipt yet is "outstanding" (ERP's analogue of an active
order); "delayed"/"urgent" are AGE-BASED PROXIES (outstanding >7/>14 days)
since ERP has no real due-date or urgent flag on an issue — both
`lib/openai.ts`'s ERP system prompt and the ERP dashboard's narrative
prompt explicitly say so, to avoid the model implying a real deadline was
missed when none exists in the data.

**Jewel Factory has three order tables** (`B2bOrder` = "Catalogue order",
`KioskOrder` = "Store Customer order", `CustomDesignOrder` = "Customised
order") where O2D has one `Order` table — `lib/tools-jf.ts`'s
`fetchActiveUnifiedOrders()` merges all three into one shape before
computing insights, mirroring how Jewel Factory's own manufacturer portal
merges them for display. **Customer PII is structurally excluded** —
`KioskOrder.customerName/Phone/Email`/`deliveryAddress` aren't even
declared in `prisma/jewel-factory/schema.prisma`, so no query here could
select them by accident, matching Jewel Factory's own "manufacturer never
sees customer PII" rule.

**O2D linkage**: a `CustomDesignOrder` with `o2dOrderId` set has already
been forwarded to O2D (Jewel Factory's own O2D integration — see Jewel
Factory's own CLAUDE.md) — its real production tracking now lives in O2D's
`Order` table, i.e. the O2D tab of THIS SAME dashboard. Every Jewel Factory
active/delayed query excludes `o2dOrderId: null`-mismatched rows (only
counts ones still `null`) specifically to avoid double-counting the same
underlying piece of work against both tabs.

**Adding a FOURTH source later**: first figure out which pattern applies —
if it's a genuinely separate database, follow the Jewel Factory pattern (a
new `prisma/<name>/schema.prisma` with its own `output`, a new `lib/prisma-
<name>.ts`, its own `DATABASE_URL_<NAME>`); if it shares an existing
database (like ERP shares O2D's), just add its models to that database's
existing schema.prisma and use the existing Prisma client. Either way, add
a new `lib/tools-<name>.ts`, extend `Source` in `lib/openai.ts` (tool
schemas + system prompt + `runTool` dispatch) and the `SOURCES` array in
`app/page.tsx` (+ its own `normalize*` cases if its field names differ from
the others, see the top of that file). Don't try to make one generic
"tools" file that branches internally on source — the whole point of the
per-source-file split is that each source's actual schema/field-names
genuinely differ, and mixing them inline invites exactly the kind of
data-shape confusion this split is meant to prevent.

## Database — same DB as O2D, minimal schema subset, READ ONLY

`prisma/schema.prisma` here is a deliberately **minimal subset** of
`at-order-to-dispatch-backend/prisma/schema.prisma` — only the models this
service actually queries (`Order`, `Karigar`, `Company`, `Branch`,
`OrderStage`, `Category`, `Melting`, `User`). The real database also has the
merged ERP module (`Product`, `ProductionPlan`, `KarigarIssueEntry`, etc.) —
this service has **no models for those and no reason to ever add them**
unless a future insight genuinely needs ERP data.

**Any field/model added here MUST be copied verbatim (types, `@map`,
`@unique`, etc.) from O2D's own schema.prisma — this is the same physical
table, not a new one.** Never run a migration from this repo. Never run
`prisma db push` or `prisma migrate dev` against the shared database — this
repo has no `prisma/migrations` folder and should never grow one. If a
schema change is ever needed, it happens in `at-order-to-dispatch-backend`
first, and this repo's `schema.prisma` is updated to match afterward.

**Local testing**: point `DATABASE_URL` at a local restore of O2D's backup
(`o2d_local` in pgAdmin, restored from `updatebackupnewone.backup`) — see
`.env.example`.

**Render deploy (current plan)**: a SEPARATE small cloud Postgres instance
(Render's own, or Neon/Supabase free tier) with the SAME backup restored
into it — NOT O2D's real production RDS database, at least for now. If this
ever changes to point at production, the read-only guarantee below is what
makes that safe, but confirm with the owner before ever pointing this at
production data.

## Core rule: read-only, no exceptions

**There must never be a `.create(`, `.update(`, `.delete(`, `.upsert(`, or
raw `INSERT`/`UPDATE`/`DELETE` SQL call anywhere in this repo.** Every
function in `lib/tools.ts` does only a Prisma `find*`/`count`/`groupBy`
read. This is enforced by convention, not a DB-level read-only role (yet) —
if the database user this service connects with is ever narrowed to
read-only at the Postgres level, that's a welcome extra guarantee, not a
replacement for keeping the code itself write-free.

This matters especially for the chat feature: the LLM is given a FIXED list
of tool schemas (`lib/openai.ts`'s `TOOL_SCHEMAS`) mapped 1:1 to
`lib/tools.ts` functions. The model **never writes its own SQL/Prisma
query** — it can only call what's in that list, and every one of those is a
read. Do not add a "natural-language-to-SQL" style tool that lets the model
construct arbitrary queries — that was explicitly considered and rejected
in favor of this fixed-tools approach specifically because of the
injection/destructive-query risk against a live production database.

## Auth — reuses O2D's own login, no separate account system

This service has **no signup, no user table it writes to, no password
storage of its own**. `lib/auth.ts`'s `requireUser()` verifies a JWT using
the exact same `JWT_SECRET` as `at-order-to-dispatch-backend`
(`src/lib/jwt.ts` there) and the same minimal `{id, userId, role}` payload
shape — so a token issued by O2D's own `/api/auth/login` works here
unchanged. The login page (`app/login/page.tsx`) calls O2D's own login API
directly from the browser (`NEXT_PUBLIC_O2D_API_URL`), then stores the
returned token in `localStorage`.

**Gated to ADMIN/SUPER_ADMIN only** (`lib/auth.ts`) — same role check O2D's
own admin-only pages use. A plain USER account cannot use this service.

**Testing-only bypass**: `SKIP_AUTH_IN_DEV=true` (+ matching
`NEXT_PUBLIC_SKIP_AUTH_IN_DEV=true` for the frontend redirect check) skips
auth entirely and fakes a SUPER_ADMIN — deliberately NOT gated on
`NODE_ENV`, so it also works on Render for early testing before real login
is wired up. ⚠️ While set, ANYONE who reaches the deployed URL sees every
order/karigar with no login at all — set back to `false` (or unset both)
once real login is in use for anything beyond throwaway testing.

**No SSO/seamless-login from O2D yet** — clicking through from O2D straight
into this service without re-entering credentials would require a small
change to O2D's own frontend (a nav link that passes the current token in
the URL). That was explicitly deferred — this repo only, no O2D-side
changes, until asked for separately.

## `lib/tools.ts` — the fixed tool functions (single source of truth)

Both the dashboard (`app/api/insights/route.ts`, always calls all of them)
and the chat (`app/api/chat/route.ts`, lets the LLM choose which to call)
go through this ONE file. Never duplicate a query inline in a route — add
or extend a function here so both surfaces stay consistent.

- `getSummary` — top-line counts (active/delayed/urgent/completed-today).
- `getDelayedOrders` — active orders past `dueDate` (fallback
  `expectedDeliveryDate`) that haven't reached Delivery/Completed.
- `getStageBottlenecks` — per-`currentStage` counts + oldest order in each.
- `getKarigarLoad` — per-karigar active + delayed order counts, optional
  name filter.
- `getOrderByNumber` — exact `orderNo` lookup.
- `searchOrders` — the flexible "catch-all" tool for chat questions that
  don't fit the other five (multi-filter: karigar/company name, order/job
  type, stage, status, created-date range). Capped at 50 rows.

**IMPORTANT — verify `currentStage`'s actual stored values against the real
database before trusting any stage-name literal in this file.** The
functions above filter with `notIn: ['DELIVERY', 'COMPLETED']` as a
placeholder assumption; O2D's `OrderStage` master-data table (seen via
pgAdmin) actually stores Title Case names like "Pending", "In Process",
"Ready for Delivery", "Complete", "Reject" — the literals in `getDelayedOrders`/
`getStageBottlenecks` almost certainly need to change to match whatever
`SELECT DISTINCT "currentStage" FROM "Order"` actually returns. Do not trust
the uppercase placeholders without checking real data first.

## Branch scoping

`branchScope()` in `lib/tools.ts`: a `SUPER_ADMIN` sees every branch; an
`ADMIN` only sees their own (`user.branchId`) — mirrors O2D's own
`branchWhere` pattern (`src/lib/branchScope.ts` there). A plain `USER`
account can't reach this service at all (see Auth above), so there's no
`USER`-level scoping to worry about here.

## What this explicitly does NOT do (by design, not yet-missing)

- No order/stage/karigar mutation, ever, from anywhere in this service.
- No email/SMS/push notifications — insights are pull-based (dashboard
  load, chat question), not pushed proactively. Could be a future addition,
  not in scope now.
- No access to the merged ERP module's data (gold stock, production
  planning, department issues/receipts) — out of scope, not modeled in
  `prisma/schema.prisma` here.
- No write-back to O2D's `ProcessHistory` or any audit trail — this
  service's own activity (which tool calls ran, for whom) isn't logged
  anywhere persistent yet; only server console logs.

## Deploy

Docker, one image, one Render Web Service — **no `render.yaml` blueprint**
(explicit choice; configure the service directly in the Render dashboard:
build command is the Dockerfile itself, so just point Render at this repo
with "Docker" as the runtime). Runs `next start` on the FULL build output,
deliberately NOT `output: 'standalone'` — see the Dockerfile's own comment
for the full 2026-09-10 diagnostic trail on why the standalone build is
unreachable on this Render setup specifically. Port is hardcoded to 10000
in the Dockerfile (`EXPOSE`/`ENV PORT`) — don't set a `PORT` env var in the
Render dashboard, it would override that and can reintroduce the same
routing failure.

Env vars needed on Render (see `.env.example` for the full list/comments):
`DATABASE_URL`, `DATABASE_URL_JEWEL_FACTORY`, `JWT_SECRET` (must match
O2D's own), `OPENAI_API_KEY`, `NEXT_PUBLIC_O2D_API_URL`.
`NEXT_PUBLIC_SKIP_AUTH_IN_DEV`/`SKIP_AUTH_IN_DEV` must be declared as
Docker `ARG`s in the Dockerfile's builder stage (any `NEXT_PUBLIC_*` var
needs this — Next.js inlines them at BUILD time, and Render's dashboard
env vars only reach the build step for vars explicitly declared as `ARG`)
before `npm run build` runs, or they'll silently bake in as `undefined`
regardless of what the dashboard shows.

## Commands

```bash
npm install
npm run dev        # http://localhost:3100 (or $PORT)
npm run build      # prisma generate (O2D) + prisma generate (Jewel Factory) + next build
npm run typecheck
```

Regenerating just the Jewel Factory client after editing its schema:
```bash
npx prisma generate --schema=./prisma/jewel-factory/schema.prisma
```
