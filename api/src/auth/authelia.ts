import { createMiddleware } from 'hono/factory';
import { timingSafeEqual } from 'node:crypto';
import type { AppEnv } from '../server-env';
import { USER_ID_PATTERN } from '../user-id';

// Header SWAG injects when TRUSTED_PROXY_KEY is configured. Defense in
// depth on top of Remote-User format validation — if the api is ever
// reachable outside SWAG (port leak, misconfigured network), the missing
// proxy key fails the request closed even when Remote-User looks valid.
const PROXY_KEY_HEADER = 'X-Atelier-Proxy-Key';

// Constant-time compare so a future networking misconfig can't be probed via
// timing side-channel. Length-gate on the UTF-8 byte length (NOT string
// .length — a multibyte character has the same code-unit count as ASCII but
// a different byte count, which would make timingSafeEqual throw RangeError
// and turn an invalid key into a 500 instead of the intended 401).
const safeKeyCompare = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

export const authelia = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const expectedProxyKey = c.var.config.TRUSTED_PROXY_KEY;
    if (expectedProxyKey !== undefined) {
      const presented = c.req.header(PROXY_KEY_HEADER);
      if (presented === undefined || !safeKeyCompare(presented, expectedProxyKey)) {
        // Don't surface "wrong key" vs "missing key" — both look 401 to a
        // would-be spoofer. Real misconfigurations still surface in logs.
        c.var.logger.warn(
          { hasProxyKey: presented !== undefined, presentedLength: presented?.length ?? 0 },
          'untrusted proxy: missing or wrong X-Atelier-Proxy-Key',
        );
        return c.json({ error: 'unauthorized' }, 401);
      }
    }
    const headerName = c.var.config.AUTH_HEADER_USER;
    const userId = c.req.header(headerName);
    if (!userId) {
      c.var.logger.warn({ headerName }, 'missing Remote-User');
      return c.json({ error: 'missing Remote-User' }, 401);
    }
    if (!USER_ID_PATTERN.test(userId)) {
      c.var.logger.warn({ headerName }, 'malformed Remote-User');
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('userId', userId);
    await next();
    return;
  });
