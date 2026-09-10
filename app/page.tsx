'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Clock, Hammer, Loader2, LogOut, RefreshCw, Send, Sparkles } from 'lucide-react';

import { clearToken, fetchInsights, getToken, sendChat } from '@/lib/client-api';
import type { DelayedOrder, KarigarLoad, StageBottleneck, Summary } from '@/lib/tools';

type InsightsData = {
  summary: Summary;
  delayedOrders: DelayedOrder[];
  stageBottlenecks: StageBottleneck[];
  karigarLoad: KarigarLoad[];
  narrative: string | null;
};

type ChatMsg = { role: 'user' | 'assistant'; content: string };

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<InsightsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const insights = await fetchInsights();
      setData(insights);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load insights');
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
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  async function submitChat(e: React.FormEvent) {
    e.preventDefault();
    const question = chatInput.trim();
    if (!question || chatBusy) return;
    const next = [...chatMessages, { role: 'user' as const, content: question }];
    setChatMessages(next);
    setChatInput('');
    setChatBusy(true);
    try {
      const res = await sendChat(next);
      setChatMessages((cur) => [...cur, { role: 'assistant', content: res.reply }]);
    } catch (e) {
      setChatMessages((cur) => [...cur, { role: 'assistant', content: `Sorry — ${e instanceof Error ? e.message : 'something went wrong'}.` }]);
    } finally {
      setChatBusy(false);
    }
  }

  function signOut() {
    clearToken();
    router.replace('/login');
  }

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
            <p className="text-xs text-[var(--muted-foreground)]">Read-only insights · Order to Delivery</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void load()}
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

      <main className="mx-auto flex max-w-6xl flex-col gap-6 p-4 sm:p-6">
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {loading && !data && (
        <div className="flex items-center gap-2 py-16 text-[var(--muted-foreground)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading live production data…
        </div>
      )}

      {data && (
        <>
          {/* Top-line counts */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Active orders" value={data.summary.totalActive} />
            <StatCard label="Delayed" value={data.summary.totalDelayed} tone="warn" />
            <StatCard label="Urgent" value={data.summary.totalUrgent} tone="danger" />
            <StatCard label="Completed today" value={data.summary.totalCompletedToday} tone="good" />
          </section>

          {/* AI narrative briefing */}
          {data.narrative && (
            <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                <Sparkles className="h-3.5 w-3.5" /> Briefing
              </p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{data.narrative}</p>
            </section>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            {/* Delayed orders */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
              <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Clock className="h-4 w-4 text-amber-600" /> Delayed orders</h2>
              <div className="max-h-80 space-y-1.5 overflow-y-auto">
                {data.delayedOrders.length === 0 && <p className="text-xs text-[var(--muted-foreground)]">Nothing overdue right now.</p>}
                {data.delayedOrders.map((o) => (
                  <div key={o.orderNo} className="flex items-center justify-between rounded-md bg-[var(--muted)] px-2.5 py-1.5 text-xs">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{o.orderNo} · {o.companyName}</p>
                      <p className="truncate text-[var(--muted-foreground)]">{o.stage}{o.karigarName ? ` · ${o.karigarName}` : ''}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-700">{o.daysLate}d late</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Stage bottlenecks */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
              <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-orange-600" /> Stage bottlenecks</h2>
              <div className="max-h-80 space-y-1.5 overflow-y-auto">
                {data.stageBottlenecks.map((s) => (
                  <div key={s.stage} className="flex items-center justify-between rounded-md bg-[var(--muted)] px-2.5 py-1.5 text-xs">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{s.stage}</p>
                      {s.oldestOrderNo && <p className="truncate text-[var(--muted-foreground)]">Oldest: {s.oldestOrderNo} ({s.oldestOrderAgeDays}d)</p>}
                    </div>
                    <span className="shrink-0 rounded-full bg-[var(--secondary)] px-2 py-0.5 font-semibold">{s.orderCount}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Karigar load */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
              <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Hammer className="h-4 w-4 text-blue-600" /> Karigar load</h2>
              <div className="max-h-80 space-y-1.5 overflow-y-auto">
                {data.karigarLoad.map((k) => (
                  <div key={k.karigarId} className="flex items-center justify-between rounded-md bg-[var(--muted)] px-2.5 py-1.5 text-xs">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{k.karigarName} <span className="text-[var(--muted-foreground)]">({k.karigarCode})</span></p>
                      {k.delayedOrderCount > 0 && <p className="text-red-600">{k.delayedOrderCount} delayed</p>}
                    </div>
                    <span className="shrink-0 rounded-full bg-[var(--secondary)] px-2 py-0.5 font-semibold">{k.activeOrderCount}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* Chat */}
          <section className="flex min-h-[420px] flex-col rounded-xl border border-[var(--border)] bg-[var(--card)]">
            <div className="border-b border-[var(--border)] px-4 py-3">
              <h2 className="text-sm font-semibold">Ask a question</h2>
              <p className="text-xs text-[var(--muted-foreground)]">e.g. "Which urgent orders are late?" · "How much work does Ramesh have?"</p>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {chatMessages.length === 0 && (
                <p className="text-sm text-[var(--muted-foreground)]">Ask anything about current orders, delays, or karigar workload.</p>
              )}
              {chatMessages.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                      m.role === 'user' ? 'bg-[var(--primary)] text-[var(--primary-foreground)]' : 'bg-[var(--muted)]'
                    }`}
                  >
                    {m.content}
                  </div>
                </div>
              ))}
              {chatBusy && (
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
                placeholder="Ask about orders, delays, karigar load…"
                className="h-10 flex-1 rounded-md border border-[var(--input)] bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
              />
              <button
                type="submit"
                disabled={chatBusy || !chatInput.trim()}
                className="flex h-10 w-10 items-center justify-center rounded-md bg-[var(--primary)] text-[var(--primary-foreground)] disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </section>
        </>
      )}
      </main>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: 'warn' | 'danger' | 'good' }) {
  const toneClass =
    tone === 'danger' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : tone === 'good' ? 'text-emerald-600' : 'text-[var(--foreground)]';
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <p className="text-xs font-medium text-[var(--muted-foreground)]">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}
