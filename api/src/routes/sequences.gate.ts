import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../server-env';

export const videoSequencesGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.config.VIDEO_MODELS_ENABLED) {
    return c.json({ error: 'not found' }, 404);
  }
  await next();
  return;
};
