import { NextResponse } from 'next/server';

import { prisma } from '@/lib/prisma';

/**
 * Unlike the plain "is the process up" health check most apps have, this
 * one also does a real database round-trip — so a bad DATABASE_URL/SSL
 * mismatch/unreachable host shows up here as a clear JSON error instead of
 * only being discoverable by triggering a 502 on the actual dashboard.
 * Visit /api/health directly in a browser any time something looks broken.
 */
export async function GET() {
  const checks: { service: 'ok'; database: 'ok' | { error: string } } = { service: 'ok', database: 'ok' };
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (e) {
    checks.database = { error: e instanceof Error ? e.message : String(e) };
    console.error('[health] database check failed:', e);
  }
  const healthy = checks.database === 'ok';
  return NextResponse.json({ status: healthy ? 'ok' : 'degraded', service: 'ai-production-incharge', checks }, { status: healthy ? 200 : 503 });
}
