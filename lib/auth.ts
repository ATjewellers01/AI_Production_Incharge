import jwt from 'jsonwebtoken';

import { prisma } from './prisma';

// Reuses at-order-to-dispatch-backend's OWN JWT_SECRET and token shape
// ({id, userId, role}, see that repo's src/lib/jwt.ts) so a production
// incharge who is already logged into O2D can use that exact same
// Bearer token here — no separate account/login system for this service.
// This service never ISSUES tokens, only verifies ones O2D already issued.
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';

export type AuthUser = {
  id: string;
  userId: string;
  name: string;
  role: string;
  branchId: string | null;
};

// TEMPORARY testing-only auth bypass — gated on ONE explicit env var,
// SKIP_AUTH_IN_DEV=true. Unlike an earlier draft of this file, this is now
// allowed to activate on Render too (an explicit, deliberate choice for
// early testing against the Neon test database, made because there's no
// real O2D login/JWT_SECRET wired up yet) — it is NOT restricted to
// NODE_ENV!=='production' anymore. Returns a fake SUPER_ADMIN (branchId:
// null -> sees every branch).
//
// ⚠️ SECURITY: remove this env var (or delete this bypass entirely) before
// this service is ever exposed with real production data or shared beyond
// a small testing group — while it's set, ANYONE who reaches this
// service's URL sees every order/karigar with no login at all.
const DEV_AUTH_BYPASS = process.env.SKIP_AUTH_IN_DEV === 'true';

/** Verifies the Bearer token and loads the current user, read-only. Throws on any failure. */
export async function requireUser(authHeader: string | null): Promise<AuthUser> {
  if (DEV_AUTH_BYPASS) {
    return { id: 'dev-bypass', userId: 'dev', name: 'Dev (auth bypassed)', role: 'SUPER_ADMIN', branchId: null };
  }
  if (!authHeader?.startsWith('Bearer ')) throw new AuthError('Missing token');
  const token = authHeader.slice('Bearer '.length);
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
  } catch {
    throw new AuthError('Invalid or expired token');
  }
  const id = payload.id as string | undefined;
  if (!id) throw new AuthError('Invalid token payload');

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || !user.isActive) throw new AuthError('User not found or inactive');

  // Production-incharge insights are admin-facing (aggregate/cross-order
  // data, not a single karigar's own task list) — gate the same way O2D
  // gates its own admin-only pages.
  if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
    throw new AuthError('Admin access required', 403);
  }

  return { id: user.id, userId: user.userId, name: user.name, role: user.role, branchId: user.branchId };
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}
