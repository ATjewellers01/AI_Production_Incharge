import OpenAI from 'openai';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

import * as tools from './tools';
import * as toolsJf from './tools-jf';
import * as toolsErp from './tools-erp';
import type { AuthUser } from './auth';

// Lazy singleton — NOT constructed at module load. The OpenAI SDK throws
// immediately in its constructor if OPENAI_API_KEY is missing/empty, and
// this module gets imported during `next build`'s page-data-collection
// step (it's referenced from app/api/chat/route.ts), which runs with
// whatever env vars the BUILD environment has — not necessarily the same
// ones the running container gets. Building without OPENAI_API_KEY set
// must still succeed; only an actual request needs the key to exist.
let _openai: OpenAI | null = null;
export function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

export const CHAT_MODEL = process.env.AI_INCHARGE_MODEL || 'gpt-4o';

/** Which business's data this dashboard/chat is currently scoped to. Added
 * 2026-09-13 (Jewel Factory) and extended 2026-09-14 (ERP) — every tool
 * schema, system prompt, and dispatch table below is now keyed by this so
 * a chat session can NEVER mix sources' data in one answer, and the LLM
 * can never see a tool it isn't scoped to. */
export type Source = 'o2d' | 'jf' | 'erp';

// ── Tool schemas handed to the LLM (OpenAI function-calling), per source ────
// Every one of these maps 1:1 to a function in lib/tools.ts (O2D) or
// lib/tools-jf.ts (Jewel Factory). The LLM can only ever call what's listed
// for the CURRENTLY SELECTED source — it never writes its own SQL/Prisma
// query, and none of these functions can mutate data (see each tools file's
// own header comment). If a question needs data outside this list, the
// system prompt instructs the model to say so rather than guess.
const TOOL_SCHEMAS_O2D: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'getDelayedOrders',
      description:
        'List every active order that is past its due date (or expected delivery date) and has not yet reached Delivery/Completed. Use for any "what is late / overdue / delayed" question.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max rows to return, default 100' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getStageBottlenecks',
      description:
        'How many active orders currently sit in each production stage, and how old the single oldest order in each stage is. Use for "where is the bottleneck / which stage is backed up" questions.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getKarigarLoad',
      description:
        'How many active orders (and how many of those are already delayed) each karigar currently has. Optionally narrow to one karigar by (partial, case-insensitive) name. Use for "who is overloaded / how much work does X have" questions.',
      parameters: {
        type: 'object',
        properties: { karigarName: { type: 'string', description: 'Optional partial karigar name to filter to just one karigar' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getOrderByNumber',
      description: 'Look up one specific order by its exact order number, e.g. "JF-1042" or "REP-88".',
      parameters: {
        type: 'object',
        properties: { orderNo: { type: 'string' } },
        required: ['orderNo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchOrders',
      description:
        'General-purpose order search with optional filters (karigar name, company name, order type, job type, stage, status, created-date range). Use this for any question that does not cleanly fit the other tools — e.g. "urgent orders for Sharma Jewellers", "repair orders created this week". Omit any filter you are not sure about rather than guessing a value. Returns at most 50 rows.',
      parameters: {
        type: 'object',
        properties: {
          karigarName: { type: 'string' },
          companyName: { type: 'string' },
          orderType: { type: 'string', enum: ['NORMAL', 'URGENT', 'STOCK', 'REPAIR_ITEM'] },
          jobType: { type: 'string', enum: ['ORDER', 'REPAIR'] },
          stage: { type: 'string', description: 'Exact currentStage value, e.g. "QC1", "DISPATCH"' },
          status: { type: 'string', enum: ['ACTIVE', 'COMPLETED', 'DUMPED'] },
          createdAfter: { type: 'string', description: 'ISO date, e.g. "2026-09-01"' },
          createdBefore: { type: 'string', description: 'ISO date' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getSummary',
      description: 'Quick top-line counts: total active orders, total delayed, total urgent, total completed today.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const TOOL_SCHEMAS_JF: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'getDelayedOrders',
      description:
        'List every non-completed order (Catalogue, Store Customer, or Customised) whose delivery date has passed. Use for any "what is late / overdue / delayed" question.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max rows to return, default 100' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getStageBottlenecks',
      description:
        'How many active orders currently sit in each stage/status, and how old the single oldest order in each is. Use for "where is the bottleneck" questions.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getKarigarLoad',
      description:
        'How many active orders (and how many are already delayed) each karigar (by karigarCode) currently has. Optionally narrow to one karigar via a partial, case-insensitive code match.',
      parameters: {
        type: 'object',
        properties: { karigarCode: { type: 'string', description: 'Optional partial karigar code to filter to just one karigar' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getOrderByNumber',
      description: 'Look up one specific order by its exact order number across all three order types (Catalogue/Store Customer/Customised), e.g. "JFC-0042" or a B2B-YYYYMMDD-XXXX number.',
      parameters: {
        type: 'object',
        properties: { orderNo: { type: 'string' } },
        required: ['orderNo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchOrders',
      description:
        'General-purpose order search with optional filters (retailer/store business name, karigar code, order kind, status, urgent). Use for any question that does not cleanly fit the other tools. Returns at most 50 rows.',
      parameters: {
        type: 'object',
        properties: {
          storeName: { type: 'string', description: 'Partial, case-insensitive retailer business name' },
          karigarCode: { type: 'string' },
          kind: { type: 'string', enum: ['Catalogue', 'Store Customer', 'Customised'] },
          status: { type: 'string', enum: ['PENDING', 'IN_PROCESS', 'GHAT_RECEIVED', 'READY_FOR_DELIVERY', 'DISPATCHED', 'COMPLETED', 'CANCELLED'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getSummary',
      description: 'Quick top-line counts: total active orders, total delayed, total urgent, total completed today.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const TOOL_SCHEMAS_ERP: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'getMetalStockSummary',
      description:
        'Current metal stock levels: 24K/22K/20K/18K gold on hand, scrap/wastage pool balance, and total conversion (metal) loss recorded. Use for any "how much gold do we have / what\'s our stock" question.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getDepartmentEfficiency',
      description:
        'Recovery percentage per department (Die/Taar/Chain/KDM etc.) — issued weight vs. returned weight, across completed department issues. Use for "which department has the most loss / best recovery" questions.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getKarigarRankings',
      description:
        'Every karigar\'s recovery percentage (issued weight vs. returned weight, completed work only), sorted best-first. Use for "who is the best/worst performing karigar" questions — the caller can take the top N or bottom N from the returned list.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getDepartmentSummary',
      description: 'How many department issues are still pending (not yet returned) and their weight, plus the average recovery % across completed ones.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getAlloySummary',
      description:
        'Alloy conversion (24K -> lower karat) stats: total conversions, average loss %, how many exceeded the 1% loss threshold, how many happened today, and the 3 most recent conversion batches.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getJobPipeline',
      description:
        'Production-planning job pipeline: how many jobs are queued (no department issue raised yet), in progress, or ready (received back), plus a per-department breakdown of pending issues/returns and their weight.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getRecentActivity',
      description: 'The 8 most recent department-issue events (metal deployed to a department/karigar), newest first.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getOrdersSummary',
      description: 'Factory order counts by type (normal/urgent/stock) and their total weight, from the Order-to-Delivery order table.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export function getToolSchemas(source: Source): ChatCompletionTool[] {
  if (source === 'jf') return TOOL_SCHEMAS_JF;
  if (source === 'erp') return TOOL_SCHEMAS_ERP;
  return TOOL_SCHEMAS_O2D;
}

const SYSTEM_PROMPT_BASE = `Your job is READ-ONLY analysis and reporting. You can see order status, delays, stage
bottlenecks, and karigar (artisan) workload through the tools available to you. You
CANNOT and MUST NOT change any order, reassign any karigar, or take any action in the
system — you only observe and report. If a user asks you to take an action (reassign,
update, delete, approve), tell them you can only report information, not take actions,
and suggest they do it themselves in the main system.

You only know what your tools can tell you. If a question needs information no tool
provides (e.g. gold/metal weight totals, financial data, or anything not covered by
your tool list), say clearly that you don't have that data available — never guess or
invent a number. Never fabricate an order number, karigar name/code, or count that a
tool did not actually return.

When you call a tool and get results back, summarize them in clear, concise language —
don't just dump raw JSON. Use rupee-free, price-free language (this business does not
show prices anywhere in its systems). Call tools as many times as needed to answer
fully.

Language: always reply in the SAME language/style the user's latest message was
written in — plain Hindi (Devanagari script) if they wrote in Hindi, English if they
wrote in English, or Hinglish (Hindi in Latin script, mixed with English words) if
that's what they used. Match their style message-by-message rather than locking onto
whatever language the conversation started in — if they switch, you switch too. Keep
order numbers, karigar names/codes, stage names, and company/retailer names exactly as
they appear in the data regardless of reply language — never translate those.`;

const SYSTEM_PROMPT_O2D = `You are the AI Production Incharge for a jewellery order-to-delivery production system (Order to Delivery / O2D).

${SYSTEM_PROMPT_BASE}`;

const SYSTEM_PROMPT_JF = `You are the AI Production Incharge for Jewel Factory's manufacturer-side production system.

You see the SAME data a Jewel Factory manufacturer sees in their own portal: Catalogue
orders (B2B), Store Customer orders (Kiosk), and Customised orders, which retailer each
came from, which karigar (by karigarCode) is assigned, and their current stage/status.
You do NOT see any customer personal information (name/phone/email/address) — Jewel
Factory's own system never shows that to the manufacturer either, and it is not
available to you as a matter of design, not just policy.

A Customised order that has already been forwarded to O2D (the separate Order-to-
Delivery system) has its real production tracking continue there — your Jewel Factory
tools deliberately exclude those from active/delayed counts to avoid double-counting;
if asked about such an order, say its production has moved to the Order-to-Delivery
system and suggest checking there.

${SYSTEM_PROMPT_BASE}`;

const SYSTEM_PROMPT_ERP = `You are the AI Production Incharge for the ERP (metal/production-flow tracking) side of this
jewellery manufacturing system.

This ERP module tracks METAL and PRODUCTION FLOW, not customer orders — there is no
single "order" row per unit of work the way the Order-to-Delivery system has. What you
actually see: current metal stock levels by karat (24K/22K/20K/18K) plus scrap and
conversion loss, department recovery percentages (issued vs. returned weight),
karigar recovery rankings, alloy-conversion loss stats, a job pipeline
(queued/in-progress/ready), and a recent department-issue activity feed.

"Recovery %" means how much of the metal issued to a department/karigar actually came
back as finished goods + scrap + dust + accounted loss — higher is better, roughly 98%+
is considered good performance. This data has no real due-date or "urgent order" flag
the way Order-to-Delivery has — don't invent one; describe pending department issues by
their actual pending weight/count instead.

${SYSTEM_PROMPT_BASE}`;

export function getSystemPrompt(source: Source): string {
  if (source === 'jf') return SYSTEM_PROMPT_JF;
  if (source === 'erp') return SYSTEM_PROMPT_ERP;
  return SYSTEM_PROMPT_O2D;
}

/** Dispatches one tool call by name to the matching lib/tools.ts (O2D),
 * lib/tools-jf.ts (Jewel Factory), or lib/tools-erp.ts (ERP) function,
 * scoped strictly to `source` — a chat session can never reach another
 * source's tools even if the model somehow requested a mismatched name. */
export async function runTool(name: string, args: Record<string, unknown>, user: AuthUser, source: Source): Promise<unknown> {
  if (source === 'jf') {
    switch (name) {
      case 'getDelayedOrders':
        return toolsJf.getDelayedOrdersJf(user, args.limit as number | undefined);
      case 'getStageBottlenecks':
        return toolsJf.getStageBottlenecksJf(user);
      case 'getKarigarLoad':
        return toolsJf.getKarigarLoadJf(user, args.karigarCode as string | undefined);
      case 'getOrderByNumber':
        return toolsJf.getOrderByNumberJf(user, args.orderNo as string);
      case 'searchOrders':
        return toolsJf.searchOrdersJf(user, args as toolsJf.SearchFiltersJf);
      case 'getSummary':
        return toolsJf.getSummaryJf(user);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  if (source === 'erp') {
    switch (name) {
      case 'getMetalStockSummary':
        return toolsErp.getMetalStockSummaryErp(user);
      case 'getDepartmentEfficiency':
        return toolsErp.getDepartmentEfficiencyErp(user);
      case 'getKarigarRankings':
        return toolsErp.getKarigarRankingsErp(user);
      case 'getDepartmentSummary':
        return toolsErp.getDepartmentSummaryErp(user);
      case 'getAlloySummary':
        return toolsErp.getAlloySummaryErp(user);
      case 'getJobPipeline':
        return toolsErp.getJobPipelineErp(user);
      case 'getRecentActivity':
        return toolsErp.getRecentActivityErp(user);
      case 'getOrdersSummary':
        return toolsErp.getOrdersSummaryErp(user);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  switch (name) {
    case 'getDelayedOrders':
      return tools.getDelayedOrders(user, args.limit as number | undefined);
    case 'getStageBottlenecks':
      return tools.getStageBottlenecks(user);
    case 'getKarigarLoad':
      return tools.getKarigarLoad(user, args.karigarName as string | undefined);
    case 'getOrderByNumber':
      return tools.getOrderByNumber(user, args.orderNo as string);
    case 'searchOrders':
      return tools.searchOrders(user, args as tools.SearchFilters);
    case 'getSummary':
      return tools.getSummary(user);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
