import { Hono } from 'hono';
import type { AppEnv } from '../server-env';
import { parseBody } from './_http';
import { MetricsBody } from './metrics.schema';

const RATE_PER_SEC = 5;
const BURST = 20;
const buckets = new Map<string, { tokens: number; lastRefill: number }>();

// A bucket idle this long has fully refilled (empty→BURST takes BURST/RATE = 4s),
// so it is indistinguishable from a fresh one and safe to drop. Request-driven
// sweep (no background timer) keeps the map bounded by recently-active users.
const BUCKET_IDLE_EVICT_MS = 60_000;
const BUCKET_SWEEP_INTERVAL_MS = 5 * 60_000;
let lastSweep = 0;

function sweepIdleBuckets(now: number): void {
  if (now - lastSweep < BUCKET_SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [userId, bucket] of buckets) {
    if (now - bucket.lastRefill >= BUCKET_IDLE_EVICT_MS) buckets.delete(userId);
  }
}

function takeToken(userId: string): boolean {
  const now = Date.now();
  sweepIdleBuckets(now);
  let bucket = buckets.get(userId);
  if (!bucket) {
    bucket = { tokens: BURST, lastRefill: now };
    buckets.set(userId, bucket);
  }
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(BURST, bucket.tokens + elapsed * RATE_PER_SEC);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function loggableMetric(body: MetricsBody): Record<string, unknown> {
  if (body.kind === 'vitals') {
    return {
      kind: body.kind,
      name: body.name,
      value: body.value,
      ...(body.delta !== undefined ? { delta: body.delta } : {}),
      ...(body.rating !== undefined ? { rating: body.rating } : {}),
    };
  }
  return {
    kind: body.kind,
    messageChars: body.message.length,
  };
}

export const metricsRoutes = new Hono<{ Variables: AppEnv['Variables'] }>().post('/_metrics', async (c) => {
  if (!takeToken(c.var.userId)) return c.body(null, 429);

  // Through the shared funnel so the 400 shape stays single-sourced. Bad JSON
  // now returns the funnel's `invalid JSON` 400 (was a generic validation
  // failure); harmless here — the caller is navigator.sendBeacon, which
  // discards the response.
  const parsed = await parseBody(c, MetricsBody);
  if (!parsed.ok) return parsed.response;

  const body = parsed.value;
  if (body.kind === 'vitals') {
    c.var.logger.info({ userId: c.var.userId, metric: loggableMetric(body) }, 'web-vitals');
  } else {
    c.var.logger.warn({ userId: c.var.userId, render_error: loggableMetric(body) }, 'frontend-render-error');
  }
  return c.body(null, 204);
});

export default metricsRoutes;
