import { Hono } from 'hono';
import type { AppEnv, BaseEnv } from '../server-env';

// /api/health is mounted before the auth middleware (architecture
// invariant 5: only public route). It deliberately uses `BaseEnv`, which
// does NOT expose `userId` at the type level — reaching for `c.var.userId`
// here would not compile.
export const healthRoutes = new Hono<BaseEnv>().get('/health', (c) =>
  c.json({ ok: true as const, version: '0.0.0' }),
);

export const readyRoutes = new Hono<AppEnv>().get('/ready', (c) => {
  try {
    c.var.db.query('SELECT 1').get();
    return c.json({ ok: true as const });
  } catch (error) {
    c.var.logger.error({ err: error }, 'readiness check failed');
    return c.json({ ok: false as const }, 503);
  }
});
