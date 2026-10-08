import { prisma } from './prisma';
import { branchScope } from './tools';
import type { AuthUser } from './auth';

// ── Stage-wise TAT (turnaround time) delays — READ-ONLY ─────────────────────
//
// Requested by the CEO: flag an order as delayed when it has sat in a stage
// group longer than that group's limit, so the incharge sees where to focus.
//
//   Metal issue : order still waiting at "In Process" (no metal issued yet)  > 2 days
//   Production  : order with the karigar at "Follow Up" (until Ghat Jama)     > 5 days
//   Finishing   : Meena / Polish / Bangle Polish / E-Polish stages            > 2 days
//
// ASSUMPTIONS (mapping of the CEO's words to O2D's real stage strings — confirm
// with him, then edit TAT_RULES below; nothing else needs to change):
//   - "Metal issue" = currentStage "In Process" (O2D's Metal Issue pending tab).
//   - "Production"  = currentStage "Follow Up".
//   - "Finishing"   = the Meena + Polish family of stages.
//   - Days are calendar days (24h blocks), not working days.
//   - "Customer order vs stock order" = Order.orderType STOCK vs everything else.
//
// "Time in stage" = now minus the newest ProcessHistory row's createdAt (a stage
// submission is what moves an order into its next stage), falling back to the
// order's createdAt when it has no history yet. It is an approximation for
// stages that don't advance on submit (e.g. Meena Submit).

export type TatRuleKey = 'METAL_ISSUE' | 'PRODUCTION' | 'FINISHING';

type TatRule = { key: TatRuleKey; label: string; stages: string[]; limitDays: number };

export const TAT_RULES: TatRule[] = [
  { key: 'METAL_ISSUE', label: 'Metal issue', stages: ['In Process'], limitDays: 2 },
  { key: 'PRODUCTION', label: 'Production', stages: ['Follow Up'], limitDays: 5 },
  {
    key: 'FINISHING',
    label: 'Finishing',
    stages: [
      'Meena Inhouse',
      'Meena Outside',
      'Meena Submit',
      'Polish Inhouse',
      'Polish Outside',
      'Polish Submit',
      'Bangle Polish',
      'Bangle Polish Submit',
      'E-Polish',
    ],
    limitDays: 2,
  },
];

export type OrderKind = 'Customer' | 'Stock';

export type TatDelay = {
  orderNo: string;
  stage: string;
  rule: TatRuleKey;
  ruleLabel: string;
  orderKind: OrderKind;
  orderType: string;
  karigarName: string | null;
  companyName: string;
  daysInStage: number;
  limitDays: number;
  daysOver: number;
};

/** One of the top "look at this first" orders, with a data-derived suggestion. */
export type TatPriorityItem = TatDelay & { suggestion: string };

export type TatStageInsight = {
  rule: TatRuleKey;
  ruleLabel: string;
  stage: string;
  count: number;
  worstOrderNo: string;
  maxDaysOver: number;
  suggestion: string;
};

export type TatKarigarInsight = {
  karigarName: string;
  delayedCount: number;
  worstOrderNo: string;
  maxDaysOver: number;
  suggestion: string;
};

/** Read-only analysis built ONLY from the delayed-order data — every number and
 * order/karigar name comes from the database, and every suggestion is a plain
 * "look at / follow up" pointer. Nothing here changes any order. */
export type TatAnalysis = {
  priority: TatPriorityItem[];
  byStage: TatStageInsight[];
  byKarigar: TatKarigarInsight[];
  actionPlan: string[];
};

export type TatDelaysResult = {
  rules: Array<{ key: TatRuleKey; label: string; stages: string[]; limitDays: number }>;
  total: number;
  byRule: Record<TatRuleKey, number>;
  byKind: Record<OrderKind, number>;
  analysis: TatAnalysis;
  delays: TatDelay[];
};

export type TatFilters = { rule?: TatRuleKey; orderKind?: OrderKind };

const DAY_MS = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Urgent orders and customer orders float above equally-late stock orders. */
function priorityScore(d: TatDelay): number {
  return d.daysOver + (d.orderType === 'URGENT' ? 5 : 0) + (d.orderKind === 'Customer' ? 1 : 0);
}

function orderSuggestion(d: TatDelay): string {
  switch (d.rule) {
    case 'METAL_ISSUE':
      return `Issue metal for ${d.orderNo} today — waiting ${d.daysInStage}d at ${d.stage} (limit ${d.limitDays}d).`;
    case 'PRODUCTION':
      return `Follow up with ${d.karigarName ?? 'the karigar'} on ${d.orderNo} — ${d.daysInStage}d at ${d.stage} (limit ${d.limitDays}d).`;
    case 'FINISHING':
      return `Check ${d.stage} for ${d.orderNo} — ${d.daysInStage}d (limit ${d.limitDays}d); get it moved to the next stage.`;
  }
}

function stageSuggestion(rule: TatRuleKey, stage: string, count: number): string {
  switch (rule) {
    case 'METAL_ISSUE':
      return `Clear the metal-issue queue first: ${count} order${count === 1 ? '' : 's'} still waiting at ${stage}.`;
    case 'PRODUCTION':
      return `Review karigar progress: ${count} order${count === 1 ? '' : 's'} stuck at ${stage}.`;
    case 'FINISHING':
      return `Check the finishing floor: ${count} order${count === 1 ? '' : 's'} stuck at ${stage}.`;
  }
}

function buildAnalysis(delays: TatDelay[]): TatAnalysis {
  const priority: TatPriorityItem[] = [...delays]
    .sort((a, b) => priorityScore(b) - priorityScore(a))
    .slice(0, 5)
    .map((d) => ({ ...d, suggestion: orderSuggestion(d) }));

  const stageMap = new Map<string, TatStageInsight>();
  for (const d of delays) {
    const existing = stageMap.get(d.stage);
    if (!existing) {
      stageMap.set(d.stage, { rule: d.rule, ruleLabel: d.ruleLabel, stage: d.stage, count: 1, worstOrderNo: d.orderNo, maxDaysOver: d.daysOver, suggestion: '' });
    } else {
      existing.count++;
      if (d.daysOver > existing.maxDaysOver) {
        existing.maxDaysOver = d.daysOver;
        existing.worstOrderNo = d.orderNo;
      }
    }
  }
  const byStage = Array.from(stageMap.values())
    .map((s) => ({ ...s, suggestion: stageSuggestion(s.rule, s.stage, s.count) }))
    .sort((a, b) => b.count - a.count || b.maxDaysOver - a.maxDaysOver);

  const karigarMap = new Map<string, TatKarigarInsight>();
  for (const d of delays) {
    if (!d.karigarName) continue;
    const existing = karigarMap.get(d.karigarName);
    if (!existing) {
      karigarMap.set(d.karigarName, { karigarName: d.karigarName, delayedCount: 1, worstOrderNo: d.orderNo, maxDaysOver: d.daysOver, suggestion: '' });
    } else {
      existing.delayedCount++;
      if (d.daysOver > existing.maxDaysOver) {
        existing.maxDaysOver = d.daysOver;
        existing.worstOrderNo = d.orderNo;
      }
    }
  }
  const byKarigar = Array.from(karigarMap.values())
    .map((k) => ({
      ...k,
      suggestion:
        k.delayedCount >= 3
          ? `${k.delayedCount} delayed orders with ${k.karigarName} — hold new work for them until these are cleared; start with ${k.worstOrderNo}.`
          : `Follow up with ${k.karigarName} on ${k.worstOrderNo} (${k.maxDaysOver}d over the limit).`,
    }))
    .sort((a, b) => b.delayedCount - a.delayedCount || b.maxDaysOver - a.maxDaysOver)
    .slice(0, 5);

  const actionPlan: string[] = [];
  if (priority[0]) actionPlan.push(priority[0].suggestion);
  if (byStage[0]) actionPlan.push(byStage[0].suggestion);
  if (byKarigar[0]) actionPlan.push(byKarigar[0].suggestion);
  const urgentCount = delays.filter((d) => d.orderType === 'URGENT').length;
  if (urgentCount > 0) actionPlan.push(`${urgentCount} urgent order${urgentCount === 1 ? ' is' : 's are'} past the TAT limit — review these before the others.`);
  const stockCount = delays.filter((d) => d.orderKind === 'Stock').length;
  if (stockCount > 0 && stockCount === delays.length) actionPlan.push('All delays are stock orders — no customer order is currently past its TAT limit.');

  return { priority, byStage, byKarigar, actionPlan };
}

/**
 * Every ACTIVE order that has been in its current stage longer than that
 * stage group's TAT limit, most overdue first. `limit` only caps the returned
 * list — the counts in `total`/`byRule`/`byKind` always cover every delayed
 * order.
 */
export async function getTatDelays(user: AuthUser, filters: TatFilters = {}, limit = 100): Promise<TatDelaysResult> {
  const now = Date.now();
  const rules = filters.rule ? TAT_RULES.filter((r) => r.key === filters.rule) : TAT_RULES;
  const stageToRule = new Map<string, TatRule>();
  for (const r of rules) for (const s of r.stages) stageToRule.set(s, r);

  const orders = await prisma.order.findMany({
    where: {
      ...branchScope(user),
      status: 'ACTIVE',
      currentStage: { in: Array.from(stageToRule.keys()) },
      ...(filters.orderKind === 'Stock' ? { orderType: 'STOCK' } : filters.orderKind === 'Customer' ? { orderType: { not: 'STOCK' } } : {}),
    },
    select: {
      orderNo: true,
      currentStage: true,
      orderType: true,
      createdAt: true,
      karigar: { select: { name: true } },
      company: { select: { name: true } },
      processHistory: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
    },
  });

  const delays: TatDelay[] = [];
  for (const o of orders) {
    const rule = stageToRule.get(o.currentStage);
    if (!rule) continue;
    const enteredAt = (o.processHistory[0]?.createdAt ?? o.createdAt).getTime();
    const daysInStage = (now - enteredAt) / DAY_MS;
    if (daysInStage <= rule.limitDays) continue;
    delays.push({
      orderNo: o.orderNo,
      stage: o.currentStage,
      rule: rule.key,
      ruleLabel: rule.label,
      orderKind: o.orderType === 'STOCK' ? 'Stock' : 'Customer',
      orderType: o.orderType,
      karigarName: o.karigar?.name ?? null,
      companyName: o.company.name,
      daysInStage: round1(daysInStage),
      limitDays: rule.limitDays,
      daysOver: round1(daysInStage - rule.limitDays),
    });
  }

  delays.sort((a, b) => b.daysOver - a.daysOver);

  const byRule: Record<TatRuleKey, number> = { METAL_ISSUE: 0, PRODUCTION: 0, FINISHING: 0 };
  const byKind: Record<OrderKind, number> = { Customer: 0, Stock: 0 };
  for (const d of delays) {
    byRule[d.rule]++;
    byKind[d.orderKind]++;
  }

  return {
    rules: TAT_RULES.map(({ key, label, stages, limitDays }) => ({ key, label, stages, limitDays })),
    total: delays.length,
    byRule,
    byKind,
    analysis: buildAnalysis(delays),
    delays: delays.slice(0, limit),
  };
}
