'use client';

// Client-side fetch helpers. Auth is the SAME O2D account (userId/password) —
// this service doesn't have its own user table, it only verifies the JWT
// O2D's own /api/auth/login issues (see lib/auth.ts). O2D_API_URL is a
// PUBLIC env var (browser calls O2D's login endpoint directly) — it is
// never the shared secret used by the Jewel Factory integration, and never
// the raw Postgres DATABASE_URL, both of which stay server-only.
const O2D_API_URL = process.env.NEXT_PUBLIC_O2D_API_URL || 'http://localhost:5000/api';

const TOKEN_KEY = 'ai_incharge_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export async function login(userId: string, password: string): Promise<{ token: string; name: string; role: string }> {
  const res = await fetch(`${O2D_API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, password }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.token) throw new Error(json?.message || 'Login failed');
  if (json.user?.role !== 'ADMIN' && json.user?.role !== 'SUPER_ADMIN') {
    throw new Error('Only Admin/Super Admin accounts can use the AI Production Incharge.');
  }
  setToken(json.token);
  return { token: json.token, name: json.user?.name ?? userId, role: json.user?.role };
}

async function authedFetch(path: string, init?: RequestInit) {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: { ...init?.headers, Authorization: token ? `Bearer ${token}` : '', 'Content-Type': 'application/json' },
  });
  if (res.status === 401) {
    clearToken();
    window.location.assign('/login');
    throw new Error('Session expired');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.success === false) throw new Error(json?.message || 'Request failed');
  return json;
}

export async function fetchInsights() {
  const json = await authedFetch('/api/insights');
  return json.data;
}

export async function sendChat(messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
  const json = await authedFetch('/api/chat', { method: 'POST', body: JSON.stringify({ messages }) });
  return json.data as { reply: string; toolCalls: Array<{ name: string; args: unknown }> };
}
