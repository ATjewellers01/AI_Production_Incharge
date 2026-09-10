'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles } from 'lucide-react';

import { login } from '@/lib/client-api';

export default function LoginPage() {
  const router = useRouter();
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(userId, password);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setLoading(false);
    }
  }

  return (
    // Warm cream backdrop + amber accent bar on the card, matching O2D's
    // own dedicated login screen treatment (gold gradient accent + cream
    // ground rather than the plain neutral --muted used elsewhere).
    <main className="flex min-h-dvh items-center justify-center bg-[oklch(0.97_0.015_75)] p-4">
      <div className="w-full max-w-sm overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-sm">
        <div className="h-1.5 w-full bg-gradient-to-r from-[oklch(0.6_0.15_60)] via-[var(--primary)] to-[oklch(0.75_0.14_70)]" />
        <div className="p-8">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)]">
            <Sparkles className="h-4.5 w-4.5" />
          </span>
          <div>
            <h1 className="text-base font-semibold leading-tight">AI Production Incharge</h1>
            <p className="text-xs text-[var(--muted-foreground)]">Order to Delivery</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">User ID</label>
            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="h-10 w-full rounded-md border border-[var(--input)] bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
              placeholder="Same User ID as O2D"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10 w-full rounded-md border border-[var(--input)] bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--ring)]"
            />
          </div>
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[var(--primary)] text-sm font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Sign in'}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-[var(--muted-foreground)]">
          Uses the same Admin/Super Admin account as Order to Delivery. Read-only — no changes are ever made here.
        </p>
        </div>
      </div>
    </main>
  );
}
