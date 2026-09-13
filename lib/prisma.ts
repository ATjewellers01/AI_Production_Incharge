import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

import { stripSslmode } from './db-url';

// Matches at-order-to-dispatch-backend's own src/lib/prisma.ts (Prisma 7
// driver-adapter model) — same SSL-for-RDS heuristic, smaller pool since
// this service is read-only, low-traffic (a dashboard load + occasional
// chat questions, not every O2D staff member's every click).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient() {
  // Any managed cloud Postgres (Neon, RDS, Supabase, ...) requires SSL —
  // only a bare `localhost`/`127.0.0.1` connection (local pgAdmin-restored
  // testing) doesn't. An earlier version of this only enabled SSL for RDS
  // specifically, which silently connected to Neon with ssl:false and
  // caused every DB query to fail at runtime (502s in production, even
  // though the build itself succeeded) — Neon's own connection string
  // requires `sslmode=require`.
  const rawUrl = process.env.DATABASE_URL ?? '';
  const isLocal = /localhost|127\.0\.0\.1/.test(rawUrl);
  const connectionString = stripSslmode(rawUrl);

  const pool = new Pool({
    connectionString,
    max: 5,
    min: 0,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
