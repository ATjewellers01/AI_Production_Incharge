import { prisma } from './prisma';
import type { AuthUser } from './auth';

// ── The fixed, read-only "tool" functions this whole service is built on ────
//
// Every one of these does ONLY a Prisma `find*`/`count`/`groupBy` read.
// There is no `.create(`/`.update(`/`.delete(`/`.upsert(` anywhere in this
// file, or anywhere else in this repo — see CLAUDE.md. The dashboard calls
// these three directly, in a fixed order, on every page load (real-time,
// no caching). The chat endpoint hands the SAME functions to the LLM as
// "tools" (OpenAI function-calling) so a free-text question can combine or
// filter them differently, but it can never call anything these functions
// don't already expose — the LLM cannot write its own SQL/Prisma query.

/** ADMIN is pinned to their own branch; SUPER_ADMIN sees every branch (optionally narrowed later). */
function branchScope(user: AuthUser) {
  return user.role === 'SUPER_ADMIN' ? {} : { branchId: user.branchId ?? '__none__' };
}

// currentStage is free text, NOT an enum (see O2D's own schema.prisma
// comment on Order.currentStage) — it's driven by the master "Order
// Stages" data + hard-coded stage-key strings in O2D's own process routes.
// Verified against the real database (`SELECT DISTINCT "currentStage",
// COUNT(*) FROM "Order" GROUP BY "currentStage"`, 2026-09-10): actual
// values are Title Case, e.g. "In Process", "Follow Up", "Delivery", "QC 1",
// "Receipt", "Polish Submit", "Ghat Jama", "Bangle Polish", "Meena Inhouse",
// "QC 2", "Reject", "Polish Inhouse", "Dispatch", "Pending" — NOT the
// uppercase ORDER_STAGE-key-style strings ("DELIVERY", "QC1") an earlier,
// unverified draft of this file assumed. "Delivery" is the last pipeline
// stage seen in that data; no order in that sample ever showed a
// currentStage of "Complete"/"Completed" — Order.status (the separate
// OrderStatus enum: ACTIVE/COMPLETED/DUMPED) is what actually flips to
// COMPLETED once a piece is fully done, not this string. If your database
// ever needs a different set (a branch's Order Stages master data can differ,
// this was captured from one particular branch), re-run that query and
// update this list — every function below keys off it, so one edit here
// fixes them all.
const TERMINAL_STAGES = ['Delivery', 'Complete', 'Completed'];

const ACTIVE_ORDER_SELECT = {
  id: true,
  orderNo: true,
  currentStage: true,
  orderType: true,
  jobType: true,
  dueDate: true,
  expectedDeliveryDate: true,
  karigarDeliveryDate: true,
  createdAt: true,
  karigar: { select: { id: true, name: true, code: true } },
  company: { select: { name: true } },
} as const;

export type DelayedOrder = {
  orderNo: string;
  stage: string;
  orderType: string;
  karigarName: string | null;
  companyName: string;
  dueDate: string | null;
  daysLate: number;
};

/**
 * Every ACTIVE order whose dueDate (fallback: expectedDeliveryDate) has
 * passed and hasn't reached "Delivery"/"Completed" yet — the single most
 * actionable "what needs attention right now" signal a production incharge
 * checks daily.
 */
export async function getDelayedOrders(user: AuthUser, limit = 100): Promise<DelayedOrder[]> {
  const now = new Date();
  const orders = await prisma.order.findMany({
    where: {
      ...branchScope(user),
      status: 'ACTIVE',
      currentStage: { notIn: TERMINAL_STAGES },
      OR: [{ dueDate: { lt: now } }, { AND: [{ dueDate: null }, { expectedDeliveryDate: { lt: now } }] }],
    },
    select: ACTIVE_ORDER_SELECT,
    orderBy: { dueDate: 'asc' },
    take: limit,
  });

  return orders.map((o) => {
    const reference = o.dueDate ?? o.expectedDeliveryDate;
    const daysLate = reference ? Math.floor((now.getTime() - reference.getTime()) / 86_400_000) : 0;
    return {
      orderNo: o.orderNo,
      stage: o.currentStage,
      orderType: o.orderType,
      karigarName: o.karigar?.name ?? null,
      companyName: o.company.name,
      dueDate: o.dueDate ? o.dueDate.toISOString().slice(0, 10) : null,
      daysLate,
    };
  });
}

export type StageBottleneck = {
  stage: string;
  orderCount: number;
  oldestOrderNo: string | null;
  oldestOrderAgeDays: number | null;
};

/**
 * Groups every ACTIVE, non-delivered order by its currentStage — how many
 * orders are sitting in each stage right now, and how long the single
 * oldest one there has been waiting. A stage with a large count AND an old
 * "oldest" order is the bottleneck to look at first.
 */
export async function getStageBottlenecks(user: AuthUser): Promise<StageBottleneck[]> {
  const now = new Date();
  const orders = await prisma.order.findMany({
    where: { ...branchScope(user), status: 'ACTIVE', currentStage: { notIn: TERMINAL_STAGES } },
    select: { currentStage: true, orderNo: true, createdAt: true },
  });

  const byStage = new Map<string, { count: number; oldestOrderNo: string; oldestCreatedAt: Date }>();
  for (const o of orders) {
    const existing = byStage.get(o.currentStage);
    if (!existing) {
      byStage.set(o.currentStage, { count: 1, oldestOrderNo: o.orderNo, oldestCreatedAt: o.createdAt });
    } else {
      existing.count++;
      if (o.createdAt < existing.oldestCreatedAt) {
        existing.oldestOrderNo = o.orderNo;
        existing.oldestCreatedAt = o.createdAt;
      }
    }
  }

  return Array.from(byStage.entries())
    .map(([stage, v]) => ({
      stage,
      orderCount: v.count,
      oldestOrderNo: v.oldestOrderNo,
      oldestOrderAgeDays: Math.floor((now.getTime() - v.oldestCreatedAt.getTime()) / 86_400_000),
    }))
    .sort((a, b) => b.orderCount - a.orderCount);
}

export type KarigarLoad = {
  karigarId: string;
  karigarName: string;
  karigarCode: string;
  activeOrderCount: number;
  delayedOrderCount: number;
};

/**
 * How many ACTIVE, non-delivered orders currently sit with each karigar —
 * and, of those, how many are already overdue. Sorted heaviest-load first
 * so an overloaded karigar (candidate to route new work AWAY from) is
 * immediately visible; a chat question can also ask for one specific
 * karigar via `karigarName` (case-insensitive partial match).
 */
export async function getKarigarLoad(user: AuthUser, karigarName?: string): Promise<KarigarLoad[]> {
  const now = new Date();
  const orders = await prisma.order.findMany({
    where: {
      ...branchScope(user),
      status: 'ACTIVE',
      currentStage: { notIn: TERMINAL_STAGES },
      karigarId: { not: null },
      ...(karigarName ? { karigar: { name: { contains: karigarName, mode: 'insensitive' } } } : {}),
    },
    select: { dueDate: true, expectedDeliveryDate: true, karigar: { select: { id: true, name: true, code: true } } },
  });

  const byKarigar = new Map<string, { name: string; code: string; active: number; delayed: number }>();
  for (const o of orders) {
    if (!o.karigar) continue;
    const isLate = (o.dueDate ?? o.expectedDeliveryDate) != null && (o.dueDate ?? o.expectedDeliveryDate)! < now;
    const existing = byKarigar.get(o.karigar.id);
    if (!existing) {
      byKarigar.set(o.karigar.id, { name: o.karigar.name, code: o.karigar.code, active: 1, delayed: isLate ? 1 : 0 });
    } else {
      existing.active++;
      if (isLate) existing.delayed++;
    }
  }

  return Array.from(byKarigar.entries())
    .map(([karigarId, v]) => ({
      karigarId,
      karigarName: v.name,
      karigarCode: v.code,
      activeOrderCount: v.active,
      delayedOrderCount: v.delayed,
    }))
    .sort((a, b) => b.activeOrderCount - a.activeOrderCount);
}

export type OrderLookupResult = {
  orderNo: string;
  stage: string;
  orderType: string;
  jobType: string;
  status: string;
  karigarName: string | null;
  companyName: string;
  dueDate: string | null;
  expectedDeliveryDate: string | null;
  karigarDeliveryDate: string | null;
  createdAt: string;
};

/** Look up one specific order by its exact order number (e.g. "JF-1042"). */
export async function getOrderByNumber(user: AuthUser, orderNo: string): Promise<OrderLookupResult | null> {
  const o = await prisma.order.findFirst({
    where: { ...branchScope(user), orderNo },
    select: { ...ACTIVE_ORDER_SELECT, status: true, jobType: true },
  });
  if (!o) return null;
  return {
    orderNo: o.orderNo,
    stage: o.currentStage,
    orderType: o.orderType,
    jobType: o.jobType,
    status: o.status,
    karigarName: o.karigar?.name ?? null,
    companyName: o.company.name,
    dueDate: o.dueDate ? o.dueDate.toISOString().slice(0, 10) : null,
    expectedDeliveryDate: o.expectedDeliveryDate ? o.expectedDeliveryDate.toISOString().slice(0, 10) : null,
    karigarDeliveryDate: o.karigarDeliveryDate ? o.karigarDeliveryDate.toISOString().slice(0, 10) : null,
    createdAt: o.createdAt.toISOString(),
  };
}

export type SearchFilters = {
  karigarName?: string;
  companyName?: string;
  orderType?: 'NORMAL' | 'URGENT' | 'STOCK' | 'REPAIR_ITEM';
  jobType?: 'ORDER' | 'REPAIR';
  stage?: string;
  status?: 'ACTIVE' | 'COMPLETED' | 'DUMPED';
  createdAfter?: string;
  createdBefore?: string;
};

/**
 * General-purpose, multi-filter order search — the "catch-all" tool for a
 * free-text question that doesn't map to one of the fixed insights above
 * (e.g. "urgent stock orders for Sharma Jewellers this month"). Every
 * filter is optional and AND-combined; omit a filter entirely rather than
 * guessing a value for it. Capped at 50 rows — if the LLM needs a count
 * rather than a list, it should say so in its own summary, not assume this
 * returned everything.
 */
export async function searchOrders(user: AuthUser, filters: SearchFilters, limit = 50): Promise<DelayedOrder[]> {
  const now = new Date();
  const orders = await prisma.order.findMany({
    where: {
      ...branchScope(user),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.orderType ? { orderType: filters.orderType } : {}),
      ...(filters.jobType ? { jobType: filters.jobType } : {}),
      ...(filters.stage ? { currentStage: filters.stage } : {}),
      ...(filters.karigarName ? { karigar: { name: { contains: filters.karigarName, mode: 'insensitive' } } } : {}),
      ...(filters.companyName ? { company: { name: { contains: filters.companyName, mode: 'insensitive' } } } : {}),
      ...(filters.createdAfter || filters.createdBefore
        ? {
            createdAt: {
              ...(filters.createdAfter ? { gte: new Date(filters.createdAfter) } : {}),
              ...(filters.createdBefore ? { lte: new Date(filters.createdBefore) } : {}),
            },
          }
        : {}),
    },
    select: ACTIVE_ORDER_SELECT,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return orders.map((o) => {
    const reference = o.dueDate ?? o.expectedDeliveryDate;
    const daysLate = reference && reference < now ? Math.floor((now.getTime() - reference.getTime()) / 86_400_000) : 0;
    return {
      orderNo: o.orderNo,
      stage: o.currentStage,
      orderType: o.orderType,
      karigarName: o.karigar?.name ?? null,
      companyName: o.company.name,
      dueDate: o.dueDate ? o.dueDate.toISOString().slice(0, 10) : null,
      daysLate,
    };
  });
}

export type Summary = { totalActive: number; totalDelayed: number; totalUrgent: number; totalCompletedToday: number };

/** Quick top-line counts — mirrors what O2D's own /api/dashboard/metrics shows, kept small on purpose. */
export async function getSummary(user: AuthUser): Promise<Summary> {
  const scope = branchScope(user);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [totalActive, totalDelayed, totalUrgent, totalCompletedToday] = await Promise.all([
    prisma.order.count({ where: { ...scope, status: 'ACTIVE' } }),
    prisma.order.count({
      where: {
        ...scope,
        status: 'ACTIVE',
        currentStage: { notIn: TERMINAL_STAGES },
        OR: [{ dueDate: { lt: now } }, { AND: [{ dueDate: null }, { expectedDeliveryDate: { lt: now } }] }],
      },
    }),
    prisma.order.count({ where: { ...scope, status: 'ACTIVE', orderType: 'URGENT' } }),
    prisma.order.count({ where: { ...scope, status: 'COMPLETED', updatedAt: { gte: todayStart } } }),
  ]);

  return { totalActive, totalDelayed, totalUrgent, totalCompletedToday };
}
