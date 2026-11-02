import { Hono } from 'hono';
import { getOrCreateUserCacheScope } from '../db/users';
import type { AppEnv } from '../server-env';

export const sessionRoutes = new Hono<AppEnv>().get('/session', (c) => {
  c.header('Cache-Control', 'private, no-store');
  return c.json({ cacheScope: getOrCreateUserCacheScope(c.var.db, c.var.userId) });
});
