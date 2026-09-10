import OpenAI from 'openai';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

import * as tools from './tools';
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

// ── Tool schemas handed to the LLM (OpenAI function-calling) ────────────────
// Every one of these maps 1:1 to a function in lib/tools.ts. The LLM can
// only ever call what's listed here — it never writes its own SQL/Prisma
// query, and none of these functions can mutate data (see lib/tools.ts's
// own header comment). This is the ENTIRE surface the chat assistant has
// access to; if a question needs data outside this list, the system prompt
// instructs the model to say so rather than guess.
export const TOOL_SCHEMAS: ChatCompletionTool[] = [
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

export const SYSTEM_PROMPT = `You are the AI Production Incharge for a jewellery order-to-delivery production system.

Your job is READ-ONLY analysis and reporting. You can see order status, delays, stage
bottlenecks, and karigar (artisan) workload through the tools available to you. You
CANNOT and MUST NOT change any order, reassign any karigar, or take any action in the
system — you only observe and report. If a user asks you to take an action (reassign,
update, delete, approve), tell them you can only report information, not take actions,
and suggest they do it themselves in the main O2D system.

You only know what your tools can tell you. If a question needs information no tool
provides (e.g. gold/metal weight totals, financial data, anything about the merged ERP
module, or anything not covered by your tool list), say clearly that you don't have
that data available — never guess or invent a number. Never fabricate an order number,
karigar name, or count that a tool did not actually return.

When you call a tool and get results back, summarize them in clear, concise language —
don't just dump raw JSON. Use rupee-free, price-free language (this business does not
show prices anywhere in its systems). Call tools as many times as needed to answer
fully (e.g. combine getDelayedOrders with getKarigarLoad if a question spans both).`;

/** Dispatches one tool call by name to the matching lib/tools.ts function. */
export async function runTool(name: string, args: Record<string, unknown>, user: AuthUser): Promise<unknown> {
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
