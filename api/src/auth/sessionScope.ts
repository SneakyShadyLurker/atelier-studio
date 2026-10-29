import { SESSION_SCOPE_HEADER, type ApiErrorCode } from '@atelier/shared';
import { createMiddleware } from 'hono/factory';
import { getOrCreateUserCacheScope } from '../db/users';
import type { AppEnv } from '../server-env';

// Optional for compatibility with older clients and browser image requests.
// A bound SPA must never submit its previous account's work as the new user.
export const sessionScopeGuard = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const scope = getOrCreateUserCacheScope(c.var.db, c.var.userId);
    c.header(SESSION_SCOPE_HEADER, scope);
    const expected = c.req.header(SESSION_SCOPE_HEADER);
    if (expected !== undefined && expected !== scope) {
      c.header('Cache-Control', 'private, no-store');
      c.header('Vary', SESSION_SCOPE_HEADER, { append: true });
      return c.json({ error: 'session changed', code: 'SESSION_CHANGED' satisfies ApiErrorCode }, 409);
    }
    await next();
    c.header('Vary', SESSION_SCOPE_HEADER, { append: true });
    return;
  });
