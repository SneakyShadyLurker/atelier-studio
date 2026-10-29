import { describe, expect, test } from 'bun:test';
import {
  classifyQueueFull,
  clampRetryAfterMs,
  jitterRetryDelayMs,
  nextBackpressureDelayMs,
  QueueFullError,
} from './queueFullRetry';
import { QuotaExhaustedError } from './sse';

function json429(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  });
}

describe('clampRetryAfterMs', () => {
  test('clamps to the [800, 3000] window', () => {
    expect(clampRetryAfterMs(0)).toBe(800);
    expect(clampRetryAfterMs(undefined)).toBe(1000);
    expect(clampRetryAfterMs(1)).toBe(1000);
    expect(clampRetryAfterMs(5)).toBe(3000);
  });
});

describe('QUEUE_FULL scheduling', () => {
  test('jitters retry delays across the full ±20% window', () => {
    expect(jitterRetryDelayMs(1000, () => 0)).toBe(800);
    expect(jitterRetryDelayMs(1000, () => 0.5)).toBe(1000);
    expect(jitterRetryDelayMs(1000, () => 1)).toBe(1200);
  });

  test('grows zero-progress delays exponentially, caps at 15s, and resets on progress', () => {
    expect(nextBackpressureDelayMs(0, 2500, false)).toBe(2500);
    expect(nextBackpressureDelayMs(2500, 1000, false)).toBe(5000);
    expect(nextBackpressureDelayMs(10_000, 1000, false)).toBe(15_000);
    expect(nextBackpressureDelayMs(15_000, 3000, true)).toBe(3000);
  });
});

describe('classifyQueueFull', () => {
  test('returns the clamped delay for a QUEUE_FULL 429', async () => {
    const out = await classifyQueueFull(json429({ error: 'queue full', code: 'QUEUE_FULL', retry_after_seconds: 2 }));
    expect(out).toBe(2000);
  });

  test('returns null for a non-QUEUE_FULL 429 (e.g. VIDEO_BUSY) — NOT drain backpressure', async () => {
    const out = await classifyQueueFull(json429({ error: 'busy', code: 'VIDEO_BUSY', retry_after_seconds: 5 }));
    expect(out).toBeNull();
  });

  test('throws a typed quota error with the server retry hint', async () => {
    let caught: unknown;
    try {
      await classifyQueueFull(json429({
        error: 'text quota exhausted',
        code: 'QUOTA_EXHAUSTED',
        retry_after_seconds: 900,
      }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QuotaExhaustedError);
    expect((caught as QuotaExhaustedError).retryAfterSeconds).toBe(900);
  });

  test('an unreadable 429 body (e.g. an edge-proxy HTML 429) is NOT backpressure → null', async () => {
    const res = new Response('not json', { status: 429, headers: { 'content-type': 'text/plain' } });
    expect(await classifyQueueFull(res)).toBeNull();
  });

  test('returns null when a 429 carries no code field', async () => {
    expect(await classifyQueueFull(json429({ error: 'nope' }))).toBeNull();
  });
});

describe('QueueFullError', () => {
  test('carries the retry delay and is named', () => {
    const err = new QueueFullError(1500);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('QueueFullError');
    expect(err.retryAfterMs).toBe(1500);
  });
});
