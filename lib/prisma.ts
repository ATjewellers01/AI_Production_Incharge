import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// Matches at-order-to-dispatch-backend's own src/lib/prisma.ts (Prisma 7
// driver-adapter model) — same SSL-for-RDS heuristic, smaller pool since
// this service is read-only, low-traffic (a dashboard load + occasional
// chat questions, not every O2D staff member's every click).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient() {
  const isRDS = process.env.DATABASE_URL?.includes('rds.amazonaws.com');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    min: 0,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: isRDS ? { rejectUnauthorized: false } : false,
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
