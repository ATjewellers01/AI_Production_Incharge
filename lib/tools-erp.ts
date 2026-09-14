import { prisma } from './prisma';
import type { AuthUser } from './auth';

// ── ERP's read-only "tool" functions — same shape/purpose as lib/tools.ts
// (O2D) and lib/tools-jf.ts (Jewel Factory), added 2026-09-14. Unlike
// Jewel Factory, ERP is NOT a separate database — it's mounted on the SAME
// at-order-to-dispatch-backend, sharing the same Postgres database this
// app's O2D client (`prisma` from ./prisma) already connects to. So this
// file uses that same client, just against a different set of tables
// (ProductionPlan, ProductionPlanningEntry, DepartmentIssueEntry,
// DepartmentReceiptEntry, KarigarIssueEntry, KarigarReceiptEntry — see
// prisma/schema.prisma's "ERP models" section).
//
// ERP tracks METAL/PRODUCTION FLOW, not customer orders — there is no
// single "Order" row per unit of work here the way O2D has. The three
// fixed dashboard insights are re-interpreted for this domain:
//   - "delayed orders"      -> KarigarIssueEntry rows with metal issued to
//                              a karigar that hasn't come back yet
//                              (no KarigarReceiptEntry against that
//                              issueNo), past a reasonable age.
//   - "stage bottlenecks"   -> ProductionPlanningEntry.status counts
//                              (pending/issued/received-equivalent).
//   - "karigar load"        -> KarigarIssueEntry.karigarName groupings of
//                              still-outstanding issues.
//
// Every function here does ONLY a Prisma find*/count/groupBy read — no
// writes, ever, same rule as every other tools*.ts file in this repo.

/** A karigar issue is "outstanding" (the ERP equivalent of an active order)
 * if it has no receipt at all yet. Fully received (or fully accounted for)
 * issues are excluded from every active/delayed count below. */
const OUTSTANDING_ISSUE_WHERE = { receipts: { none: {} } } as const;

export type DelayedIssueErp = {
  issueNo: string;
  orderNo: string;
  karigarName: string;
  totalWeight: number;
  daysOutstanding: number;
};

/** Every karigar-metal issue with no receipt yet, oldest first — the ERP
 * analogue of "what's overdue right now." There is no separate due-date
 * field on KarigarIssueEntry (expectedDelivery is free text, not a real
 * date — see the schema comment), so "delayed" here means "outstanding
 * for longer than a working threshold," using the issue's own timestamp
 * as the age reference. */
export async function getDelayedIssuesErp(_user: AuthUser, limit = 100): Promise<DelayedIssueErp[]> {
  const now = new Date();
  const issues = await prisma.karigarIssueEntry.findMany({
    where: OUTSTANDING_ISSUE_WHERE,
    select: { issueNo: true, orderNo: true, karigarName: true, totalWeight: true, timestamp: true },
    orderBy: { timestamp: 'asc' },
    take: limit,
  });

  return issues.map((i) => ({
    issueNo: i.issueNo,
    orderNo: i.orderNo,
    karigarName: i.karigarName,
    totalWeight: Number(i.totalWeight),
    daysOutstanding: Math.floor((now.getTime() - i.timestamp.getTime()) / 86_400_000),
  }));
}

export type StageBottleneckErp = {
  stage: string;
  entryCount: number;
  oldestRef: string | null;
  oldestAgeDays: number | null;
};

/** Groups every production-planning entry by its status (pending/issued/
 * received-equivalent free-text status column) — same "where's the
 * pile-up" signal as the other two sources' stage-bottleneck insight. */
export async function getStageBottlenecksErp(_user: AuthUser): Promise<StageBottleneckErp[]> {
  const now = new Date();
  const entries = await prisma.productionPlanningEntry.findMany({
    select: { id: true, status: true, dept: true, timestamp: true },
  });

  const byStatus = new Map<string, { count: number; oldestRef: string; oldestTimestamp: Date }>();
  for (const e of entries) {
    const key = e.status || 'unknown';
    const existing = byStatus.get(key);
    if (!existing) {
      byStatus.set(key, { count: 1, oldestRef: e.dept, oldestTimestamp: e.timestamp });
    } else {
      existing.count++;
      if (e.timestamp < existing.oldestTimestamp) {
        existing.oldestRef = e.dept;
        existing.oldestTimestamp = e.timestamp;
      }
    }
  }

  return Array.from(byStatus.entries())
    .map(([stage, v]) => ({
      stage,
      entryCount: v.count,
      oldestRef: v.oldestRef,
      oldestAgeDays: Math.floor((now.getTime() - v.oldestTimestamp.getTime()) / 86_400_000),
    }))
    .sort((a, b) => b.entryCount - a.entryCount);
}

export type KarigarLoadErp = {
  karigarName: string;
  outstandingIssueCount: number;
  outstandingWeight: number;
};

/** How much metal (by weight) and how many outstanding issues each karigar
 * currently has not yet returned — the ERP analogue of "how much work does
 * X have." Sorted heaviest-outstanding-weight first. */
export async function getKarigarLoadErp(_user: AuthUser, karigarName?: string): Promise<KarigarLoadErp[]> {
  const issues = await prisma.karigarIssueEntry.findMany({
    where: {
      ...OUTSTANDING_ISSUE_WHERE,
      ...(karigarName ? { karigarName: { contains: karigarName, mode: 'insensitive' } } : {}),
    },
    select: { karigarName: true, totalWeight: true },
  });

  const byKarigar = new Map<string, { count: number; weight: number }>();
  for (const i of issues) {
    const existing = byKarigar.get(i.karigarName);
    const weight = Number(i.totalWeight);
    if (!existing) {
      byKarigar.set(i.karigarName, { count: 1, weight });
    } else {
      existing.count++;
      existing.weight += weight;
    }
  }

  return Array.from(byKarigar.entries())
    .map(([name, v]) => ({ karigarName: name, outstandingIssueCount: v.count, outstandingWeight: v.weight }))
    .sort((a, b) => b.outstandingWeight - a.outstandingWeight);
}

export type IssueLookupResultErp = {
  issueNo: string;
  orderNo: string;
  karigarName: string;
  issueStatus: string;
  totalWeight: number;
  meltingType: string;
  expectedDelivery: string | null;
  received: boolean;
  createdAt: string;
};

/** Look up one specific karigar-metal issue by its exact issueNo. */
export async function getIssueByNumberErp(_user: AuthUser, issueNo: string): Promise<IssueLookupResultErp | null> {
  const issue = await prisma.karigarIssueEntry.findUnique({
    where: { issueNo },
    select: {
      issueNo: true,
      orderNo: true,
      karigarName: true,
      issueStatus: true,
      totalWeight: true,
      meltingType: true,
      expectedDelivery: true,
      createdAt: true,
      receipts: { select: { id: true }, take: 1 },
    },
  });
  if (!issue) return null;

  return {
    issueNo: issue.issueNo,
    orderNo: issue.orderNo,
    karigarName: issue.karigarName,
    issueStatus: issue.issueStatus,
    totalWeight: Number(issue.totalWeight),
    meltingType: issue.meltingType,
    expectedDelivery: issue.expectedDelivery || null,
    received: issue.receipts.length > 0,
    createdAt: issue.createdAt.toISOString(),
  };
}

export type SearchFiltersErp = {
  karigarName?: string;
  orderNo?: string;
  meltingType?: string;
  onlyOutstanding?: boolean;
};

/** General-purpose, multi-filter karigar-issue search — catch-all for a
 * free-text question that doesn't fit the fixed insights above. */
export async function searchIssuesErp(_user: AuthUser, filters: SearchFiltersErp, limit = 50): Promise<DelayedIssueErp[]> {
  const now = new Date();
  const issues = await prisma.karigarIssueEntry.findMany({
    where: {
      ...(filters.onlyOutstanding ? OUTSTANDING_ISSUE_WHERE : {}),
      ...(filters.karigarName ? { karigarName: { contains: filters.karigarName, mode: 'insensitive' } } : {}),
      ...(filters.orderNo ? { orderNo: { contains: filters.orderNo, mode: 'insensitive' } } : {}),
      ...(filters.meltingType ? { meltingType: { contains: filters.meltingType, mode: 'insensitive' } } : {}),
    },
    select: { issueNo: true, orderNo: true, karigarName: true, totalWeight: true, timestamp: true },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });

  return issues.map((i) => ({
    issueNo: i.issueNo,
    orderNo: i.orderNo,
    karigarName: i.karigarName,
    totalWeight: Number(i.totalWeight),
    daysOutstanding: Math.floor((now.getTime() - i.timestamp.getTime()) / 86_400_000),
  }));
}

export type SummaryErp = {
  totalActive: number; // total outstanding karigar issues
  totalDelayed: number; // outstanding issues older than 7 days
  totalUrgent: number; // outstanding issues older than 14 days (no separate "urgent" flag in ERP data)
  totalCompletedToday: number; // karigar receipts recorded today
};

const DELAYED_THRESHOLD_DAYS = 7;
const URGENT_THRESHOLD_DAYS = 14;

/** Quick top-line counts, mirroring the other two sources' getSummary
 * shape. ERP has no explicit "urgent" flag on an issue (unlike O2D's
 * OrderType.URGENT) — this substitutes "outstanding for a long time" as
 * the closest available proxy, clearly labeled as such in the system
 * prompt so the model doesn't imply a real urgent flag exists. */
export async function getSummaryErp(_user: AuthUser): Promise<SummaryErp> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const delayedCutoff = new Date(now.getTime() - DELAYED_THRESHOLD_DAYS * 86_400_000);
  const urgentCutoff = new Date(now.getTime() - URGENT_THRESHOLD_DAYS * 86_400_000);

  const [totalActive, totalDelayed, totalUrgent, totalCompletedToday] = await Promise.all([
    prisma.karigarIssueEntry.count({ where: OUTSTANDING_ISSUE_WHERE }),
    prisma.karigarIssueEntry.count({ where: { ...OUTSTANDING_ISSUE_WHERE, timestamp: { lt: delayedCutoff } } }),
    prisma.karigarIssueEntry.count({ where: { ...OUTSTANDING_ISSUE_WHERE, timestamp: { lt: urgentCutoff } } }),
    prisma.karigarReceiptEntry.count({ where: { createdAt: { gte: todayStart } } }),
  ]);

  return { totalActive, totalDelayed, totalUrgent, totalCompletedToday };
}
