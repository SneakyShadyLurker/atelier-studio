import { RECOVERY_REQUIRED_ERROR } from '@atelier/shared';
import type { ApiErrorCode, ByokKeyStatus } from '@atelier/shared';
import { Hono } from 'hono';
import { probeGoogleKey } from '../providers/google';
import type { AppEnv } from '../server-env';
import { parseBody } from './_http';
import { PutKeyBody } from './keys.schema';
import { ensureUser } from '../db/users';
import { RECOVERY_REQUIRED_MESSAGE, RecoveryRequiredError } from '../keystore';

const PROBE_TIMEOUT_MS = 10_000;
const MAX_GLOBAL_KEY_PROBES = 4;
const MAX_KEY_PROBES_PER_USER = 1;

let globalKeyProbes = 0;
const keyProbesByUser = new Map<string, number>();

function acquireKeyProbe(userId: string): boolean {
  const userCount = keyProbesByUser.get(userId) ?? 0;
  if (globalKeyProbes >= MAX_GLOBAL_KEY_PROBES || userCount >= MAX_KEY_PROBES_PER_USER) return false;
  globalKeyProbes += 1;
  keyProbesByUser.set(userId, userCount + 1);
  return true;
}

function releaseKeyProbe(userId: string): void {
  globalKeyProbes = Math.max(0, globalKeyProbes - 1);
  const next = Math.max(0, (keyProbesByUser.get(userId) ?? 0) - 1);
  if (next === 0) {
    keyProbesByUser.delete(userId);
  } else {
    keyProbesByUser.set(userId, next);
  }
}

export function resetKeyProbeRuntimeForTests(): void {
  globalKeyProbes = 0;
  keyProbesByUser.clear();
}

export const keysRoutes = new Hono<AppEnv>()
  .get('/keys/google', (c) => {
    if (!c.var.keyStore) {
      return c.json({ error: 'byok-not-configured' as const }, 503);
    }

    const row = c.var.db
      .query<{ fingerprint: string; updated_at: number }, [string, string]>(
        `SELECT fingerprint, updated_at
           FROM user_provider_keys
          WHERE user_id = ? AND provider = ?`,
      )
      .get(c.var.userId, 'google');

    const status: ByokKeyStatus = row
      ? { present: true, fingerprint: row.fingerprint, updatedAt: row.updated_at }
      : { present: false };
    return c.json(status);
  })
  .put('/keys/google', async (c) => {
    if (!c.var.keyStore) {
      return c.json({ error: 'byok-not-configured' as const }, 503);
    }

    const parsed = await parseBody(c, PutKeyBody);
    if (!parsed.ok) return parsed.response;

    if (!acquireKeyProbe(c.var.userId)) {
      return c.json({ error: 'key validation already in progress' as const }, 429);
    }
    const probe = await (async () => {
      try {
        return await probeGoogleKey(parsed.value.key, PROBE_TIMEOUT_MS);
      } finally {
        releaseKeyProbe(c.var.userId);
      }
    })();
    if (!probe.ok) {
      // Both failure kinds reach the user as one of two fixed messages; the
      // status and error class here are what tells a bad key from an outage.
      c.var.logger.warn(
        {
          event: 'byok_key_probe_failed',
          provider: 'google',
          failureKind: probe.reason,
          upstreamStatus: probe.status,
          ...(probe.errorType === undefined ? {} : { errorType: probe.errorType }),
        },
        'google key probe failed',
      );
    }
    if (!probe.ok && probe.reason === 'unavailable') {
      return c.json(
        { error: 'google unreachable' as const, code: 'GOOGLE_UNAVAILABLE' satisfies ApiErrorCode },
        503,
      );
    }
    if (!probe.ok) {
      return c.json(
        { error: 'google rejected the key' as const, code: 'GOOGLE_AUTH_FAILED' satisfies ApiErrorCode },
        400,
      );
    }

    let put: { fingerprint: string; updatedAt: number };
    try {
      const createdAt = Date.now();
      put = await c.var.keyStore.put(c.var.userId, 'google', parsed.value.key, {
        beforeWrite: () => {
          ensureUser(c.var.db, c.var.userId, createdAt);
        },
      });
    } catch (error) {
      if (error instanceof RecoveryRequiredError) {
        c.var.logger.warn(
          { event: 'byok_put_under_rotation', userId: c.var.userId, provider: 'google' },
          'BYOK put requires explicit recovery',
        );
        return c.json(
          { error: RECOVERY_REQUIRED_ERROR, message: RECOVERY_REQUIRED_MESSAGE },
          409,
        );
      }
      throw error;
    }
    const status: ByokKeyStatus = {
      present: true,
      fingerprint: put.fingerprint,
      updatedAt: put.updatedAt,
    };
    return c.json(status);
  })
  .delete('/keys/google', async (c) => {
    if (!c.var.keyStore) {
      return c.json({ error: 'byok-not-configured' as const }, 503);
    }

    await c.var.keyStore.delete(c.var.userId, 'google');
    return new Response(null, { status: 204 });
  });
