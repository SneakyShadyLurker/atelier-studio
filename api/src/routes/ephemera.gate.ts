import type { MiddlewareHandler } from 'hono';
import { ephemeraEnabled } from '../config';
import type { AppEnv } from '../server-env';

// Leak-safe gate for the Ephemera character-card routes: 404 unless the
// integration is configured and the user is in EPHEMERA_USERS.
export const ephemeraGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const config = c.var.config;
  if (!ephemeraEnabled(config) || !config.EPHEMERA_USERS.has(c.var.userId)) {
    return c.json({ error: 'not found' }, 404);
  }
  await next();
  return;
};
