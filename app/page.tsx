'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Boxes, Clock, Factory, Hammer, Loader2, LogOut, MessageCircle, RefreshCw, Send, Sparkles, Truck, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { clearToken, fetchInsights, getToken, sendChatStream, type Source } from '@/lib/client-api';
import type { DelayedOrder, KarigarLoad, StageBottleneck, Summary } from '@/lib/tools';
import type { DelayedOrderJf, KarigarLoadJf, StageBottleneckJf, SummaryJf } from '@/lib/tools-jf';
import type {
  MetalStockSummary,
  DepartmentEfficiencyErp,
  KarigarRankingErp,
  DepartmentSummaryErp,
  AlloySummaryErp,
  JobPipelineErp,
  RecentActivityErp,
  OrdersSummaryErp,
  UrgentAlertErp,
} from '@/lib/tools-erp';

// O2D and Jewel Factory share one dashboard shape ("customer order"
// concepts: delayed orders, stage bottlenecks, karigar load) — their
// slightly different field names (companyName vs storeName,
// karigarName+karigarCode vs karigarCode-only) are normalized into this
// one shared display shape right after fetching. ERP's data is genuinely
// different (metal/production flow, not orders) and gets its own entirely
// separate rendering path — see ErpSection below — rather than being
// forced through this shape.
type DisplayOrder = { orderNo: string; primaryLabel: string; subLabel: string; daysLate: number };
type DisplayKarigar = { key: string; label: string; activeOrderCount: number; delayedOrderCount: number };
type DisplayBottleneck = { key: string; stage: string; count: number; oldestRef: string | null; oldestAgeDays: number | null };

type StandardInsightsData = {
  summary: Summary | SummaryJf;
  delayedOrders: DisplayOrder[];
  stageBottlenecks: DisplayBottleneck[];
  karigarLoad: DisplayKarigar[];
  narrative: string | null;
};

type ErpInsightsData = {
  stock: MetalStockSummary;
  departmentEfficiency: DepartmentEfficiencyErp[];
  karigarRankings: KarigarRankingErp[];
  departmentSummary: DepartmentSummaryErp;
  alloySummary: AlloySummaryErp;
  jobPipeline: JobPipelineErp;
  recentActivity: RecentActivityErp[];
  ordersSummary: OrdersSummaryErp;
  alerts: UrgentAlertErp[];
  narrative: string | null;
};

function normalizeDelayedOrders(source: 'o2d' | 'jf', rows: DelayedOrder[] | DelayedOrderJf[]): DisplayOrder[] {
  if (source === 'jf') {
    return (rows as DelayedOrderJf[]).map((o) => ({
      orderNo: o.orderNo,
      primaryLabel: `${o.orderNo} · ${o.storeName}`,
      subLabel: `${o.kind} · ${o.stage}${o.karigarCode ? ` · ${o.karigarCode}` : ''}`,
      daysLate: o.daysLate,
    }));
  }
  return (rows as DelayedOrder[]).map((o) => ({
    orderNo: o.orderNo,
    primaryLabel: `${o.orderNo} · ${o.companyName}`,
    subLabel: `${o.stage}${o.karigarName ? ` · ${o.karigarName}` : ''}`,
    daysLate: o.daysLate,
  }));
}

function normalizeStageBottlenecks(rows: StageBottleneck[] | StageBottleneckJf[]): DisplayBottleneck[] {
  return rows.map((s) => ({ key: s.stage, stage: s.stage, count: s.orderCount, oldestRef: s.oldestOrderNo, oldestAgeDays: s.oldestOrderAgeDays }));
}

function normalizeKarigarLoad(source: 'o2d' | 'jf', rows: KarigarLoad[] | KarigarLoadJf[]): DisplayKarigar[] {
  if (source === 'jf') {
    return (rows as KarigarLoadJf[]).map((k) => ({
      key: k.karigarCode,
      label: k.karigarCode,
      activeOrderCount: k.activeOrderCount,
      delayedOrderCount: k.delayedOrderCount,
    }));
  }
  return (rows as KarigarLoad[]).map((k) => ({
    key: k.karigarId,
    label: `${k.karigarName} (${k.karigarCode})`,
    activeOrderCount: k.activeOrderCount,
    delayedOrderCount: k.delayedOrderCount,
  }));
}

type ChatMsg = { role: 'user' | 'assistant'; content: string };

const SOURCES: { value: Source; label: string }[] = [
  { value: 'o2d', label: 'Order to Delivery' },
  { value: 'jf', label: 'Jewel Factory' },
  { value: 'erp', label: 'ERP' },
];

// Chart colors — kept to the amber/neutral palette already used across
// this app's theme (see globals.css) rather than introducing a clashing
// chart-library default palette.
const CHART_COLORS = { primary: '#c9862f', muted: '#a3a3a3', danger: '#dc2626', good: '#059669', sky: '#0284c7' };
const PIPELINE_COLORS = [CHART_COLORS.sky, CHART_COLORS.muted, CHART_COLORS.good];

export default function DashboardPage() {
  const router = useRouter();
  const [chatSource, setChatSource] = useState<Source>('o2d');
  const [o2dData, setO2dData] = useState<StandardInsightsData | null>(null);
  const [jfData, setJfData] = useState<StandardInsightsData | null>(null);
  const [erpData, setErpData] = useState<ErpInsightsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<string>('section-o2d');
  const chatEndRef = useRef<HTMLDivElement>(null);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      // All three sources load in parallel — this is a unified,
      // single-page view now (no more tab-switch-triggered fetch), so every
      // source's data needs to be on screen at once.
      const [o2d, jf, erp] = await Promise.all([fetchInsights('o2d'), fetchInsights('jf'), fetchInsights('erp')]);
      setO2dData({
        ...o2d,
        delayedOrders: normalizeDelayedOrders('o2d', o2d.delayedOrders),
        stageBottlenecks: normalizeStageBottlenecks(o2d.stageBottlenecks),
        karigarLoad: normalizeKarigarLoad('o2d', o2d.karigarLoad),
      });
      setJfData({
        ...jf,
        delayedOrders: normalizeDelayedOrders('jf', jf.delayedOrders),
        stageBottlenecks: normalizeStageBottlenecks(jf.stageBottlenecks),
        karigarLoad: normalizeKarigarLoad('jf', jf.karigarLoad),
      });
      setErpData(erp as ErpInsightsData);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load insights');
      setO2dData(null);
      setJfData(null);
      setErpData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Mirrors lib/auth.ts's server-side SKIP_AUTH_IN_DEV bypass — without
    // this, the frontend would redirect to /login before ever calling the
    // API, even though the backend would have accepted the request anyway
    // with no token at all while the bypass is on.
    const bypassActive = process.env.NEXT_PUBLIC_SKIP_AUTH_IN_DEV === 'true';
    if (!bypassActive && !getToken()) {
      router.replace('/login');
      return;
    }
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  useEffect(() => {
    // Highlights whichever source's section is currently in view in the
    // left sidebar, so it stays in sync with scroll position rather than
    // only updating on a manual nav click.
    const ids = ['section-o2d', 'section-jf', 'section-erp'];
    const elements = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveSection(visible[0].target.id);
      },
      { rootMargin: '-100px 0px -70% 0px', threshold: 0 },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [o2dData, jfData, erpData]);

  function switchChatSource(next: Source) {
    if (next === chatSource) return;
    setChatSource(next);
    // Chat is scoped to whichever source is picked in its own dropdown (see
    // lib/openai.ts's Source-keyed tool schemas) — clearing history on
    // switch avoids a stale question/answer from one source's data sitting
    // next to another's in the same thread.
    setChatMessages([]);
  }

  async function submitChat(e: React.FormEvent) {
    e.preventDefault();
    const question = chatInput.trim();
    if (!question || chatBusy) return;
    const next = [...chatMessages, { role: 'user' as const, content: question }];
    setChatMessages(next);
    setChatInput('');
    setChatBusy(true);
    // Push an empty assistant placeholder immediately, then grow its
    // content in place as stream chunks arrive — this is what makes the
    // reply visibly type itself out instead of appearing all at once.
    setChatMessages((cur) => [...cur, { role: 'assistant', content: '' }]);
    try {
      await sendChatStream(
        next,
        (textSoFar) => {
          setChatMessages((cur) => {
            const updated = [...cur];
            updated[updated.length - 1] = { role: 'assistant', content: textSoFar };
            return updated;
          });
        },
        chatSource,
      );
    } catch (e) {
      setChatMessages((cur) => {
        const updated = [...cur];
        updated[updated.length - 1] = { role: 'assistant', content: `Sorry — ${e instanceof Error ? e.message : 'something went wrong'}.` };
        return updated;
      });
    } finally {
      setChatBusy(false);
    }
  }

  function signOut() {
    clearToken();
    router.replace('/login');
  }

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const anyData = o2dData || jfData || erpData;

  return (
    <div className="min-h-dvh bg-[var(--muted)]">
      {/* Amber bottom-border header, matching O2D's own topbar treatment. */}
      <header className="sticky top-0 z-10 flex h-[58px] items-center justify-between border-b border-[var(--accent)] bg-[var(--card)] px-4 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)]">
            <Sparkles className="h-4.5 w-4.5" />
          </span>
          <div>
            <h1 className="text-base font-semibold leading-tight">AI Production Incharge</h1>
            <p className="text-xs text-[var(--muted-foreground)]">Read-only insights · Order to Delivery, Jewel Factory & ERP</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void loadAll()}
            disabled={loading}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-[var(--accent)] bg-[var(--accent)] px-3 text-sm text-[var(--accent-foreground)] hover:opacity-90 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh
          </button>
          <button
            onClick={signOut}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-red-100 bg-red-50 px-3 text-sm text-red-500 hover:bg-red-100"
          >
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl items-start">
        {/* Left sidebar — source navigation, replaces the earlier tab
            switcher/overview-cards-only approach. Active section highlight
            tracks scroll position via the IntersectionObserver above. */}
        <nav className="sticky top-[58px] hidden h-[calc(100dvh-58px)] w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-[var(--border)] bg-[var(--card)] p-3 sm:flex">
          <SidebarLink
            icon={<Truck className="h-4 w-4" />}
            label="Order to Delivery"
            active={activeSection === 'section-o2d'}
            onClick={() => scrollTo('section-o2d')}
            stat={o2dData ? `${o2dData.summary.totalActive} active` : undefined}
          />
          <SidebarLink
            icon={<Boxes className="h-4 w-4" />}
            label="Jewel Factory"
            active={activeSection === 'section-jf'}
            onClick={() => scrollTo('section-jf')}
            stat={jfData ? `${jfData.summary.totalActive} active` : undefined}
          />
          <SidebarLink
            icon={<Factory className="h-4 w-4" />}
            label="ERP"
            active={activeSection === 'section-erp'}
            onClick={() => scrollTo('section-erp')}
            stat={erpData ? `${erpData.jobPipeline.totalOrders} active` : undefined}
          />
        </nav>

        <main className="flex min-w-0 flex-1 flex-col gap-6 p-4 sm:p-6">
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

          {loading && !anyData && (
            <div className="flex items-center gap-2 py-16 text-[var(--muted-foreground)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading live production data…
            </div>
          )}

          {anyData && (
            <>
            {/* Comparison chart — O2D vs Jewel Factory active/delayed/urgent
                counts side by side, the one place a chart genuinely helps
                compare across sources at a glance. */}
            {o2dData && jfData && (
              <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
                <h2 className="mb-3 text-sm font-semibold">Orders at a glance — Order to Delivery vs Jewel Factory</h2>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={[
                        { metric: 'Active', 'Order to Delivery': o2dData.summary.totalActive, 'Jewel Factory': jfData.summary.totalActive },
                        { metric: 'Delayed', 'Order to Delivery': o2dData.summary.totalDelayed, 'Jewel Factory': jfData.summary.totalDelayed },
                        { metric: 'Urgent', 'Order to Delivery': o2dData.summary.totalUrgent, 'Jewel Factory': jfData.summary.totalUrgent },
                      ]}
                      margin={{ top: 4, right: 8, left: -16, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                      <XAxis dataKey="metric" tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid var(--border)' }} />
                      <Bar dataKey="Order to Delivery" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} />
                      <Bar dataKey="Jewel Factory" fill={CHART_COLORS.sky} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>
            )}

            {/* Order to Delivery section */}
            {o2dData && (
              <div id="section-o2d" className="scroll-mt-20 space-y-4">
                <SectionHeading title="Order to Delivery" />
                <StandardDashboard data={o2dData} />
              </div>
            )}

            {/* Jewel Factory section */}
            {jfData && (
              <div id="section-jf" className="scroll-mt-20 space-y-4">
                <SectionHeading title="Jewel Factory" />
                <StandardDashboard data={jfData} />
              </div>
            )}

            {/* ERP section */}
            {erpData && (
              <div id="section-erp" className="scroll-mt-20 space-y-4">
                <SectionHeading title="ERP" />
                <ErpSection data={erpData} />
              </div>
            )}

            </>
          )}
        </main>
      </div>

      {/* Floating chat launcher — bottom-right icon button, matching the
          common "chat widget" convention rather than a chat box sitting
          inline at the bottom of a long scrolling page. */}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          aria-label="Open AI agent chat"
          className="fixed bottom-5 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] shadow-lg transition-transform hover:scale-105"
        >
          <MessageCircle className="h-6 w-6" />
        </button>
      )}

      {chatOpen && (
        <section className="fixed bottom-5 right-5 z-30 flex h-[min(600px,calc(100dvh-2.5rem))] w-[min(380px,calc(100vw-2.5rem))] flex-col rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-2xl">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)]">
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              <h2 className="text-sm font-semibold">Ask the AI agent</h2>
            </div>
            <button
              onClick={() => setChatOpen(false)}
              aria-label="Close chat"
              className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2">
            <p className="text-xs text-[var(--muted-foreground)]">
              {chatSource === 'jf'
                ? 'e.g. "Which retailer\'s order is late?"'
                : chatSource === 'erp'
                  ? 'e.g. "Which department has the worst recovery?"'
                  : 'e.g. "Which urgent orders are late?"'}
            </p>
            <select
              value={chatSource}
              onChange={(e) => switchChatSource(e.target.value as Source)}
              className="h-7 shrink-0 rounded-md border border-[var(--border)] bg-[var(--muted)] px-2 text-xs font-medium outline-none"
            >
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {chatMessages.length === 0 && (
              <p className="text-sm text-[var(--muted-foreground)]">
                Ask anything about {SOURCES.find((s) => s.value === chatSource)?.label}'s current data.
              </p>
            )}
            {chatMessages.map((m, i) => {
              const isLastAssistant = m.role === 'assistant' && i === chatMessages.length - 1;
              const stillWaitingForFirstChunk = isLastAssistant && chatBusy && m.content === '';
              if (stillWaitingForFirstChunk) return null; // covered by the "Thinking…" bubble below
              return (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`rounded-lg px-3 py-2 text-sm ${
                      m.role === 'user'
                        ? 'max-w-[85%] whitespace-pre-wrap bg-[var(--primary)] text-[var(--primary-foreground)]'
                        : 'max-w-[95%] min-w-0 bg-[var(--muted)]'
                    }`}
                  >
                    {m.role === 'assistant' ? (
                      <div className="chat-markdown">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{ table: ({ children }) => <div className="table-wrap"><table>{children}</table></div> }}
                        >
                          {m.content}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      m.content
                    )}
                  </div>
                </div>
              );
            })}
            {chatBusy && chatMessages[chatMessages.length - 1]?.content === '' && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-lg bg-[var(--muted)] px-3 py-2 text-sm text-[var(--muted-foreground)]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <form onSubmit={submitChat} className="flex items-center gap-2 border-t border-[var(--border)] p-3">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={`Ask about ${SOURCES.find((s) => s.value === chatSource)?.label}…`}
              className="h-10 flex-1 rounded-md border border-[var(--input)] bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
            <button
              type="submit"
              disabled={chatBusy || !chatInput.trim()}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--primary)] text-[var(--primary-foreground)] disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </section>
      )}
    </div>
  );
}

function SectionHeading({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-5 w-1 rounded-full bg-[var(--primary)]" />
      <h2 className="text-base font-semibold">{title}</h2>
    </div>
  );
}

function SidebarLink({
  icon,
  label,
  active,
  onClick,
  stat,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  stat?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
        active ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'text-[var(--foreground)] hover:bg-[var(--accent)]'
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {stat && (
          <span className={`block truncate text-xs ${active ? 'text-[var(--primary-foreground)]/80' : 'text-[var(--muted-foreground)]'}`}>
            {stat}
          </span>
        )}
      </span>
    </button>
  );
}

/** O2D and Jewel Factory's shared dashboard shape: stat cards + narrative +
 * delayed orders / stage bottlenecks (chart) / karigar load panels. */
function StandardDashboard({ data }: { data: StandardInsightsData }) {
  const bottleneckChartData = data.stageBottlenecks.slice(0, 8).map((s) => ({ stage: s.stage, count: s.count }));

  return (
    <>
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Active orders" value={data.summary.totalActive} />
        <StatCard label="Delayed" value={data.summary.totalDelayed} tone="warn" />
        <StatCard label="Urgent" value={data.summary.totalUrgent} tone="danger" />
        <StatCard label="Completed today" value={data.summary.totalCompletedToday} tone="good" />
      </section>

      {data.narrative && <NarrativeCard text={data.narrative} />}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Clock className="h-4 w-4 text-amber-600" /> Delayed orders</h3>
          <div className="max-h-80 space-y-1.5 overflow-y-auto">
            {data.delayedOrders.length === 0 && <p className="text-xs text-[var(--muted-foreground)]">Nothing overdue right now.</p>}
            {data.delayedOrders.map((o) => (
              <div key={o.orderNo} className="flex items-center justify-between rounded-md bg-[var(--muted)] px-2.5 py-1.5 text-xs">
                <div className="min-w-0">
                  <p className="truncate font-medium">{o.primaryLabel}</p>
                  <p className="truncate text-[var(--muted-foreground)]">{o.subLabel}</p>
                </div>
                <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-700">{o.daysLate}d late</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-orange-600" /> Stage bottlenecks</h3>
          {bottleneckChartData.length > 0 ? (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={bottleneckChartData} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" />
                  <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <YAxis dataKey="stage" type="category" width={90} tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid var(--border)' }} />
                  <Bar dataKey="count" fill={CHART_COLORS.primary} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-xs text-[var(--muted-foreground)]">No active orders right now.</p>
          )}
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Hammer className="h-4 w-4 text-blue-600" /> Karigar load</h3>
          <div className="max-h-80 space-y-1.5 overflow-y-auto">
            {data.karigarLoad.map((k) => (
              <div key={k.key} className="flex items-center justify-between rounded-md bg-[var(--muted)] px-2.5 py-1.5 text-xs">
                <div className="min-w-0">
                  <p className="truncate font-medium">{k.label}</p>
                  {k.delayedOrderCount > 0 && <p className="text-red-600">{k.delayedOrderCount} delayed</p>}
                </div>
                <span className="shrink-0 rounded-full bg-[var(--secondary)] px-2 py-0.5 font-semibold">{k.activeOrderCount}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

/** ERP's own dashboard shape, mirroring erp-new-frontend's real dashboard
 * widgets (StatCardsRow, SummaryTilesRow, JobPipelinePanel,
 * DepartmentEfficiencyChart, KarigarRankingPanels, RecentActivityPanel,
 * UrgentDispatchPanel) rather than the O2D/JF "orders" pattern. */
function ErpSection({ data }: { data: ErpInsightsData }) {
  const topKarigars = data.karigarRankings.slice(0, 5);
  const bottomKarigars = [...data.karigarRankings].reverse().slice(0, 4);
  const pipelineChartData = [
    { name: 'Queued', value: data.jobPipeline.queued },
    { name: 'In progress', value: data.jobPipeline.inProgress },
    { name: 'Ready', value: data.jobPipeline.ready },
  ];
  const deptChartData = data.departmentEfficiency.map((d) => ({ dept: d.dept, recovery: Number(d.recoveryPercent.toFixed(1)) }));

  return (
    <>
      {/* Metal stock levels */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Fine Gold (24K)" value={round3(data.stock.stock24K)} suffix="g" />
        <StatCard label="Stock (22K)" value={round3(data.stock.stock22K)} suffix="g" />
        <StatCard label="Stock (18K)" value={round3(data.stock.stock18K)} suffix="g" />
        <StatCard label="Wastage Pool" value={round3(data.stock.scrapBalance)} suffix="g" />
      </section>

      {/* Urgent alerts */}
      {data.alerts.length > 0 ? (
        <section className="space-y-1.5">
          {data.alerts.map((a, i) => (
            <div
              key={i}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                a.severity === 'high' ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-700'
              }`}
            >
              <AlertTriangle className="h-4 w-4 shrink-0" /> {a.message}
            </div>
          ))}
        </section>
      ) : (
        <section className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          No production blocks detected
        </section>
      )}

      {data.narrative && <NarrativeCard text={data.narrative} />}

      {/* Orders / Alloy / Department summary tiles */}
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <p className="text-xs font-medium text-[var(--muted-foreground)]">Factory orders</p>
          <p className="mt-1 text-xl font-semibold">{data.ordersSummary.total}</p>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">
            {data.ordersSummary.urgent > 0 && <span className="text-red-600">{data.ordersSummary.urgent} urgent · </span>}
            {data.ordersSummary.normal} normal · {data.ordersSummary.stock} stock
          </p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <p className="text-xs font-medium text-[var(--muted-foreground)]">Alloy conversion loss</p>
          <p className="mt-1 text-xl font-semibold">{data.alloySummary.avgLossPercent.toFixed(2)}%</p>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">
            {data.alloySummary.todayCount} today
            {data.alloySummary.overThreshold > 0 && <span className="text-amber-600"> · {data.alloySummary.overThreshold} over threshold</span>}
          </p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <p className="text-xs font-medium text-[var(--muted-foreground)]">Department issues pending</p>
          <p className="mt-1 text-xl font-semibold">{round3(data.departmentSummary.pendingWeight)}g</p>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">
            {data.departmentSummary.pendingCount} open · {data.departmentSummary.avgRecoveryPercent.toFixed(1)}% avg recovery
          </p>
        </div>
      </section>

      {/* Job pipeline — donut chart */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="mb-3 text-sm font-semibold">Job pipeline — {data.jobPipeline.totalOrders} active</h3>
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          <div className="h-48 w-48 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pipelineChartData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={70} paddingAngle={2}>
                  {pipelineChartData.map((_, i) => (
                    <Cell key={i} fill={PIPELINE_COLORS[i]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid var(--border)' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="grid flex-1 grid-cols-3 gap-3 text-center">
            <PipelineStat label="Queued" value={data.jobPipeline.queued} total={data.jobPipeline.totalOrders} color="text-sky-700" />
            <PipelineStat label="In progress" value={data.jobPipeline.inProgress} total={data.jobPipeline.totalOrders} color="text-[var(--muted-foreground)]" />
            <PipelineStat label="Ready" value={data.jobPipeline.ready} total={data.jobPipeline.totalOrders} color="text-emerald-700" />
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Department efficiency — bar chart + list */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 lg:col-span-2">
          <h3 className="mb-3 text-sm font-semibold">Department recovery %</h3>
          {deptChartData.length > 0 ? (
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={deptChartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="dept" tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} axisLine={false} tickLine={false} unit="%" />
                  <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid var(--border)' }} />
                  <Bar dataKey="recovery" radius={[4, 4, 0, 0]}>
                    {deptChartData.map((d, i) => (
                      <Cell key={i} fill={d.recovery >= 98.3 ? CHART_COLORS.good : CHART_COLORS.primary} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-xs text-[var(--muted-foreground)]">No completed department returns yet.</p>
          )}
        </section>

        {/* Recent activity */}
        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h3 className="mb-3 text-sm font-semibold">Recent activity</h3>
          <div className="max-h-80 space-y-1.5 overflow-y-auto">
            {data.recentActivity.length === 0 && <p className="text-xs text-[var(--muted-foreground)]">Awaiting movement records…</p>}
            {data.recentActivity.map((r) => (
              <div key={r.issueNo} className="rounded-md bg-[var(--muted)] px-2.5 py-1.5 text-xs">
                <p className="truncate font-medium">{r.dept || 'Unassigned'} · {r.karigarName || 'Auto-Assign'}</p>
                <p className="truncate text-[var(--muted-foreground)]">{r.issueWeight.toFixed(3)}g · {timeAgo(r.timestamp)}{r.received ? ' · received' : ''}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Karigar ranking */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h3 className="mb-3 text-sm font-semibold">Top performing karigars</h3>
          <div className="space-y-1.5">
            {topKarigars.length === 0 && <p className="text-xs text-[var(--muted-foreground)]">No completed karigar returns yet.</p>}
            {topKarigars.map((k, i) => (
              <div key={k.karigarName} className="flex items-center justify-between rounded-md bg-[var(--muted)] px-2.5 py-1.5 text-xs">
                <div className="min-w-0">
                  <p className="truncate font-medium">#{i + 1} {k.karigarName}</p>
                  <p className="truncate text-[var(--muted-foreground)]">{k.issuedWeight.toFixed(3)}g issued</p>
                </div>
                <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700">{k.recoveryPercent.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h3 className="mb-3 text-sm font-semibold">Needs attention</h3>
          <div className="space-y-1.5">
            {bottomKarigars.length === 0 && <p className="text-xs text-[var(--muted-foreground)]">Global efficiency targets met.</p>}
            {bottomKarigars.map((k, i) => (
              <div key={k.karigarName} className="flex items-center justify-between rounded-md bg-[var(--muted)] px-2.5 py-1.5 text-xs">
                <p className="truncate font-medium">#{i + 1} {k.karigarName}</p>
                <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-700">{k.recoveryPercent.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

function NarrativeCard({ text }: { text: string }) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
        <Sparkles className="h-3.5 w-3.5" /> Briefing
      </p>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
    </section>
  );
}

function PipelineStat({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <p className={`text-2xl font-semibold ${color}`}>{value}</p>
      <p className="text-xs text-[var(--muted-foreground)]">{label} · {pct}%</p>
    </div>
  );
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function StatCard({ label, value, tone, suffix }: { label: string; value: number; tone?: 'warn' | 'danger' | 'good'; suffix?: string }) {
  const toneClass =
    tone === 'danger' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : tone === 'good' ? 'text-emerald-600' : 'text-[var(--foreground)]';
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <p className="text-xs font-medium text-[var(--muted-foreground)]">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}{suffix}</p>
    </div>
  );
}
