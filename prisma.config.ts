import { defineConfig } from 'prisma/config';
import 'dotenv/config';

// This repo never runs `prisma migrate` against the shared O2D database
// (see CLAUDE.md — read-only, no migrations folder, never will be) so this
// config only needs to point `prisma generate`/`prisma db pull` at the
// right connection string, nothing more.
export default defineConfig({
  schema: './prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
