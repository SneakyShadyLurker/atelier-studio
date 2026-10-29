import { RETRY_AFTER_FIELD, type ApiErrorCode } from '@atelier/shared';
import { Hono } from 'hono';
import { findModel, isLocalModelGated, publicModelsForUser } from '../providers/registry';
import type { AppEnv } from '../server-env';

const PROBE_BUDGET_CAPACITY = 10;
const PROBE_BUDGET_WINDOW_MS = 30_000;
const PROBE_TOKEN_REFILL_MS = PROBE_BUDGET_WINDOW_MS / PROBE_BUDGET_CAPACITY;
const PROBE_BUCKET_IDLE_EVICT_MS = 5 * 60_000;
const PROBE_BUCKET_SWEEP_INTERVAL_MS = 5 * 60_000;

interface ProbeBucket {
  tokens: number;
  lastRefill: number;
}

const probeBuckets = new Map<string, ProbeBucket>();
let lastProbeBucketSweep = 0;

function sweepProbeBuckets(now: number): void {
  if (now - lastProbeBucketSweep < PROBE_BUCKET_SWEEP_INTERVAL_MS) return;
  lastProbeBucketSweep = now;
  for (const [userId, bucket] of probeBuckets) {
    if (now - bucket.lastRefill >= PROBE_BUCKET_IDLE_EVICT_MS) probeBuckets.delete(userId);
  }
}

function takeProbeToken(userId: string): { ok: true } | { ok: false; retryAfterMs: number } {
  const now = Date.now();
  sweepProbeBuckets(now);
  let bucket = probeBuckets.get(userId);
  if (bucket === undefined) {
    bucket = { tokens: PROBE_BUDGET_CAPACITY, lastRefill: now };
    probeBuckets.set(userId, bucket);
  }
  const elapsed = Math.max(0, now - bucket.lastRefill);
  bucket.tokens = Math.min(
    PROBE_BUDGET_CAPACITY,
    bucket.tokens + elapsed / PROBE_TOKEN_REFILL_MS,
  );
  bucket.lastRefill = now;
  if (bucket.tokens < 1) {
    return {
      ok: false,
      retryAfterMs: Math.max(1, Math.ceil((1 - bucket.tokens) * PROBE_TOKEN_REFILL_MS)),
    };
  }
  bucket.tokens -= 1;
  return { ok: true };
}

// `c.var.healthSnapshot()` is a cached pointer into the lifecycle health
// probe (see `lifecycle/health-probe.ts`) — no upstream probe per request.
// `private, max-age=15` lets multi-tab opens dedupe at the browser layer
// without diverging from the 30s client `refetchInterval` (web/src/api/
// models.ts). Keep < the client interval so the cache-window never extends
// staleness beyond the polling cadence.
export const modelsRoutes = new Hono<AppEnv>().get('/models', async (c) => {
  const models = await publicModelsForUser(c.var.config, {
    userId: c.var.userId,
    keyStore: c.var.keyStore,
    availability: c.var.healthSnapshot(),
  });
  c.header('Cache-Control', 'private, max-age=15');
  return c.json(models);
});

modelsRoutes.post('/models/:modelId/probe', async (c) => {
  const modelId = c.req.param('modelId');
  const entry = findModel(modelId, c.var.config);
  if (!entry || isLocalModelGated(c.var.config, c.var.userId, entry)) {
    return c.json({ error: 'not found' }, 404);
  }
  if (entry.model.pool === 'local') {
    const budget = takeProbeToken(c.var.userId);
    if (!budget.ok) {
      const retryAfterSeconds = Math.max(1, Math.ceil(budget.retryAfterMs / 1000));
      c.header('Retry-After', String(retryAfterSeconds));
      return c.json({
        error: 'queue full',
        code: 'QUEUE_FULL' satisfies ApiErrorCode,
        reason: 'user',
        [RETRY_AFTER_FIELD]: retryAfterSeconds,
        retryAfterMs: budget.retryAfterMs,
      }, 429);
    }
  }
  await c.var.probeModelNow(modelId);
  const models = await publicModelsForUser(c.var.config, {
    userId: c.var.userId,
    keyStore: c.var.keyStore,
    availability: c.var.healthSnapshot(),
  });
  c.header('Cache-Control', 'no-store');
  return c.json(models);
});
