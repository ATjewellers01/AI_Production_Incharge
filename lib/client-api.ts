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

export type Source = 'o2d' | 'jf' | 'erp';

export async function fetchInsights(source: Source = 'o2d') {
  const json = await authedFetch(`/api/insights?source=${source}`);
  return json.data;
}

type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; toolCalls: Array<{ name: string; args: unknown }> }
  | { type: 'error'; message: string };

/**
 * Streaming counterpart to the old one-shot sendChat — /api/chat now
 * responds with newline-delimited JSON events (see that route's own
 * comment for the exact protocol) instead of a single JSON body. Calls
 * onDelta as each chunk of the reply arrives so the UI can render it live,
 * word-by-word, instead of waiting for the whole answer.
 */
export async function sendChatStream(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  onDelta: (textSoFar: string) => void,
  source: Source = 'o2d',
): Promise<{ reply: string; toolCalls: Array<{ name: string; args: unknown }> }> {
  const token = getToken();
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { Authorization: token ? `Bearer ${token}` : '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, source }),
  });

  if (res.status === 401) {
    clearToken();
    window.location.assign('/login');
    throw new Error('Session expired');
  }
  if (!res.ok || !res.body) {
    // A non-streaming failure (e.g. auth/validation error before the
    // stream started) still comes back as a plain JSON error body.
    const json = await res.json().catch(() => null);
    throw new Error(json?.message || 'Request failed');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply = '';
  let toolCalls: Array<{ name: string; args: unknown }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // last line may be incomplete, keep for next read

    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as ChatStreamEvent;
      if (event.type === 'delta') {
        reply += event.text;
        onDelta(reply);
      } else if (event.type === 'done') {
        toolCalls = event.toolCalls;
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    }
  }

  return { reply, toolCalls };
}
