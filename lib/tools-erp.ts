import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import type { AuthUser } from './auth';

// ── ERP's read-only "tool" functions, added 2026-09-14 — rewritten same
// day to mirror erp-new-frontend's OWN dashboard metrics instead of the
// O2D/Jewel-Factory "delayed orders / stage bottlenecks / karigar load"
// pattern, which doesn't fit ERP's data (metal/production FLOW, not
// customer orders — there's no "order" row per unit of work here the way
// O2D has). See at-order-to-dispatch-backend/src/erp/{dashboard,
// stockSummary,productionPlanning}.routes.ts for the real endpoints this
// mirrors — every calculation below is kept as close as possible to that
// backend's own logic (same CompleteReturn-gating rules, same recovery-%
// formula) rather than a simplified approximation, since a subtly wrong
// stock/recovery number is worse than not showing one at all.
//
// Unlike Jewel Factory (a separate database), ERP shares O2D's exact
// database/Prisma client (`prisma` from ./prisma) — see prisma/
// schema.prisma's "ERP models" section. Every function here does ONLY a
// Prisma find*/count/groupBy/$queryRaw READ — no writes, ever.

const ZERO = new Prisma.Decimal(0);

// ── Metal stock levels (mirrors GET /stock-summary, the 4 stat cards) ────

export type MetalStockSummary = {
  stock24K: number;
  stock22K: number;
  stock20K: number;
  stock18K: number;
  scrapBalance: number;
  conversionLoss: number;
};

/** Same karat-stock formula as stockSummary.routes.ts's calculateKaratStock:
 * alloy-conversion output of this karat, plus CompleteReturn-only scrap
 * returned against an issue of this karat, minus karigar direct-metal
 * draws and department issues of this karat. Floored at 0. */
function calculateKaratStock(
  karat: '22K' | '20K' | '18K',
  conversions: Array<{ targetKarat: string; actualOutput: Prisma.Decimal }>,
  deptIssues: Array<{ issueNo: string; meltingType: string | null; issueWeight: Prisma.Decimal }>,
  deptReceipts: Array<{ issueNo: string; returnType: string; scrapMetal: Prisma.Decimal }>,
  karigarIssues: Array<{ meltingType: string; directMetal: Prisma.Decimal }>,
): Prisma.Decimal {
  let total = ZERO;

  for (const c of conversions) {
    if ((c.targetKarat ?? '').trim().toUpperCase() === karat) total = total.plus(c.actualOutput);
  }

  for (const r of deptReceipts) {
    if (r.returnType !== 'CompleteReturn') continue;
    const issue = deptIssues.find((i) => i.issueNo === r.issueNo);
    if (issue && (issue.meltingType ?? '').trim().toUpperCase() === karat) total = total.plus(r.scrapMetal);
  }

  for (const k of karigarIssues) {
    if ((k.meltingType ?? '').trim().toUpperCase() === karat) total = total.minus(k.directMetal);
  }

  for (const d of deptIssues) {
    if ((d.meltingType ?? '').trim().toUpperCase() === karat) total = total.minus(d.issueWeight);
  }

  return Prisma.Decimal.max(ZERO, total);
}

/** Metal stock levels across every karat + scrap/wastage + overall
 * conversion loss — mirrors the real ERP dashboard's top stat-card row.
 * Note this is a SUBSET of the real /stock-summary payload (no 999/995
 * purity split, no per-location breakdown, no live-department-stock, no
 * per-karigar main-weights) — those exist in the real endpoint but aren't
 * surfaced on its own dashboard cards either; add them here the same way
 * if a future insight needs them. */
export async function getMetalStockSummaryErp(_user: AuthUser): Promise<MetalStockSummary> {
  const [procurements, conversions, deptIssues, deptReceipts, karigarIssues] = await Promise.all([
    prisma.metalStockEntry.findMany({ select: { grossWeight: true, purity: true } }),
    prisma.alloyConversionEntry.findMany({ select: { targetKarat: true, actualOutput: true, input24K: true, purity: true } }),
    prisma.departmentIssueEntry.findMany({ select: { issueNo: true, meltingType: true, issueWeight: true } }),
    prisma.departmentReceiptEntry.findMany({ select: { issueNo: true, returnType: true, scrapMetal: true, metalLoss: true } }),
    prisma.karigarIssueEntry.findMany({ select: { meltingType: true, directMetal: true } }),
  ]);

  // 24K = procured gross weight (any purity bucket), minus what's been
  // drawn into alloy conversion as input, minus 24K issued straight to a
  // karigar or department. Simplified from the real endpoint's separate
  // 999/995 buckets into one combined 24K figure (that split isn't shown
  // on the real dashboard's own stat card either — it just shows one
  // combined "Fine Gold (24K)" number).
  let stock24K = procurements.reduce((sum, p) => sum.plus(p.grossWeight), ZERO);
  stock24K = conversions.reduce((sum, c) => sum.minus(c.input24K), stock24K);
  for (const k of karigarIssues) {
    const mt = (k.meltingType ?? '').toUpperCase();
    if (mt.includes('24K') || mt.includes('99.9') || mt.includes('99.5')) stock24K = stock24K.minus(k.directMetal);
  }
  for (const d of deptIssues) {
    const mt = (d.meltingType ?? '').toUpperCase();
    if (mt.includes('24K') || mt.includes('99.9') || mt.includes('99.5')) stock24K = stock24K.minus(d.issueWeight);
  }
  stock24K = Prisma.Decimal.max(ZERO, stock24K);

  const stock22K = calculateKaratStock('22K', conversions, deptIssues, deptReceipts, karigarIssues);
  const stock20K = calculateKaratStock('20K', conversions, deptIssues, deptReceipts, karigarIssues);
  const stock18K = calculateKaratStock('18K', conversions, deptIssues, deptReceipts, karigarIssues);

  // Scrap balance and overall conversion (metal) loss — same CompleteReturn
  // gate as karat stock: a partial visit's scrap is still with the
  // karigar, not yet credited to the scrap pool.
  let scrapBalance = ZERO;
  let conversionLoss = ZERO;
  for (const r of deptReceipts) {
    if (r.returnType === 'CompleteReturn') scrapBalance = scrapBalance.plus(r.scrapMetal);
    conversionLoss = conversionLoss.plus(r.metalLoss);
  }

  return {
    stock24K: stock24K.toNumber(),
    stock22K: stock22K.toNumber(),
    stock20K: stock20K.toNumber(),
    stock18K: stock18K.toNumber(),
    scrapBalance: scrapBalance.toNumber(),
    conversionLoss: conversionLoss.toNumber(),
  };
}

// ── Department efficiency (recovery % per department) ────────────────────

export type DepartmentEfficiencyErp = { dept: string; issuedWeight: number; returnedWeight: number; recoveryPercent: number };

/** Same query as GET /dashboard/department-efficiency: for every
 * COMPLETED department issue (actual2 IS NOT NULL) joined to its
 * receipt(s), recovery% = (finishedNet+scrapMetal+dustWeight+metalLoss
 * summed) / issueWeight summed * 100, grouped by the department recorded
 * on the RECEIPT (dept is only ever chosen at return time, not issue
 * time). Kept as raw SQL, matching the real endpoint, since Prisma's
 * query builder can't express this join+groupBy+sum combination cleanly. */
export async function getDepartmentEfficiencyErp(_user: AuthUser): Promise<DepartmentEfficiencyErp[]> {
  const rows = await prisma.$queryRaw<Array<{ groupKey: string; issuedWeight: string; returnedWeight: string }>>`
    SELECT
      dr.dept AS "groupKey",
      SUM(di.issue_weight)::text AS "issuedWeight",
      SUM(dr.finished_net + dr.scrap_metal + dr.dust_weight + dr.metal_loss)::text AS "returnedWeight"
    FROM department_issue_entries di
    JOIN department_receipt_entries dr ON dr.issue_no = di.issue_no
    WHERE di.actual2 IS NOT NULL AND dr.dept IS NOT NULL AND dr.dept <> ''
    GROUP BY dr.dept
  `;

  return rows.map((r) => {
    const issued = parseFloat(r.issuedWeight) || 0;
    const returned = parseFloat(r.returnedWeight) || 0;
    return { dept: r.groupKey, issuedWeight: issued, returnedWeight: returned, recoveryPercent: issued > 0 ? (returned / issued) * 100 : 0 };
  });
}

// ── Karigar recovery ranking ──────────────────────────────────────────────

export type KarigarRankingErp = { karigarName: string; issuedWeight: number; returnedWeight: number; recoveryPercent: number };

/** Same query as GET /dashboard/karigar-rankings: same recovery-% formula
 * as department efficiency, grouped by karigar name instead of dept.
 * Returns the FULL sorted array (best first) — the dashboard slices its
 * own top/bottom N from it, same as the real frontend does. */
export async function getKarigarRankingsErp(_user: AuthUser): Promise<KarigarRankingErp[]> {
  const rows = await prisma.$queryRaw<Array<{ groupKey: string; issuedWeight: string; returnedWeight: string }>>`
    SELECT
      di.karigar_name AS "groupKey",
      SUM(di.issue_weight)::text AS "issuedWeight",
      SUM(dr.finished_net + dr.scrap_metal + dr.dust_weight + dr.metal_loss)::text AS "returnedWeight"
    FROM department_issue_entries di
    JOIN department_receipt_entries dr ON dr.issue_no = di.issue_no
    WHERE di.actual2 IS NOT NULL AND di.karigar_name IS NOT NULL AND di.karigar_name <> ''
    GROUP BY di.karigar_name
  `;

  return rows
    .map((r) => {
      const issued = parseFloat(r.issuedWeight) || 0;
      const returned = parseFloat(r.returnedWeight) || 0;
      return { karigarName: r.groupKey, issuedWeight: issued, returnedWeight: returned, recoveryPercent: issued > 0 ? (returned / issued) * 100 : 0 };
    })
    .filter((r) => r.issuedWeight > 0)
    .sort((a, b) => b.recoveryPercent - a.recoveryPercent);
}

// ── Department issue/receipt summary (pending vs completed) ──────────────

export type DepartmentSummaryErp = {
  pendingCount: number;
  pendingWeight: number;
  completedCount: number;
  completedWeight: number;
  avgRecoveryPercent: number;
};

/** Same query as GET /dashboard/department-summary. */
export async function getDepartmentSummaryErp(_user: AuthUser): Promise<DepartmentSummaryErp> {
  const [pendingCount, pendingWeightAgg, completedRows] = await Promise.all([
    prisma.departmentIssueEntry.count({ where: { actual2: null } }),
    prisma.departmentIssueEntry.aggregate({ where: { actual2: null }, _sum: { issueWeight: true } }),
    prisma.$queryRaw<Array<{ completedCount: string; issuedWeight: string; returnedWeight: string }>>`
      SELECT
        COUNT(DISTINCT di.issue_no)::text AS "completedCount",
        SUM(di.issue_weight)::text AS "issuedWeight",
        SUM(dr.finished_net + dr.scrap_metal + dr.dust_weight + dr.metal_loss)::text AS "returnedWeight"
      FROM department_issue_entries di
      JOIN department_receipt_entries dr ON dr.issue_no = di.issue_no
      WHERE di.actual2 IS NOT NULL
    `,
  ]);

  const issuedWeight = parseFloat(completedRows[0]?.issuedWeight ?? '0') || 0;
  const returnedWeight = parseFloat(completedRows[0]?.returnedWeight ?? '0') || 0;

  return {
    pendingCount,
    pendingWeight: pendingWeightAgg._sum.issueWeight?.toNumber() ?? 0,
    completedCount: parseInt(completedRows[0]?.completedCount ?? '0', 10) || 0,
    completedWeight: returnedWeight,
    avgRecoveryPercent: issuedWeight > 0 ? (returnedWeight / issuedWeight) * 100 : 0,
  };
}

// ── Alloy conversion summary ──────────────────────────────────────────────

export type AlloySummaryErp = {
  total: number;
  avgLossPercent: number;
  overThreshold: number;
  todayCount: number;
  weightToday: number;
  recent: Array<{ serialNo: string; targetKarat: string; batchNumber: string | null; input24K: number; timestamp: string }>;
};

/** Same query as GET /dashboard/alloy-summary — avgLossPercent = AVG of
 * (estimatedLoss/expectedOutput)*100 across every conversion with a
 * positive expected output; overThreshold = count where that ratio
 * exceeds 1%. */
export async function getAlloySummaryErp(_user: AuthUser): Promise<AlloySummaryErp> {
  const [summaryRows, recent] = await Promise.all([
    prisma.$queryRaw<
      Array<{ total: string; avgLossPercent: string; overThreshold: string; todayCount: string; weightToday: string }>
    >`
      SELECT
        COUNT(*)::text AS "total",
        COALESCE(AVG(CASE WHEN expected_output > 0 THEN (estimated_loss / expected_output) * 100 END), 0)::text AS "avgLossPercent",
        COUNT(*) FILTER (WHERE expected_output > 0 AND (estimated_loss / expected_output) * 100 > 1)::text AS "overThreshold",
        COUNT(*) FILTER (WHERE timestamp >= date_trunc('day', now()))::text AS "todayCount",
        COALESCE(SUM(input_24k) FILTER (WHERE timestamp >= date_trunc('day', now())), 0)::text AS "weightToday"
      FROM alloy_conversion_entries
    `,
    prisma.alloyConversionEntry.findMany({
      take: 3,
      orderBy: { timestamp: 'desc' },
      select: { serialNo: true, targetKarat: true, batchNumber: true, input24K: true, timestamp: true },
    }),
  ]);

  const row = summaryRows[0];
  return {
    total: parseInt(row?.total ?? '0', 10) || 0,
    avgLossPercent: parseFloat(row?.avgLossPercent ?? '0') || 0,
    overThreshold: parseInt(row?.overThreshold ?? '0', 10) || 0,
    todayCount: parseInt(row?.todayCount ?? '0', 10) || 0,
    weightToday: parseFloat(row?.weightToday ?? '0') || 0,
    recent: recent.map((r) => ({
      serialNo: r.serialNo,
      targetKarat: r.targetKarat,
      batchNumber: r.batchNumber,
      input24K: r.input24K.toNumber(),
      timestamp: r.timestamp.toISOString(),
    })),
  };
}

// ── Job pipeline (queued / in-progress / ready) ───────────────────────────

export type JobPipelineErp = {
  totalOrders: number;
  queued: number;
  inProgress: number;
  ready: number;
  deptBreakdown: Array<{ dept: string; issuePending: number; issuePendingWeight: number; returnPending: number; returnPendingWeight: number }>;
};

/** Same query as GET /production-planning/stats. queued = planning entries
 * with no department issue raised yet; ready = at least one department
 * issue already has a receipt (actual2 set); inProgress is derived
 * (totalOrders - queued - ready) since the three buckets are mutually
 * exclusive/exhaustive, same as the real endpoint. */
export async function getJobPipelineErp(_user: AuthUser): Promise<JobPipelineErp> {
  const [totalOrders, issuePendingRows, returnPendingRows, queued, ready] = await Promise.all([
    prisma.productionPlanningEntry.count(),
    prisma.productionPlanningEntry.groupBy({
      by: ['dept'],
      where: { status: { equals: 'pending', mode: 'insensitive' } },
      _count: { _all: true },
      _sum: { remainingWeight: true },
    }),
    prisma.departmentIssueEntry.groupBy({
      by: ['dept'],
      where: { receipts: { none: {} } },
      _count: { _all: true },
      _sum: { issueWeight: true },
    }),
    prisma.productionPlanningEntry.count({ where: { departmentIssues: { none: {} } } }),
    prisma.productionPlanningEntry.count({ where: { departmentIssues: { some: { actual2: { not: null } } } } }),
  ]);

  const allDepts = Array.from(
    new Set([...issuePendingRows.map((r) => r.dept), ...returnPendingRows.map((r) => r.dept ?? '')]),
  ).filter((d): d is string => Boolean(d && d.trim()));

  const deptBreakdown = allDepts.map((dept) => {
    const ip = issuePendingRows.find((r) => r.dept === dept);
    const rp = returnPendingRows.find((r) => r.dept === dept);
    return {
      dept,
      issuePending: ip?._count._all ?? 0,
      issuePendingWeight: ip?._sum.remainingWeight?.toNumber() ?? 0,
      returnPending: rp?._count._all ?? 0,
      returnPendingWeight: rp?._sum.issueWeight?.toNumber() ?? 0,
    };
  });

  return { totalOrders, queued, ready, inProgress: Math.max(0, totalOrders - queued - ready), deptBreakdown };
}

// ── Recent activity feed ──────────────────────────────────────────────────

export type RecentActivityErp = {
  issueNo: string;
  dept: string | null;
  issueWeight: number;
  karigarName: string;
  meltingType: string | null;
  timestamp: string;
  received: boolean;
};

/** Same query as GET /dashboard/recent-activity — last 8 department
 * issues, newest first, no aggregation. */
export async function getRecentActivityErp(_user: AuthUser): Promise<RecentActivityErp[]> {
  const rows = await prisma.departmentIssueEntry.findMany({
    take: 8,
    orderBy: { timestamp: 'desc' },
    select: { issueNo: true, dept: true, issueWeight: true, karigarName: true, meltingType: true, timestamp: true, actual2: true },
  });
  return rows.map((r) => ({
    issueNo: r.issueNo,
    dept: r.dept,
    issueWeight: r.issueWeight.toNumber(),
    karigarName: r.karigarName,
    meltingType: r.meltingType,
    timestamp: r.timestamp.toISOString(),
    received: r.actual2 != null,
  }));
}

// ── Orders summary (factory/O2D orders, ERP's own view of them) ──────────

export type OrdersSummaryErp = { total: number; normal: number; urgent: number; stock: number; totalWeight: number };

/** Same query as GET /dashboard/orders-summary — counts O2D's own Order
 * table by orderType, restricted to factory-karigar orders (no branch/
 * Raipur-only scoping applied here since this dashboard has no per-branch
 * user concept — see erpBranchScope.ts's raipurOrderWhere() in the real
 * backend for that nuance, intentionally not replicated here). */
export async function getOrdersSummaryErp(_user: AuthUser): Promise<OrdersSummaryErp> {
  const byType = await prisma.order.groupBy({
    by: ['orderType'],
    _count: true,
  });

  const countFor = (type: string) => byType.find((r) => r.orderType === type)?._count ?? 0;
  const normal = countFor('NORMAL');
  const urgent = countFor('URGENT');
  const stock = countFor('STOCK');

  const weightRows = await prisma.$queryRaw<Array<{ totalWeight: string }>>`
    SELECT COALESCE(SUM(COALESCE(o."totalWeight", 0)), 0)::text AS "totalWeight"
    FROM "Order" o
  `;

  return { total: normal + urgent + stock, normal, urgent, stock, totalWeight: parseFloat(weightRows[0]?.totalWeight ?? '0') || 0 };
}

// ── Urgent/alert thresholds (client-derived in the real frontend too — no
// dedicated endpoint, just threshold checks on data already fetched) ──────

export type UrgentAlertErp = { message: string; severity: 'high' | 'medium' };

export function deriveUrgentAlertsErp(stock: MetalStockSummary): UrgentAlertErp[] {
  const alerts: UrgentAlertErp[] = [];
  if (stock.stock24K < 100) alerts.push({ message: 'Low Stock: 24K Gold at a critical level', severity: 'high' });
  if (stock.conversionLoss > 1.5) alerts.push({ message: 'Efficiency Warning: high conversion loss recorded', severity: 'medium' });
  return alerts;
}

// ── Combined summary for the fixed dashboard load (mirrors getSummary's
// role in the other two tools*.ts files, but ERP's "top-line" is metal
// stock + job pipeline rather than order counts) ─────────────────────────

export type SummaryErp = {
  stock: MetalStockSummary;
  pipeline: JobPipelineErp;
  alerts: UrgentAlertErp[];
};

export async function getSummaryErp(user: AuthUser): Promise<SummaryErp> {
  const [stock, pipeline] = await Promise.all([getMetalStockSummaryErp(user), getJobPipelineErp(user)]);
  return { stock, pipeline, alerts: deriveUrgentAlertsErp(stock) };
}
