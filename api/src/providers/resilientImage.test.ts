import { describe, expect, test } from 'bun:test';
import { resilientImageProvider, type GateHook } from './resilientImage';
import { buildResilientPolicy } from '../lifecycle/resilient-call';
import type { Provider, ProviderResult } from './types';

const noopGate: GateHook = {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  noteBreakerState() {},
};

function fakeProvider(scripts: ProviderResult[][]): Provider {
  let call = 0;
  return {
    id: 'fake',
    backend: 'cloud',
    async *generate() {
      await Promise.resolve();
      const frames = scripts[Math.min(call, scripts.length - 1)] ?? [];
      call += 1;
      for (const f of frames) yield f;
    },
  };
}

function policy(over: Partial<Parameters<typeof buildResilientPolicy>[0]> = {}) {
  return buildResilientPolicy({
    timeoutPerAttemptMs: 0, noTimeout: true, maxAttempts: 3,
    initialBackoffMs: 1, maxBackoffMs: 1, breakerThreshold: 5,
    halfOpenAfterMs: 60_000, breakerOutsideRetry: true, ...over,
  });
}

const fail503: ProviderResult = { status: 'failed', seed: 1, index: 0, error: { status: 503, reason: { kind: 'http', status: 503, raw: 'auth_unavailable' } } };
const fail504: ProviderResult = { status: 'failed', seed: 1, index: 0, error: { status: 504, reason: { kind: 'http', status: 504, raw: 'gateway timeout' } } };
const fail429SubFloor: ProviderResult = {
  status: 'failed',
  seed: 1,
  index: 0,
  error: { status: 429, retryAfterMs: 25, reason: { kind: 'http', status: 429, raw: 'rate limited' } },
};
const fail429Huge: ProviderResult = {
  status: 'failed',
  seed: 1,
  index: 0,
  error: { status: 429, retryAfterMs: 5_000, reason: { kind: 'http', status: 429, raw: 'rate limited' } },
};
const fail429NoHeader: ProviderResult = {
  status: 'failed',
  seed: 1,
  index: 0,
  error: { status: 429, reason: { kind: 'http', status: 429, raw: 'rate limited' } },
};
const ready: ProviderResult = { status: 'ready', seed: 1, index: 0, bytes: new Uint8Array([1]), ext: 'png', mime: 'image/png' };
const partial: ProviderResult = {
  status: 'partial',
  seed: 1,
  preview: 'data:image/png;base64,AA==',
  index: 0,
  batchIndex: 0,
};
const policy400: ProviderResult = { status: 'failed', seed: 1, index: 0, error: { status: 400, reason: { kind: 'http', status: 400, raw: 'moderation_blocked' } } };

const req = { prompt: 'x', modelId: 'm', ratio: '1:1' as const, tileIndex: 0, seed: 1 };

async function drain(p: Provider, signal = new AbortController().signal): Promise<ProviderResult[]> {
  const out: ProviderResult[] = [];
  for await (const f of p.generate(req, signal)) out.push(f);
  return out;
}

async function retryGapFor(
  firstFailure: ProviderResult,
  over: Partial<Parameters<typeof buildResilientPolicy>[0]> = {},
): Promise<number> {
  let calls = 0;
  let failedAt = 0;
  let retriedAt = 0;
  const base: Provider = {
    id: 'f',
    backend: 'cloud',
    async *generate() {
      await Promise.resolve();
      calls += 1;
      if (calls === 1) {
        failedAt = performance.now();
        yield firstFailure;
        return;
      }
      retriedAt = performance.now();
      yield ready;
    },
  };
  const dec = resilientImageProvider(base, {
    modelId: 'm',
    pool: 'shared',
    policy: policy({ maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 1, ...over }),
    gate: noopGate,
  });
  expect((await drain(dec)).at(-1)?.status).toBe('ready');
  return retriedAt - failedAt;
}

describe('resilientImageProvider', () => {
  test('retries 503 then succeeds', async () => {
    const base = fakeProvider([[fail503], [fail503], [ready]]);
    const dec = resilientImageProvider(base, { modelId: 'm', pool: 'shared', policy: policy(), gate: noopGate });
    expect((await drain(dec)).at(-1)?.status).toBe('ready');
  });

  // 502 is the status the cliproxy adapter stamps onto in-stream server-class
  // error frames (credential cooldown, no-image-output, severed upstream) —
  // it must stay in the transient set or those failures silently lose retry.
  test('retries 502 then succeeds', async () => {
    const fail502: ProviderResult = {
      status: 'failed',
      seed: 1,
      index: 0,
      error: { status: 502, reason: { kind: 'http', status: 502, raw: 'upstream did not return image output' } },
    };
    const base = fakeProvider([[fail502], [ready]]);
    const dec = resilientImageProvider(base, { modelId: 'm', pool: 'shared', policy: policy(), gate: noopGate });
    expect((await drain(dec)).at(-1)?.status).toBe('ready');
  });

  test('exhausted 503 yields preserved failed frame stamped service-unavailable', async () => {
    const base = fakeProvider([[fail503]]);
    const dec = resilientImageProvider(base, { modelId: 'm', pool: 'shared', policy: policy(), gate: noopGate });
    const last = (await drain(dec)).at(-1);
    expect(last?.status).toBe('failed');
    expect((last as { error: { reason?: { kind?: string } } }).error.reason?.kind).toBe('service-unavailable');
  });

  test('400 content-policy is not retried (single underlying call)', async () => {
    let calls = 0;
    const base: Provider = { id: 'f', backend: 'cloud', async *generate() { await Promise.resolve(); calls += 1; yield policy400; } };
    const dec = resilientImageProvider(base, { modelId: 'm', pool: 'shared', policy: policy(), gate: noopGate });
    const out = await drain(dec);
    expect(calls).toBe(1);
    expect(out).toEqual([policy400]);
  });

  test('partial then failure is not retried/replayed', async () => {
    let calls = 0;
    const base: Provider = { id: 'f', backend: 'cloud', async *generate() { await Promise.resolve(); calls += 1; yield partial; yield fail503; } };
    const dec = resilientImageProvider(base, { modelId: 'm', pool: 'shared', policy: policy(), gate: noopGate });
    const out = await drain(dec);
    expect(calls).toBe(1);
    expect(out[0]?.status).toBe('partial');
    expect(out[1]?.status).toBe('failed');
  });

  test('returns the established child iterator when the wrapper closes after terminal handoff', async () => {
    let cleanupRan = false;
    const base: Provider = {
      id: 'f',
      backend: 'cloud',
      async *generate() {
        await Promise.resolve();
        try {
          yield ready;
        } finally {
          cleanupRan = true;
        }
      },
    };
    const dec = resilientImageProvider(base, { modelId: 'm', pool: 'shared', policy: policy(), gate: noopGate });
    const iterator = dec.generate(req, new AbortController().signal)[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.done).toBe(false);
    if (first.done) throw new Error('expected ready frame');
    expect(first.value.status).toBe('ready');
    await iterator.return?.();

    expect(cleanupRan).toBe(true);
  });

  test('429 backoff is floored and capped; 504 stays fast', async () => {
    // maxBackoffMs (100) > floor (40) so the two clamps are distinguishable.
    const over = { maxBackoffMs: 100, rateLimitBackoffFloorMs: 40 } as const;
    const delay504 = await retryGapFor(fail504, over);
    const delay429SubFloor = await retryGapFor(fail429SubFloor, over);
    const delay429Huge = await retryGapFor(fail429Huge, over);
    const delay429NoHeader = await retryGapFor(fail429NoHeader, over);

    // 5xx retries on the fast exponential backoff (capped at maxBackoffMs).
    expect(delay504).toBeLessThan(25);
    // A sub-floor Retry-After (25ms) on a 429 must be raised to the floor (~40ms),
    // not honored verbatim — this is the bypass the floor exists to prevent.
    expect(delay429SubFloor).toBeGreaterThanOrEqual(38);
    // A huge Retry-After (5s) on a 429 is capped at maxBackoffMs (~100ms) so it
    // never pins a concurrency-pool slot for the upstream's full cool-down.
    expect(delay429Huge).toBeLessThan(250);
    expect(delay429Huge).toBeGreaterThanOrEqual(38);
    // A 429 with no Retry-After header still respects the floor.
    expect(delay429NoHeader).toBeGreaterThanOrEqual(38);
  });

  test('abort during does not invoke base again', async () => {
    let calls = 0;
    const ac = new AbortController();
    const base: Provider = { id: 'f', backend: 'cloud', async *generate() { await Promise.resolve(); calls += 1; ac.abort(); yield fail503; } };
    const dec = resilientImageProvider(base, { modelId: 'm', pool: 'shared', policy: policy(), gate: noopGate });
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await drain(dec, ac.signal).catch(() => {});
    expect(calls).toBe(1);
  });
});
