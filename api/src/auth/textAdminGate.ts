import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../server-env';

// Text provider admin API (spec § 9.2): only TEXT_PROVIDER_ADMINS members see
// these routes; everyone else gets the same 404 as an unknown path. Admin
// answers are never cached (spec § 10).
export const textAdminGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.config.TEXT_PROVIDER_ADMINS.has(c.var.userId)) {
    return c.json({ error: 'not found' }, 404);
  }
  c.header('Cache-Control', 'private, no-store');
  await next();
  return;
};
