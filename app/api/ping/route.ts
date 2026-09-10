import { NextResponse } from 'next/server';

/**
 * Zero-dependency diagnostic route — no Prisma, no OpenAI, no auth, nothing
 * imported beyond Next.js itself. If this route ALSO 502s with no log line,
 * the problem is not in any application code path (Prisma engine, OpenAI
 * SDK, auth) — it would have to be something before Next.js's own router
 * even runs a handler, which points squarely at Render's routing/proxy
 * layer rather than this codebase. If this route WORKS while /api/health
 * doesn't, that narrows the crash to something /api/health's code path
 * specifically touches (Prisma).
 */
export async function GET() {
  console.log('[ping] hit at', new Date().toISOString());
  return NextResponse.json({ pong: true, time: new Date().toISOString() });
}
