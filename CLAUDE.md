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

1. **A fixed dashboard** — always-shown insights, computed fresh on every
   page load (no caching, no scheduled job). O2D and Jewel Factory share
   one shape (delayed orders / stage bottlenecks / karigar workload — see
   `StandardDashboard` in `app/page.tsx`); ERP gets its own entirely
   different shape (metal stock levels, department/karigar recovery %,
   alloy conversion loss, job pipeline — see `ErpDashboard` in the same
   file and "ERP's dashboard" below), since ERP's data doesn't fit the
   "orders" pattern at all.
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

`lib/tools.ts` (O2D) and `lib/tools-jf.ts` (Jewel Factory) export the same
five function names (`getSummary`, `getDelayedOrders`,
`getStageBottlenecks`, `getKarigarLoad`, `getOrderByNumber`,
`searchOrders`, suffixed `*Jf` on the Jewel Factory side). `lib/tools-erp.ts`
exports a DIFFERENT set of eight functions (see "ERP's dashboard" below) —
`lib/openai.ts`'s `getToolSchemas(source)`/`getSystemPrompt(source)`/
`runTool(name, args, user, source)` dispatch to the right file/function set
based on `source`, and `app/api/insights/route.ts` (`?source=` query param,
with ERP routed through its own `handleErpInsights()`) /
`app/api/chat/route.ts` (`source` in the request body) thread it through
from the frontend's tab selection. **Never let a chat request reach
another source's tools/database** — this is the whole reason `source` is
threaded explicitly through every layer instead of inferred.

**ERP's dashboard (added 2026-09-14, redesigned same day)** — ERP tracks
metal/production flow, not customer orders, so it does NOT reuse the O2D/JF
"delayed orders / stage bottlenecks / karigar load" shape at all; it
mirrors erp-new-frontend's OWN real dashboard instead
(`src/app/pages/Dashboard.tsx` + its widgets, and the backend endpoints in
`at-order-to-dispatch-backend/src/erp/{dashboard,stockSummary,
productionPlanning}.routes.ts`). `lib/tools-erp.ts` exports:
- `getMetalStockSummaryErp` — 24K/22K/20K/18K stock + scrap balance +
  conversion loss, mirroring `stockSummary.routes.ts`'s
  `calculateKaratStock` (including its CompleteReturn-only scrap-credit
  gating — a *partial* department return's scrap is still "with the
  karigar," not yet credited to stock).
- `getDepartmentEfficiencyErp` / `getKarigarRankingsErp` — recovery %
  (returned weight ÷ issued weight × 100) per department / per karigar,
  same raw-SQL join as the real `/dashboard/department-efficiency` and
  `/dashboard/karigar-rankings` endpoints. **Department is only ever
  recorded on the RECEIPT row, never the issue** (chosen at return time) —
  don't "fix" a query to read `dept` off `DepartmentIssueEntry` expecting
  it to be populated; it's `null` there by design.
- `getDepartmentSummaryErp`, `getAlloySummaryErp`, `getJobPipelineErp`,
  `getRecentActivityErp`, `getOrdersSummaryErp`, `deriveUrgentAlertsErp` —
  same calculations as their respective real endpoints/UI thresholds.

Every calculation is ported as closely as possible to the real backend's
own logic (same field names, same gating rules) rather than simplified —
a subtly wrong stock/recovery number is worse than not showing one. If the
"Department recovery %" panel or "Recent activity" feed look empty/thin on
a real deploy, that's very likely **correct** (this business may simply not
have much completed department-issue/receipt activity recorded yet) — verify
against real row counts (`departmentIssueEntry.count()`,
how many have `actual2` set, how many receipts are `CompleteReturn`) before
assuming it's a bug. This was confirmed via a temporary `/api/debug-erp`
route (added, used, then deleted) on 2026-09-14: only 4 issue rows existed
in production at the time, none completed, one partial receipt — the empty
panels were accurate, not broken.

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

## Database — same DB as O2D (now including ERP models), minimal schema subset, READ ONLY

`prisma/schema.prisma` here is a deliberately **minimal subset** of
`at-order-to-dispatch-backend/prisma/schema.prisma` — only the models this
service actually queries: the O2D core (`Order`, `Karigar`, `Company`,
`Branch`, `OrderStage`, `Category`, `Melting`, `User`) plus, since
2026-09-14, a subset of the ERP module (`ProductionPlan`,
`ProductionPlanningEntry`, `DepartmentIssueEntry`, `DepartmentReceiptEntry`,
`KarigarIssueEntry`, `KarigarReceiptEntry`, `MetalStockEntry`,
`AlloyConversionEntry`) — see "ERP's dashboard" above. Any OTHER table in
the real database (the rest of the ERP module not listed above, anything
else) still has no model here and no reason to get one unless a future
insight genuinely needs it.

**Any field/model added here MUST be copied verbatim (types, `@map`,
`@unique`, etc.) from O2D's own schema.prisma — this is the same physical
table, not a new one.** Never run a migration from this repo. Never run
`prisma db push` or `prisma migrate dev` against the shared database — this
repo has no `prisma/migrations` folder and should never grow one. If a
schema change is ever needed, it happens in `at-order-to-dispatch-backend`
first, and this repo's `schema.prisma` is updated to match afterward.

**Local testing**: point `DATABASE_URL` at a local restore of O2D's backup
(`o2d_local` in pgAdmin, restored from `updatebackupnewone.backup`) — see
`.env.example`. Note: this repo's own local `.env` has never actually had
real credentials filled in during development — all real testing so far
has happened by setting the Render dashboard's env vars directly and
testing the deployed URL, not by running `npm run dev` locally against a
live database.

**Render deploy — now points at REAL PRODUCTION DATA, not a test copy**
(changed 2026-09-14). `DATABASE_URL` was switched from an earlier Neon
test-DB copy to O2D's actual production RDS instance
(`database-1.c98u4y6sk2lz.ap-south-1.rds.amazonaws.com`, database `o2d`) —
this was a deliberate choice specifically so the ERP tab would have real
data to show (ERP's tables were never restored into the Neon test copy).
**This means every tab (O2D, ERP) now reads real live business data.**
The read-only guarantee above (no `.create(`/`.update(`/`.delete(`/
`.upsert(` anywhere in this repo) is what makes this safe — but it also
means `SKIP_AUTH_IN_DEV` being left on is now a real exposure (see Auth
below), not just a test-data inconvenience. **This RDS instance requires a
PLAIN (non-SSL) connection** — the opposite of Neon/Jewel Factory's RDS,
which both require SSL — `lib/prisma.ts`'s `isLocal` SSL heuristic doesn't
account for this yet; it currently still sends `ssl: {rejectUnauthorized:
false}` for any non-localhost URL, which happened to still connect
successfully in testing, but if this ever fails with a TLS/SSL error again,
check whether this specific host needs `ssl: false` regardless of being
remote. **Also note**: this RDS instance's `pg_hba.conf`/security group
only allows connections from specific whitelisted IPs (confirmed 2026-09-14
— a direct connection attempt from an unlisted local machine was flatly
rejected with "no pg_hba.conf entry for host ..."), so don't assume you can
debug this database directly from an arbitrary machine; you may need to go
through the deployed Render app itself (e.g. a temporary diagnostic route,
added and removed as needed) to inspect real data.

## Core rule: read-only, no exceptions

**There must never be a `.create(`, `.update(`, `.delete(`, `.upsert(`, or
raw `INSERT`/`UPDATE`/`DELETE` SQL call anywhere in this repo.** Every
function in `lib/tools.ts` does only a Prisma `find*`/`count`/`groupBy`
read. This is enforced by convention, not a DB-level read-only role (yet) —
if the database user this service connects with is ever narrowed to
read-only at the Postgres level, that's a welcome extra guarantee, not a
replacement for keeping the code itself write-free.

This matters especially for the chat feature: the LLM is given a FIXED list
of tool schemas per source (`lib/openai.ts`'s `getToolSchemas(source)`,
e.g. `TOOL_SCHEMAS_O2D`/`TOOL_SCHEMAS_JF`/`TOOL_SCHEMAS_ERP`) mapped 1:1 to
functions in the matching `lib/tools*.ts` file. The model **never writes
its own SQL/Prisma query** — it can only call what's in that list, and
every one of those is a read (raw `$queryRaw` calls in `lib/tools-erp.ts`
are hand-written SELECT-only aggregations, never built from model input).
Do not add a "natural-language-to-SQL" style tool that lets the model
construct arbitrary queries — that was explicitly considered and rejected
in favor of this fixed-tools approach specifically because of the
injection/destructive-query risk against a live production database — one
this app now genuinely connects to (see Database above).

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
is wired up. ⚠️ **As of 2026-09-14 this is set on the deployed Render
service AND `DATABASE_URL` now points at real production data** (see
Database above) — meaning anyone who reaches the deployed URL currently
sees real, live business data with no login at all. This was a deliberate,
explicit choice by the owner to keep testing convenient (confirmed via
direct prompt: kept on rather than switched off when the database was
switched to production) — it is NOT an oversight, but it also has NOT been
turned off since, so treat this as an outstanding action item before the
URL is shared beyond active testing: set both vars back to `false` (or
unset them) on Render once real login is in use.

**No SSO/seamless-login from O2D yet** — clicking through from O2D straight
into this service without re-entering credentials would require a small
change to O2D's own frontend (a nav link that passes the current token in
the URL). That was explicitly deferred — this repo only, no O2D-side
changes, until asked for separately.

## Chat: streaming, markdown, and multilingual replies

`app/api/chat/route.ts` streams its response as newline-delimited JSON
events (`{"type":"delta"|"done"|"error", ...}`, NOT Server-Sent Events) —
`lib/client-api.ts`'s `sendChatStream()` reads the response body with a
plain `ReadableStream` reader and calls back into `app/page.tsx` as each
chunk arrives, so the reply visibly types itself out. Only the model's
FINAL answer round is actually streamed from OpenAI (`stream: true`) —
tool-call rounds aren't, since they produce no user-visible text, only
function-call arguments; a direct (no-tool-call) answer gets chunked into
small artificial deltas client-side so it gets the same live-typing effect.

Replies render through `react-markdown` + `remark-gfm` (the GFM plugin is
required for tables — without it a "report format" request renders as raw
`| pipe | text |` instead of an actual table, a real bug hit and fixed
2026-09-13) with hand-written CSS in `app/globals.css`'s `.chat-markdown`
rules (no `@tailwindcss/typography` dependency for this single use).

**Multilingual**: `lib/openai.ts`'s `SYSTEM_PROMPT_BASE` (shared by all
three sources) instructs the model to reply in whatever language/style the
user's LATEST message used — Hindi, English, or Hinglish — switching
per-message rather than locking onto the conversation's starting language.
Order numbers/karigar names/stage names/company names always stay
untranslated regardless of reply language.

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

`currentStage` is free text, not a Prisma enum (matches O2D's own
schema.prisma comment). **Already verified against real data** (2026-09-10,
`SELECT DISTINCT "currentStage", COUNT(*) FROM "Order" GROUP BY
"currentStage"`): actual values are Title Case, e.g. "In Process", "Follow
Up", "Delivery", "QC 1", "Receipt", "Polish Submit", "Ghat Jama", "Bangle
Polish", "Meena Inhouse", "QC 2", "Reject", "Polish Inhouse", "Dispatch",
"Pending" — `TERMINAL_STAGES = ['Delivery', 'Complete', 'Completed']` in
`lib/tools.ts` reflects this. If your database's `OrderStage` master data
ever differs (it can vary per branch), re-run that query and update the
constant — every function in the file keys off it.

## Branch scoping

`branchScope()` in `lib/tools.ts`: a `SUPER_ADMIN` sees every branch; an
`ADMIN` only sees their own (`user.branchId`) — mirrors O2D's own
`branchWhere` pattern (`src/lib/branchScope.ts` there). A plain `USER`
account can't reach this service at all (see Auth above), so there's no
`USER`-level scoping to worry about here.

## What this explicitly does NOT do (by design, not yet-missing)

- No order/stage/karigar mutation, ever, from anywhere in this service —
  applies identically across all three sources.
- No email/SMS/push notifications — insights are pull-based (dashboard
  load, chat question), not pushed proactively. Could be a future addition,
  not in scope now.
- ERP support is now IN scope (added 2026-09-14) but still only a subset —
  no access to `MetalStockEntry`'s per-location breakdown,
  `liveDepartmentStock`, or `karigarMainWeights` (all present in the real
  `/stock-summary` payload but not surfaced on its own dashboard cards
  either — see "ERP's dashboard" above for what's actually exposed), and
  no ERP write endpoints (job creation, alloy conversion, department
  issue/receipt entry, etc.) — read-only reporting only.
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

## Status (as of 2026-09-14)

**Deployed and confirmed working**: all three tabs (Order to Delivery,
Jewel Factory, ERP) load real data on the live Render service
(`ai-production-incharge-66fx.onrender.com`), chat streams + renders
markdown + replies in the user's own language across all three, `/api/
health` reports a healthy DB connection.

**Open items / known state, not yet resolved**:
- `SKIP_AUTH_IN_DEV`/`NEXT_PUBLIC_SKIP_AUTH_IN_DEV` are still `true` on the
  deployed Render service, and `DATABASE_URL` now points at real
  production data — see the ⚠️ note under Auth above. Turn both off before
  the URL is shared beyond active testing.
- Real secrets (the production RDS password, the Jewel Factory RDS
  password, an OpenAI API key) have at various points been pasted directly
  into chat/session transcripts while debugging — rotate them once active
  development winds down, not just as a hypothetical precaution.
- ERP's "Department recovery %" and "Recent activity" panels may look
  sparse/empty depending on how much real department-issue/receipt
  activity has been recorded in production by the time you're reading this
  — confirmed accurate (not a bug) as of 2026-09-14 with very little real
  activity yet; re-verify against real row counts if it still looks wrong
  later rather than assuming the calculation is broken.
- No production monitoring/alerting exists for this service itself (if the
  Render deploy silently breaks, nothing pages anyone) — purely manual
  "check the dashboard" verification so far.
