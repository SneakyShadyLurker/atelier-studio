import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../server-env';

export const promptGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.config.PROMPT_LIBRARY_USERS.has(c.var.userId)) {
    return c.json({ error: 'not found' }, 404);
  }
  await next();
  return;
};
