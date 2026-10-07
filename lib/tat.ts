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

export type TatDelaysResult = {
  rules: Array<{ key: TatRuleKey; label: string; stages: string[]; limitDays: number }>;
  total: number;
  byRule: Record<TatRuleKey, number>;
  byKind: Record<OrderKind, number>;
  delays: TatDelay[];
};

export type TatFilters = { rule?: TatRuleKey; orderKind?: OrderKind };

const DAY_MS = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

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
    delays: delays.slice(0, limit),
  };
}
