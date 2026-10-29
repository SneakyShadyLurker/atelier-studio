import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../server-env';

// CSRF defense for state-changing methods: requires Origin (or Referer
// fallback) to match the request's Host header. The Authelia session cookie
// rides on every cross-origin request the browser issues, so a malicious site
// can otherwise trigger POST /api/generate, DELETE /api/history, etc. on a
// logged-in victim with no preflight (multipart and text/plain JSON are
// CORS-simple). Origin/Referer is browser-set and unforgeable from page
// JavaScript — same-origin browser requests carry a matching value; cross-
// origin requests carry a mismatching one. The check no-ops on safe methods
// to keep GET / HEAD / OPTIONS reachable from any context (image embeds,
// preflights). Toggle via Config.CSRF_PROTECT.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originHost(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  try {
    return new URL(headerValue).host;
  } catch {
    return null;
  }
}

export const csrfGuard = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!c.var.config.CSRF_PROTECT) {
      await next();
      return;
    }
    if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }
    const host = c.req.header('Host') ?? '';
    const origin = c.req.header('Origin');
    const referer = c.req.header('Referer');
    const targetHost = originHost(origin) ?? originHost(referer);
    if (!targetHost) {
      c.var.logger.warn(
        { method: c.req.method, path: c.req.path },
        'csrf: rejected — no Origin/Referer on state-changing request',
      );
      return c.json({ error: 'forbidden' }, 403);
    }
    if (targetHost !== host) {
      c.var.logger.warn(
        { method: c.req.method, path: c.req.path, targetHost, host },
        'csrf: rejected — cross-origin request',
      );
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
    return;
  });
