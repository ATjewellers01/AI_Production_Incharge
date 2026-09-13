/**
 * Strips a `sslmode` query param from a Postgres connection string, used by
 * both lib/prisma.ts (O2D) and lib/prisma-jf.ts (Jewel Factory) before
 * handing the string to `pg.Pool`.
 *
 * A `?sslmode=require` (or prefer/verify-ca) value makes newer
 * pg-connection-string versions apply libpq-style verify-full semantics
 * REGARDLESS of a separately-passed `ssl: { rejectUnauthorized: false }`
 * object — this broke the Jewel Factory RDS connection with "self-signed
 * certificate in certificate chain" even with that flag explicitly set
 * (AWS RDS's regional CA bundle isn't in Node's default trust store).
 *
 * Uses the `URL`/`URLSearchParams` APIs rather than a hand-rolled regex —
 * an earlier regex version (matching "?sslmode=" or "&sslmode=" up to the
 * next "&") left a dangling "&" where the leading "?" used to be whenever
 * sslmode was the FIRST query
 * param (e.g. Neon's `?sslmode=require&channel_binding=require`), turning
 * `.../neondb?sslmode=require&channel_binding=require` into the broken
 * `.../neondb&channel_binding=require` — which `pg` then parsed as the
 * database name literally including `&channel_binding=require`, causing
 * "Database "neondb&channel_binding=require" does not exist". `URL` handles
 * every param-ordering/count case correctly.
 */
export function stripSslmode(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    // Not a parseable URL (shouldn't happen for a real Postgres connection
    // string) — return as-is rather than risk mangling something we can't
    // safely parse.
    return connectionString;
  }
}
