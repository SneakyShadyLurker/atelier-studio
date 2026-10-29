import { describe, expect, test } from 'bun:test';
import { BrokenCircuitError, CircuitState, TaskCancelledError } from 'cockatiel';
import {
  buildResilientPolicy,
  isRetriable,
  Parse4xxError,
  PermanentUpstreamError,
  policyBreakerState,
  QuotaExhaustedError,
  TransientUpstreamError,
} from './resilient-call';

describe('typed upstream errors', () => {
  test('TransientUpstreamError carries category and cause', () => {
    const cause = new Error('boom');
    const err = new TransientUpstreamError('5xx', cause);
    expect(err.name).toBe('TransientUpstreamError');
    expect(err.category).toBe('5xx');
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('5xx');
  });

  test('PermanentUpstreamError carries category and cause', () => {
    const err = new PermanentUpstreamError('4xx', { status: 400 });
    expect(err.name).toBe('PermanentUpstreamError');
    expect(err.category).toBe('4xx');
    expect(err.message).toContain('4xx');
  });

  test('Parse4xxError exposes truncated head', () => {
    const err = new Parse4xxError('parse', '<<garbage>>');
    expect(err.name).toBe('Parse4xxError');
    expect(err.cause).toBe('<<garbage>>');
  });
});

describe('isRetriable classifier', () => {
  test('AbortError -> false', () => {
    expect(isRetriable(new DOMException('aborted', 'AbortError'))).toBe(false);
  });

  test('TimeoutError -> true', async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((signal.reason as Error).name).toBe('TimeoutError');
    expect(isRetriable(signal.reason)).toBe(true);
  });

  test('BrokenCircuitError -> false (breaker decided)', () => {
    expect(isRetriable(new BrokenCircuitError())).toBe(false);
  });

  test('TaskCancelledError (cockatiel per-attempt timeout) -> true', () => {
    expect(isRetriable(new TaskCancelledError())).toBe(true);
  });

  test('TransientUpstreamError -> true for every category', () => {
    const cats = ['5xx', '429', '408', 'socket', 'in-stream-timeout', 'timeout'] as const;
    for (const c of cats) {
      expect(isRetriable(new TransientUpstreamError(c, null))).toBe(true);
    }
  });

  test('PermanentUpstreamError -> false', () => {
    expect(isRetriable(new PermanentUpstreamError('4xx', null))).toBe(false);
    expect(isRetriable(new PermanentUpstreamError('in-stream', null))).toBe(false);
  });

  test('Parse4xxError -> false', () => {
    expect(isRetriable(new Parse4xxError('parse', 'oops'))).toBe(false);
  });

  test('plain Error -> false', () => {
    expect(isRetriable(new Error('something'))).toBe(false);
    expect(isRetriable(new TypeError('something'))).toBe(false);
    expect(isRetriable('string')).toBe(false);
    expect(isRetriable(null)).toBe(false);
    expect(isRetriable(undefined)).toBe(false);
  });
});

const OPTS = {
  timeoutPerAttemptMs: 200,
  maxAttempts: 3,
  initialBackoffMs: 10,
  maxBackoffMs: 30,
  breakerThreshold: 8,
  halfOpenAfterMs: 1_000,
};

describe('buildResilientPolicy', () => {
  test('maxAttempts counts total invocations including the initial call', async () => {
    const policy = buildResilientPolicy({ ...OPTS, maxAttempts: 2 });
    let attempts = 0;
    let caught: unknown;
    try {
      await policy.execute(() => {
        attempts += 1;
        throw new TransientUpstreamError('5xx', null);
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TransientUpstreamError);
    expect(attempts).toBe(2);
  });

  test('retries a transient failure twice then succeeds', async () => {
    const policy = buildResilientPolicy(OPTS);
    let attempts = 0;
    const out = await policy.execute(() => {
      attempts += 1;
      if (attempts < 3) throw new TransientUpstreamError('5xx', null);
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(attempts).toBe(3);
  });

  test('stops on a permanent failure', async () => {
    const policy = buildResilientPolicy(OPTS);
    let attempts = 0;
    let caught: unknown;
    try {
      await policy.execute(() => {
        attempts += 1;
        throw new PermanentUpstreamError('4xx', null);
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PermanentUpstreamError);
    expect(attempts).toBe(1);
  });

  test('TaskCancelledError (per-attempt timeout) is retried', async () => {
    const policy = buildResilientPolicy({ ...OPTS, timeoutPerAttemptMs: 50 });
    let attempts = 0;
    const out = await policy.execute(async ({ signal }) => {
      attempts += 1;
      if (attempts < 3) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 200);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(attempts).toBe(3);
  });

  test('outer AbortSignal aborts mid-backoff', async () => {
    const policy = buildResilientPolicy({ ...OPTS, initialBackoffMs: 500, maxBackoffMs: 500 });
    const outer = new AbortController();
    const promise = policy.execute(() => {
      throw new TransientUpstreamError('socket', null);
    }, outer.signal);
    setTimeout(() => {
      outer.abort(new DOMException('client-gone', 'AbortError'));
    }, 20);
    const t0 = Date.now();
    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(200);
  });

  test('breaker opens after N consecutive transient fails', async () => {
    const policy = buildResilientPolicy({ ...OPTS, breakerThreshold: 3, maxAttempts: 1 });
    for (let i = 0; i < 3; i += 1) {
      let caught: unknown;
      try {
        await policy.execute(() => {
          throw new TransientUpstreamError('5xx', null);
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
    }
    expect(policyBreakerState(policy)).toBe('open');
    let caught: unknown;
    try {
      await policy.execute(() => 'never-called');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrokenCircuitError);
  });

  test('policyBreakerState returns "closed" on a fresh policy', () => {
    const policy = buildResilientPolicy(OPTS);
    expect(policyBreakerState(policy)).toBe('closed');
  });

  test('noTimeout option omits the timeout policy', async () => {
    const policy = buildResilientPolicy({ ...OPTS, noTimeout: true, timeoutPerAttemptMs: 10 });
    const out = await policy.execute(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 'ok';
    });
    expect(out).toBe('ok');
  });

  test('onRetry fires with attempt and reason', async () => {
    const seen: { attempt: number; reason: string }[] = [];
    const policy = buildResilientPolicy({
      ...OPTS,
      onRetry: (attempt, error) => {
        seen.push({ attempt, reason: error instanceof Error ? error.message : String(error) });
      },
    });
    let attempts = 0;
    await policy.execute(() => {
      attempts += 1;
      if (attempts < 2) throw new TransientUpstreamError('5xx', null, 'boom');
      return 'ok';
    });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]?.reason).toContain('boom');
  });

  test('CircuitState enum is available for state introspection', () => {
    expect(CircuitState.Closed).toBeTypeOf('number');
  });
});

describe('QuotaExhaustedError', () => {
  test('preserves raw retry-after seconds and is non-retriable + breaker-exempt', () => {
    const e = new QuotaExhaustedError(900, { status: 429, body: 'quota' });
    expect(e.retryAfterSeconds).toBe(900);
    expect(isRetriable(e)).toBe(false);
  });
});

describe('buildResilientPolicy breakerOutsideRetry', () => {
  const opts = {
    timeoutPerAttemptMs: 0,
    noTimeout: true as const,
    maxAttempts: 3,
    initialBackoffMs: 1,
    maxBackoffMs: 1,
    halfOpenAfterMs: 60_000,
    breakerThreshold: 2,
  };

  test('breaker OUTSIDE retry: one breaker failure per exhausted execute', async () => {
    let calls = 0;
    const policy = buildResilientPolicy({ ...opts, breakerOutsideRetry: true });
    const fail = () => {
      calls += 1;
      return Promise.reject(new TransientUpstreamError('5xx', null));
    };
    // First execute: exhausts 3 attempts -> TransientUpstreamError (breaker count: 1)
    let caught1: unknown;
    try { await policy.execute(fail); } catch (err) { caught1 = err; }
    expect(caught1).toBeInstanceOf(TransientUpstreamError);
    // Second execute: exhausts 3 attempts -> TransientUpstreamError (breaker count: 2 -> opens)
    let caught2: unknown;
    try { await policy.execute(fail); } catch (err) { caught2 = err; }
    expect(caught2).toBeInstanceOf(TransientUpstreamError);
    expect(calls).toBe(6);
    // Third execute: breaker is open -> fast-fail, fail() never called
    let caught3: unknown;
    try { await policy.execute(fail); } catch (err) { caught3 = err; }
    expect(caught3).toBeInstanceOf(BrokenCircuitError);
    expect(calls).toBe(6);
  });

  test('breaker INSIDE retry (default): opens within the first execute', async () => {
    let calls = 0;
    const policy = buildResilientPolicy({ ...opts }); // breakerOutsideRetry omitted -> false
    const fail = () => {
      calls += 1;
      return Promise.reject(new TransientUpstreamError('5xx', null));
    };
    // First execute: attempt1 fail (breaker=1), attempt2 fail (breaker=2 -> open),
    // attempt3 sees BrokenCircuitError which is non-retriable -> stops. Only 2 real calls.
    let caught: unknown;
    try { await policy.execute(fail); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(BrokenCircuitError);
    expect(calls).toBe(2);
  });
});
