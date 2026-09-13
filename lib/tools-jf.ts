import { prismaJf } from './prisma-jf';
import type { OrderStatus, CustomOrderStatus } from '../node_modules/.prisma/client-jf';
import type { AuthUser } from './auth';

// ── Jewel Factory's read-only "tool" functions — same shape/purpose as
// lib/tools.ts (O2D), added 2026-09-13. Every function here does ONLY a
// Prisma find*/count/groupBy read against prismaJf (see prisma/jewel-
// factory/schema.prisma and lib/prisma-jf.ts) — no writes, ever.
//
// Jewel Factory has THREE order tables (B2bOrder = "Catalogue order",
// KioskOrder = "Store Customer order", CustomDesignOrder = "Customised
// order") where O2D has just one `Order` table. Jewel Factory's own
// manufacturer portal merges all three into one list for the same reason
// this file does: from the manufacturer's point of view they're all just
// "orders I need to produce and ship," regardless of which of the three
// intake paths created them.
//
// SCOPE: there is no per-manufacturer login for this AI service (unlike
// O2D's branch-scoped ADMIN/SUPER_ADMIN) — Jewel Factory only has ONE
// manufacturer using this dashboard in practice, so every query here reads
// across the whole table with no manufacturerId filter. If a second
// manufacturer ever needs this dashboard, add a manufacturerId scope here
// the same way branchScope() does it in tools.ts.
//
// PRIVACY: matches Jewel Factory's own "manufacturer never sees customer
// PII" rule — no query here selects KioskOrder.customerName/Phone/Email or
// deliveryAddress even though those columns exist in the real database
// (they're not even declared in prisma/jewel-factory/schema.prisma, so
// they're structurally impossible to select by accident).
//
// O2D LINKAGE: a CustomDesignOrder with o2dOrderId set has already been
// forwarded to O2D — its REAL production tracking now lives in O2D's own
// Order table (the O2D tab of this same dashboard), not here. Every
// "active"/"delayed" query below excludes o2d-linked custom orders, so the
// same underlying piece of work is never double-counted across both tabs.

type UnifiedOrder = {
  id: string;
  orderNo: string;
  kind: 'Catalogue' | 'Store Customer' | 'Customised';
  storeName: string;
  status: string;
  stage: string; // status for B2b/Kiosk; orderStage (falls back to status) for Custom
  karigarCode: string | null;
  deliveryDate: Date | null;
  createdAt: Date;
};

const TERMINAL_STATUSES: (OrderStatus | CustomOrderStatus)[] = ['COMPLETED', 'CANCELLED'];

/** Fetches every order across all three tables not yet in a terminal status,
 * and not yet forwarded to O2D (see file header), normalized to one shape. */
async function fetchActiveUnifiedOrders(): Promise<UnifiedOrder[]> {
  const [b2b, kiosk, custom] = await Promise.all([
    prismaJf.b2bOrder.findMany({
      where: { status: { notIn: TERMINAL_STATUSES as OrderStatus[] } },
      select: {
        id: true,
        storeId: true,
        orderNumber: true,
        status: true,
        deliveryDate: true,
        createdAt: true,
        items: { select: { customisedOrder: { select: { karigarCode: true } } }, take: 1 },
      },
    }),
    prismaJf.kioskOrder.findMany({
      where: { status: { notIn: TERMINAL_STATUSES } },
      select: {
        id: true,
        orderNumber: true,
        storeNameSnapshot: true,
        status: true,
        deliveryDate: true,
        createdAt: true,
        items: { select: { customisedOrder: { select: { karigarCode: true } } }, take: 1 },
      },
    }),
    prismaJf.customDesignOrder.findMany({
      where: { status: { notIn: TERMINAL_STATUSES }, o2dOrderId: null },
      select: {
        id: true,
        orderNumber: true,
        storeNameSnapshot: true,
        status: true,
        orderStage: true,
        karigarCode: true,
        deliveryDate: true,
        createdAt: true,
      },
    }),
  ]);

  // B2bOrder itself has no denormalized store name column in the minimal
  // schema (see prisma/jewel-factory/schema.prisma) — resolve it via a
  // single batched Store lookup rather than one query per order.
  const b2bStoreIds = [...new Set(b2b.map((o) => o.storeId))];
  const stores = b2bStoreIds.length
    ? await prismaJf.store.findMany({ where: { id: { in: b2bStoreIds } }, select: { id: true, name: true } })
    : [];
  const storeNameById = new Map(stores.map((s) => [s.id, s.name]));

  const unified: UnifiedOrder[] = [
    ...b2b.map((o) => ({
      id: o.id,
      orderNo: o.orderNumber,
      kind: 'Catalogue' as const,
      storeName: storeNameById.get(o.storeId) ?? 'Unknown',
      status: o.status,
      stage: o.status,
      karigarCode: o.items[0]?.customisedOrder?.karigarCode ?? null,
      deliveryDate: o.deliveryDate,
      createdAt: o.createdAt,
    })),
    ...kiosk.map((o) => ({
      id: o.id,
      orderNo: o.orderNumber,
      kind: 'Store Customer' as const,
      storeName: o.storeNameSnapshot,
      status: o.status,
      stage: o.status,
      karigarCode: o.items[0]?.customisedOrder?.karigarCode ?? null,
      deliveryDate: o.deliveryDate,
      createdAt: o.createdAt,
    })),
    ...custom.map((o) => ({
      id: o.id,
      orderNo: o.orderNumber,
      kind: 'Customised' as const,
      storeName: o.storeNameSnapshot,
      status: o.status,
      stage: o.orderStage?.trim() || o.status,
      karigarCode: o.karigarCode,
      deliveryDate: o.deliveryDate,
      createdAt: o.createdAt,
    })),
  ];

  return unified;
}

export type DelayedOrderJf = {
  orderNo: string;
  kind: string;
  stage: string;
  storeName: string;
  karigarCode: string | null;
  dueDate: string | null;
  daysLate: number;
};

/** Every non-terminal order (Catalogue/Store Customer/Customised) whose
 * deliveryDate has passed. B2bOrder needs a store name resolved via a
 * batched Store lookup since the minimal schema doesn't denormalize it. */
export async function getDelayedOrdersJf(_user: AuthUser, limit = 100): Promise<DelayedOrderJf[]> {
  const now = new Date();
  const orders = await fetchActiveUnifiedOrders();
  return orders
    .filter((o) => o.deliveryDate && o.deliveryDate < now)
    .sort((a, b) => (a.deliveryDate?.getTime() ?? 0) - (b.deliveryDate?.getTime() ?? 0))
    .slice(0, limit)
    .map((o) => ({
      orderNo: o.orderNo,
      kind: o.kind,
      stage: o.stage,
      storeName: o.storeName,
      karigarCode: o.karigarCode,
      dueDate: o.deliveryDate ? o.deliveryDate.toISOString().slice(0, 10) : null,
      daysLate: o.deliveryDate ? Math.floor((now.getTime() - o.deliveryDate.getTime()) / 86_400_000) : 0,
    }));
}

export type StageBottleneckJf = {
  stage: string;
  orderCount: number;
  oldestOrderNo: string | null;
  oldestOrderAgeDays: number | null;
};

/** Groups every non-terminal order by its stage (status for Catalogue/Store
 * Customer orders; free-text orderStage, falling back to status, for
 * Customised orders) — same "where's the pile-up" signal as O2D's version. */
export async function getStageBottlenecksJf(_user: AuthUser): Promise<StageBottleneckJf[]> {
  const now = new Date();
  const orders = await fetchActiveUnifiedOrders();

  const byStage = new Map<string, { count: number; oldestOrderNo: string; oldestCreatedAt: Date }>();
  for (const o of orders) {
    const existing = byStage.get(o.stage);
    if (!existing) {
      byStage.set(o.stage, { count: 1, oldestOrderNo: o.orderNo, oldestCreatedAt: o.createdAt });
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

export type KarigarLoadJf = {
  karigarCode: string;
  activeOrderCount: number;
  delayedOrderCount: number;
};

/** How many non-terminal orders currently carry each karigarCode — Jewel
 * Factory's Karigar model has no separate display name (code IS the
 * identifier, see prisma/jewel-factory/schema.prisma), unlike O2D's
 * Karigar.name + Karigar.code pair. */
export async function getKarigarLoadJf(_user: AuthUser, karigarCode?: string): Promise<KarigarLoadJf[]> {
  const now = new Date();
  const orders = await fetchActiveUnifiedOrders();

  const byKarigar = new Map<string, { active: number; delayed: number }>();
  for (const o of orders) {
    if (!o.karigarCode) continue;
    if (karigarCode && !o.karigarCode.toLowerCase().includes(karigarCode.toLowerCase())) continue;
    const isLate = o.deliveryDate != null && o.deliveryDate < now;
    const existing = byKarigar.get(o.karigarCode);
    if (!existing) {
      byKarigar.set(o.karigarCode, { active: 1, delayed: isLate ? 1 : 0 });
    } else {
      existing.active++;
      if (isLate) existing.delayed++;
    }
  }

  return Array.from(byKarigar.entries())
    .map(([code, v]) => ({ karigarCode: code, activeOrderCount: v.active, delayedOrderCount: v.delayed }))
    .sort((a, b) => b.activeOrderCount - a.activeOrderCount);
}

export type OrderLookupResultJf = {
  orderNo: string;
  kind: string;
  stage: string;
  status: string;
  storeName: string;
  karigarCode: string | null;
  dueDate: string | null;
  createdAt: string;
};

/** Look up one specific order by its exact order number across all three
 * tables (e.g. "JFC-0042", a B2B-YYYYMMDD-XXXX number, or a GK-... number). */
export async function getOrderByNumberJf(_user: AuthUser, orderNo: string): Promise<OrderLookupResultJf | null> {
  const [b2b, kiosk, custom] = await Promise.all([
    prismaJf.b2bOrder.findFirst({ where: { orderNumber: orderNo } }),
    prismaJf.kioskOrder.findFirst({ where: { orderNumber: orderNo } }),
    prismaJf.customDesignOrder.findFirst({ where: { orderNumber: orderNo } }),
  ]);

  if (b2b) {
    const store = await prismaJf.store.findUnique({ where: { id: b2b.storeId }, select: { name: true } });
    return {
      orderNo: b2b.orderNumber,
      kind: 'Catalogue',
      stage: b2b.status,
      status: b2b.status,
      storeName: store?.name ?? 'Unknown',
      karigarCode: null,
      dueDate: b2b.deliveryDate ? b2b.deliveryDate.toISOString().slice(0, 10) : null,
      createdAt: b2b.createdAt.toISOString(),
    };
  }
  if (kiosk) {
    return {
      orderNo: kiosk.orderNumber,
      kind: 'Store Customer',
      stage: kiosk.status,
      status: kiosk.status,
      storeName: kiosk.storeNameSnapshot,
      karigarCode: null,
      dueDate: kiosk.deliveryDate ? kiosk.deliveryDate.toISOString().slice(0, 10) : null,
      createdAt: kiosk.createdAt.toISOString(),
    };
  }
  if (custom) {
    return {
      orderNo: custom.orderNumber,
      kind: 'Customised',
      stage: custom.orderStage?.trim() || custom.status,
      status: custom.status,
      storeName: custom.storeNameSnapshot,
      karigarCode: custom.karigarCode,
      dueDate: custom.deliveryDate ? custom.deliveryDate.toISOString().slice(0, 10) : null,
      createdAt: custom.createdAt.toISOString(),
    };
  }
  return null;
}

export type SearchFiltersJf = {
  storeName?: string;
  karigarCode?: string;
  kind?: 'Catalogue' | 'Store Customer' | 'Customised';
  status?: 'PENDING' | 'IN_PROCESS' | 'GHAT_RECEIVED' | 'READY_FOR_DELIVERY' | 'DISPATCHED' | 'COMPLETED' | 'CANCELLED';
  urgent?: boolean;
};

/** General-purpose, multi-filter order search across all three order types —
 * catch-all for a free-text question that doesn't fit the fixed insights. */
export async function searchOrdersJf(_user: AuthUser, filters: SearchFiltersJf, limit = 50): Promise<DelayedOrderJf[]> {
  const now = new Date();
  let orders = await fetchActiveUnifiedOrders();

  if (filters.kind) orders = orders.filter((o) => o.kind === filters.kind);
  if (filters.status) orders = orders.filter((o) => o.status === filters.status);
  if (filters.storeName) orders = orders.filter((o) => o.storeName.toLowerCase().includes(filters.storeName!.toLowerCase()));
  if (filters.karigarCode) orders = orders.filter((o) => o.karigarCode?.toLowerCase().includes(filters.karigarCode!.toLowerCase()));

  return orders
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit)
    .map((o) => ({
      orderNo: o.orderNo,
      kind: o.kind,
      stage: o.stage,
      storeName: o.storeName,
      karigarCode: o.karigarCode,
      dueDate: o.deliveryDate ? o.deliveryDate.toISOString().slice(0, 10) : null,
      daysLate: o.deliveryDate && o.deliveryDate < now ? Math.floor((now.getTime() - o.deliveryDate.getTime()) / 86_400_000) : 0,
    }));
}

export type SummaryJf = { totalActive: number; totalDelayed: number; totalUrgent: number; totalCompletedToday: number };

/** Quick top-line counts across all three order types, mirroring O2D's getSummary shape. */
export async function getSummaryJf(_user: AuthUser): Promise<SummaryJf> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const orders = await fetchActiveUnifiedOrders();
  const totalActive = orders.length;
  const totalDelayed = orders.filter((o) => o.deliveryDate && o.deliveryDate < now).length;

  const [totalUrgent, totalCompletedToday] = await Promise.all([
    prismaJf.customDesignOrder.count({ where: { urgent: true, status: { notIn: TERMINAL_STATUSES } } }),
    Promise.all([
      // updatedAt (not createdAt) — an order placed earlier and only
      // completed today should still count as "completed today".
      prismaJf.b2bOrder.count({ where: { status: 'COMPLETED', updatedAt: { gte: todayStart } } }),
      prismaJf.kioskOrder.count({ where: { status: 'COMPLETED', updatedAt: { gte: todayStart } } }),
      prismaJf.customDesignOrder.count({ where: { status: 'COMPLETED', updatedAt: { gte: todayStart } } }),
    ]).then(([a, b, c]) => a + b + c),
  ]);

  return { totalActive, totalDelayed, totalUrgent, totalCompletedToday };
}
