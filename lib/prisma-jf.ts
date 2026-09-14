import { PrismaClient } from '../node_modules/.prisma/client-jf';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

import { stripSslmode } from './db-url';

// Second Prisma Client, generated from prisma/jewel-factory/schema.prisma
// into its own output path (node_modules/.prisma/client-jf) so it doesn't
// collide with the default O2D client this repo already had (lib/prisma.ts,
// node_modules/.prisma/client). Same connection-pooling/SSL pattern as that
// file — see its own comments for why the SSL heuristic is "is this
// literally local" rather than provider-specific.
const globalForPrismaJf = globalThis as unknown as { prismaJf?: PrismaClient };

function createPrismaJfClient() {
  const rawUrl = process.env.DATABASE_URL_JEWEL_FACTORY ?? '';
  const isLocal = /localhost|127\.0\.0\.1/.test(rawUrl);
  const connectionString = stripSslmode(rawUrl);

  const pool = new Pool({
    connectionString,
    max: 8,
    min: 0,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prismaJf = globalForPrismaJf.prismaJf ?? createPrismaJfClient();

if (process.env.NODE_ENV !== 'production') globalForPrismaJf.prismaJf = prismaJf;
