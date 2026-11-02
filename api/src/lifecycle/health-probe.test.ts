import { afterEach, describe, expect, test } from 'bun:test';
import type { ModelAvailabilityReason } from '@atelier/shared';
import pino from 'pino';
import { createLogger } from '../observability/logger';
import type { RegistryEntry } from '../providers/registry';
import type { HealthResult, Provider } from '../providers/types';
import { sanitizeProbeReason, startHealthProbe } from './health-probe';

const silentLogger = pino({ level: 'silent' });
const originalDateNow = Date.now;

afterEach(() => {
  Date.now = originalDateNow;
});

// Generate is never invoked by the health-probe; this stub yields once after
// an awaited resolve so both `require-yield` and `require-await` are happy.
async function* unusedGenerate(): AsyncIterable<{ status: 'failed'; error: string; seed: number; index: number }> {
  await Promise.resolve();
  yield { status: 'failed', error: 'health-probe test stub — generate not used', seed: 0, index: 0 };
}

function localEntry(opts: {
  id: string;
  healthCheck?: Provider['healthCheck'];
}): RegistryEntry {
  const provider: Provider = {
    id: opts.id,
    backend: 'local',
    generate: unusedGenerate,
    ...(opts.healthCheck ? { healthCheck: opts.healthCheck } : {}),
  };
  return {
    model: {
      id: opts.id,
      name: opts.id,
      backend: 'local',
      pool: 'local',
      tag: 'test',
      latency: 'instant',
      supportedRatios: ['1:1'],
      concurrencyCapPerUser: 1,
      maxCountPerBatch: 1,
    },
    bind: () => provider,
    timeoutMs: ({ local }) => local,
  };
}

function sharedEntry(id: string, healthCheck?: Provider['healthCheck']): RegistryEntry {
  const provider: Provider = {
    id,
    backend: 'cloud',
    generate: unusedGenerate,
    ...(healthCheck ? { healthCheck } : {}),
  };
  return {
    model: {
      id,
      name: id,
      backend: 'cloud',
      pool: 'shared',
      tag: 'test',
      latency: 'instant',
      supportedRatios: ['1:1'],
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 4,
    },
    bind: () => provider,
    timeoutMs: ({ cloud }) => cloud,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('startHealthProbe', () => {
  test('seeds local targets as offline with no reason before the first probe completes', () => {
    // Probe never resolves — we only inspect the snapshot before the first
    // round lands. Synchronous read after construction = boot-window state.
    // The seed used to ship `reason: 'pending first probe'` on the wire,
    // which leaked process-restart timing to authenticated users. The seed
    // now uses an internal Set flag instead; the public snapshot has no
    // `reason` until the first probe round produces a real result.
    const handle = startHealthProbe({
      registry: [
        localEntry({
          id: 'local-pending',
          healthCheck: () => new Promise<{ ok: true }>(() => undefined),
        }),
      ],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 60_000,
    });
    const snap = handle.snapshot().get('local-pending');
    expect(snap?.ok).toBe(false);
    expect(snap?.reason).toBeUndefined();
    handle.stop();
  });

  test('records ok results for healthy local providers', async () => {
    const handle = startHealthProbe({
      registry: [localEntry({ id: 'local-ok', healthCheck: () => Promise.resolve({ ok: true }) })],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 1_000,
    });
    await flush();
    await flush();
    const snap = handle.snapshot().get('local-ok');
    expect(snap?.ok).toBe(true);
    expect(typeof snap?.checkedAt).toBe('number');
    handle.stop();
  });

  test('sanitizes a healthCheck-returned offline reason into the closed vocabulary', async () => {
    // The provider's healthCheck returned `{ ok: false, reason: 'ECONNREFUSED' }`
    // — that raw string used to ship verbatim on /api/models. Now it's
    // squashed to the operational category `'unavailable'`.
    const lines: string[] = [];
    const logger = createLogger({ LOG_LEVEL: 'info' }, { write: (line) => lines.push(line) });
    const handle = startHealthProbe({
      registry: [
        localEntry({
          id: 'local-down',
          healthCheck: () => Promise.resolve({ ok: false, reason: 'ECONNREFUSED PRIVATE_TEXT',
            probeCode: 'PRIVATE_TEXT' } as unknown as HealthResult),
        }),
      ],
      logger,
      intervalMs: 60_000,
      probeTimeoutMs: 1_000,
    });
    await flush();
    await flush();
    const snap = handle.snapshot().get('local-down');
    expect(snap?.ok).toBe(false);
    expect(snap?.reason).toBe('unavailable');
    const event = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.msg === 'model probe reported offline');
    expect(event).toMatchObject({ probeCode: 'unknown', timedOut: false });
    expect(lines.join('')).not.toContain('PRIVATE_TEXT');
    handle.stop();
  });

  test('does NOT leak raw err.message containing LAN host:port on the wire', async () => {
    // The canonical exploit string from the security audit:
    // `connect ECONNREFUSED 10.0.0.5:8189` from a real fetch failure.
    // The wire surface must never carry the IP/port even when the underlying
    // fetch error string does.
    const handle = startHealthProbe({
      registry: [
        localEntry({
          id: 'local-throws',
          healthCheck: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:8189')),
        }),
      ],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 1_000,
    });
    await flush();
    await flush();
    const snap = handle.snapshot().get('local-throws');
    expect(snap?.ok).toBe(false);
    expect(snap?.reason).toBe('unavailable');
    expect(snap?.reason).not.toContain('10.0.0');
    expect(snap?.reason).not.toContain('ECONNREFUSED');
    handle.stop();
  });

  test('reports `timed out` when the probe budget expires before the upstream answers', async () => {
    // probeTimeoutMs fires before the never-resolving fetch; the wire emits
    // `timed out`, not the raw "probe timeout" message and not "unavailable".
    const handle = startHealthProbe({
      registry: [
        localEntry({
          id: 'local-hangs-then-rejects',
          healthCheck: (signal) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => {
                const reason = signal.reason instanceof Error
                  ? signal.reason
                  : new Error(String(signal.reason));
                reject(reason);
              });
            }),
        }),
      ],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const snap = handle.snapshot().get('local-hangs-then-rejects');
    expect(snap?.ok).toBe(false);
    expect(snap?.reason).toBe('timed out');
    handle.stop();
  });

  test('an upstream AbortError without our timeout is unavailable', async () => {
    const handle = startHealthProbe({
      registry: [
        localEntry({
          id: 'local-abort',
          healthCheck: () => {
            // Real fetch implementations throw a DOMException-shaped error
            // with `name === 'AbortError'` when the signal aborts. Simulate
            // the shape without depending on DOM types.
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            return Promise.reject(err);
          },
        }),
      ],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 60_000,
    });
    await flush();
    await flush();
    const snap = handle.snapshot().get('local-abort');
    expect(snap?.ok).toBe(false);
    expect(snap?.reason).toBe('unavailable');
    handle.stop();
  });

  test('a swallowed timeout reports timed out and only safe diagnostics survive logging', async () => {
    const lines: string[] = [];
    const logger = createLogger({ LOG_LEVEL: 'info' }, { write: (line) => lines.push(line) });
    const handle = startHealthProbe({
      registry: [localEntry({
        id: 'local-swallowed',
        healthCheck: (signal) => new Promise((resolve) => {
          signal.addEventListener('abort', () => { resolve({ ok: false, reason: 'secret 10.0.0.5', probeCode: 'privacy_transport' }); });
        }),
      })],
      logger, intervalMs: 60_000, probeTimeoutMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handle.snapshot().get('local-swallowed')?.reason).toBe('timed out');
    const event = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.msg === 'model probe failed');
    expect(event).toMatchObject({ probeCode: 'timeout', timedOut: true });
    expect(typeof event?.durationMs).toBe('number');
    expect(lines.join('')).not.toContain('10.0.0.5');
    handle.stop();
    await handle.drain();
  });

  test('late success after the budget cannot mark the model online', async () => {
    let resolveLate: ((value: { ok: true }) => void) | undefined;
    const handle = startHealthProbe({
      registry: [localEntry({ id: 'late', healthCheck: () => new Promise((resolve) => { resolveLate = resolve; }) })],
      logger: silentLogger, intervalMs: 60_000, probeTimeoutMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The adapter's underlying work still owns drain until it settles.
    expect(handle.snapshot().get('late')?.reason).toBeUndefined();
    resolveLate?.({ ok: true });
    await flush();
    expect(handle.snapshot().get('late')?.reason).toBe('timed out');
    handle.stop();
    await handle.drain();
  });

  test('shutdown abort stays separate from a budget timeout while cleanup is pending', async () => {
    const lines: string[] = [];
    const logger = createLogger({ LOG_LEVEL: 'info' }, { write: (line) => lines.push(line) });
    let releaseCleanup: ((value: { ok: false; reason: string }) => void) | undefined;
    const handle = startHealthProbe({
      registry: [localEntry({ id: 'stopping', healthCheck: (signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { releaseCleanup = resolve; });
      }) })],
      logger, intervalMs: 60_000, probeTimeoutMs: 20,
    });
    handle.stop();
    let drained = false;
    const draining = handle.drain().then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(drained).toBe(false);
    releaseCleanup?.({ ok: false, reason: 'stopped' });
    await draining;
    expect(handle.snapshot().get('stopping')?.reason).toBeUndefined();
    const event = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.msg === 'model probe failed');
    expect(event).toMatchObject({ probeCode: 'stopped', timedOut: false });
  });

  test('skips cloud (pool=shared) entries entirely', async () => {
    let called = false;
    const handle = startHealthProbe({
      registry: [
        sharedEntry('cloud-ignored', () => {
          called = true;
          return Promise.resolve({ ok: true });
        }),
      ],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 1_000,
    });
    await flush();
    await flush();
    expect(called).toBe(false);
    expect(handle.snapshot().get('cloud-ignored')).toBeUndefined();
    handle.stop();
  });

  test('skips local entries without a healthCheck (treated as always-available)', async () => {
    const handle = startHealthProbe({
      registry: [localEntry({ id: 'local-no-check' })],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 1_000,
    });
    await flush();
    await flush();
    expect(handle.snapshot().get('local-no-check')).toBeUndefined();
    handle.stop();
  });

  test('aborts the probe via the AbortSignal after probeTimeoutMs', async () => {
    let aborted = false;
    const handle = startHealthProbe({
      registry: [
        localEntry({
          id: 'local-hangs',
          healthCheck: (signal) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => {
                aborted = true;
                const reason = signal.reason instanceof Error
                  ? signal.reason
                  : new Error(String(signal.reason));
                reject(reason);
              });
            }),
        }),
      ],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(aborted).toBe(true);
    const snap = handle.snapshot().get('local-hangs');
    expect(snap?.ok).toBe(false);
    handle.stop();
  });

  test('stop() aborts in-flight probes', async () => {
    let aborted = false;
    const handle = startHealthProbe({
      registry: [
        localEntry({
          id: 'local-inflight',
          healthCheck: (signal) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => {
                aborted = true;
                const reason = signal.reason instanceof Error
                  ? signal.reason
                  : new Error(String(signal.reason));
                reject(reason);
              });
            }),
        }),
      ],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 60_000,
    });
    // Let the probe start but not finish (its own timeout is 60s).
    await new Promise((resolve) => setTimeout(resolve, 10));
    handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aborted).toBe(true);
  });

  test('drain() awaits ALL in-flight rounds, not just the latest', async () => {
    // Audit 01-concurrency MED: previously `activeRound` was a single
    // reference reassigned on every `runRound()` call, so if a second round
    // started while the first was still in-flight, drain() would only await
    // the second. In practice `stop()` aborts every in-flight controller, so
    // both rounds settled — but the bookkeeping was brittle. Now we track a
    // Set<Promise> and drain() awaits everything outstanding.
    let firstRoundStarted = false;
    let resolveFirstRound: () => void = () => undefined;
    let resolveSecondRound: () => void = () => undefined;
    let firstRoundSettled = false;
    let secondRoundSettled = false;

    const handle = startHealthProbe({
      registry: [
        localEntry({
          id: 'overlap',
          healthCheck: () => {
            // First probe stalls indefinitely; second probe stalls
            // separately. We control settlement explicitly via the resolvers
            // captured below.
            if (!firstRoundStarted) {
              firstRoundStarted = true;
              return new Promise<{ ok: true }>((resolve) => {
                resolveFirstRound = () => {
                  firstRoundSettled = true;
                  resolve({ ok: true });
                };
              });
            }
            return new Promise<{ ok: true }>((resolve) => {
              resolveSecondRound = () => {
                secondRoundSettled = true;
                resolve({ ok: true });
              };
            });
          },
        }),
      ],
      logger: silentLogger,
      // intervalMs is irrelevant: we manually invoke a second round below by
      // resolving the first round just to drive the scheduler, then stalling
      // again. Easier path: kick a second round via the internal scheduler
      // by setting a tiny intervalMs but holding the second probe's promise.
      intervalMs: 1,
      probeTimeoutMs: 60_000,
    });

    // Wait until the first round's healthCheck has been invoked — proven by
    // `firstRoundStarted` being flipped inside the stub. The second round
    // can't be checked synchronously (it's invoked via setTimeout once the
    // first round resolves), so we poll for the first then schedule below.
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (firstRoundStarted) { clearInterval(interval); resolve(); }
      }, 2);
    });

    // Now resolve the first probe so the second round starts.
    resolveFirstRound();
    // Wait until the second round's healthCheck has been invoked (resolver
    // has been overwritten with a real fn — we detect by polling the flag
    // closure indirectly: the second healthCheck only runs after the first
    // settles + the timer fires).
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // At this point the first round has settled, but the second round is
    // still in flight (its probe is waiting on resolveSecondRound).
    // Stop the probe — this aborts in-flight controllers, but our
    // healthCheck stub doesn't honor the signal (it sits on a Promise that
    // never resolves until WE resolve it). drain() must therefore actually
    // wait for the second round to settle.
    handle.stop();

    let drained = false;
    const drainPromise = handle.drain().then(() => { drained = true; });

    // Give drain a moment — it must NOT resolve while the second round is
    // still pending.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(drained).toBe(false);
    expect(firstRoundSettled).toBe(true);
    expect(secondRoundSettled).toBe(false);

    // Now resolve the second round; drain should resolve shortly after.
    resolveSecondRound();
    await drainPromise;
    expect(drained).toBe(true);
    expect(secondRoundSettled).toBe(true);
  });

  test('stop() halts further probes', async () => {
    let calls = 0;
    const handle = startHealthProbe({
      registry: [
        localEntry({
          id: 'local-counted',
          healthCheck: () => {
            calls += 1;
            return Promise.resolve({ ok: true });
          },
        }),
      ],
      logger: silentLogger,
      intervalMs: 5,
      probeTimeoutMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    handle.stop();
    const afterStop = calls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(afterStop);
  });

  test('probeNow writes the refreshed snapshot', async () => {
    let healthy = false;
    Date.now = () => 1_000;
    const handle = startHealthProbe({
      registry: [localEntry({
        id: 'local-forced',
        healthCheck: () => Promise.resolve(healthy ? { ok: true } : { ok: false, reason: 'down' }),
      })],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 1_000,
    });
    await flush();
    await flush();
    expect(handle.snapshot().get('local-forced')?.ok).toBe(false);

    healthy = true;
    Date.now = () => 4_001;
    const availability = await handle.probeNow('local-forced');

    expect(availability?.ok).toBe(true);
    expect(handle.snapshot().get('local-forced')).toBe(availability);
    handle.stop();
  });

  test('concurrent probeNow calls for one model share one upstream probe', async () => {
    let calls = 0;
    let resolveForced: (value: { ok: true }) => void = () => undefined;
    Date.now = () => 1_000;
    const handle = startHealthProbe({
      registry: [localEntry({
        id: 'local-deduped',
        healthCheck: () => {
          calls += 1;
          if (calls === 1) return Promise.resolve({ ok: false, reason: 'down' });
          return new Promise<{ ok: true }>((resolve) => { resolveForced = resolve; });
        },
      })],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 60_000,
    });
    await flush();
    await flush();
    Date.now = () => 4_001;

    const first = handle.probeNow('local-deduped');
    const second = handle.probeNow('local-deduped');
    expect(second).toBe(first);
    expect(calls).toBe(2);

    resolveForced({ ok: true });
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    handle.stop();
  });

  test('each settled probeNow call performs a fresh upstream probe', async () => {
    let calls = 0;
    Date.now = () => 1_000;
    const handle = startHealthProbe({
      registry: [localEntry({
        id: 'local-recent',
        healthCheck: () => {
          calls += 1;
          return Promise.resolve({ ok: false, reason: 'down' });
        },
      })],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 1_000,
    });
    await flush();
    await flush();
    expect(calls).toBe(1);
    Date.now = () => 1_001;

    await handle.probeNow('local-recent');
    expect(calls).toBe(2);

    Date.now = () => 1_002;
    await handle.probeNow('local-recent');
    expect(calls).toBe(3);
    handle.stop();
  });

  test('an older background result cannot overwrite a committed forced probe', async () => {
    let racedCalls = 0;
    let slowStarted = false;
    let resolveSlow: (value: { ok: true }) => void = () => undefined;
    Date.now = () => 1_000;
    const handle = startHealthProbe({
      registry: [
        localEntry({
          id: 'local-raced',
          healthCheck: () => {
            racedCalls += 1;
            return Promise.resolve(racedCalls === 1
              ? { ok: false as const, reason: 'down' }
              : { ok: true as const });
          },
        }),
        localEntry({
          id: 'local-slow',
          healthCheck: () => new Promise<{ ok: true }>((resolve) => {
            slowStarted = true;
            resolveSlow = resolve;
          }),
        }),
      ],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 60_000,
    });
    await flush();
    expect(slowStarted).toBe(true);
    expect(racedCalls).toBe(1);

    Date.now = () => 1_001;
    const forced = await handle.probeNow('local-raced');
    expect(forced?.ok).toBe(true);
    expect(handle.snapshot().get('local-raced')).toBe(forced);

    resolveSlow({ ok: true });
    await flush();
    await flush();

    expect(racedCalls).toBe(2);
    expect(handle.snapshot().get('local-raced')).toBe(forced);
    handle.stop();
  });

  test('a background probe started during a forced probe commits over it as the fresher result', async () => {
    let backgroundCalls = 0;
    let forcedStarted = false;
    let resolveForced: (value: { ok: true }) => void = () => undefined;
    let resolveOverlappingBackground: (value: { ok: false; reason: string }) => void = () => undefined;
    let overlappingBackgroundStarted = false;
    const handle = startHealthProbe({
      registry: [localEntry({
        id: 'local-overlap',
        healthCheck: () => {
          if (backgroundCalls === 1 && !forcedStarted) {
            forcedStarted = true;
            return new Promise<{ ok: true }>((resolve) => { resolveForced = resolve; });
          }
          backgroundCalls += 1;
          if (backgroundCalls === 1) return Promise.resolve({ ok: false, reason: 'down' });
          overlappingBackgroundStarted = true;
          return new Promise<{ ok: false; reason: string }>((resolve) => {
            resolveOverlappingBackground = resolve;
          });
        },
      })],
      logger: silentLogger,
      intervalMs: 20,
      probeTimeoutMs: 60_000,
    });
    await flush();
    await flush();
    expect(backgroundCalls).toBe(1);

    const forcedPromise = handle.probeNow('local-overlap');
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (overlappingBackgroundStarted) {
          clearInterval(interval);
          resolve();
        }
      }, 2);
    });

    resolveForced({ ok: true });
    const forced = await forcedPromise;
    expect(forced?.ok).toBe(true);

    // The background probe began after the forced one, so its generation is
    // higher and its result is the fresher evidence.
    resolveOverlappingBackground({ ok: false, reason: 'down again' });
    await flush();
    await flush();
    expect(handle.snapshot().get('local-overlap')?.ok).toBe(false);
    handle.stop();
  });

  test('probeNow resolves undefined for unknown and non-probed cloud model ids', async () => {
    const handle = startHealthProbe({
      registry: [sharedEntry('cloud-row', () => Promise.resolve({ ok: true }))],
      logger: silentLogger,
      intervalMs: 60_000,
      probeTimeoutMs: 1_000,
    });

    expect(await handle.probeNow('missing')).toBeUndefined();
    expect(await handle.probeNow('cloud-row')).toBeUndefined();
    handle.stop();
  });
});

describe('sanitizeProbeReason', () => {
  test('maps any non-timeout error to `unavailable`', () => {
    expect(sanitizeProbeReason(new Error('connect ECONNREFUSED 10.0.0.5:8189'))).toBe('unavailable');
    expect(sanitizeProbeReason(new Error('getaddrinfo ENOTFOUND comfyui.atelier.local'))).toBe('unavailable');
    expect(sanitizeProbeReason(new Error('fetch failed'))).toBe('unavailable');
    expect(sanitizeProbeReason('plain string error')).toBe('unavailable');
    expect(sanitizeProbeReason(undefined)).toBe('unavailable');
    expect(sanitizeProbeReason(null)).toBe('unavailable');
  });

  test('maps the budget-timeout flag to `timed out`', () => {
    expect(sanitizeProbeReason(new Error('probe timeout'), { timedOut: true })).toBe('timed out');
    // Even with a misleading error message, the explicit `timedOut: true` wins.
    expect(sanitizeProbeReason(new Error('arbitrary'), { timedOut: true })).toBe('timed out');
  });

  test('does not mislabel an upstream or shutdown AbortError as our timeout', () => {
    const abortErr = new Error('The operation was aborted.');
    abortErr.name = 'AbortError';
    expect(sanitizeProbeReason(abortErr)).toBe('unavailable');
  });

  test('return type is the closed `ModelAvailabilityReason` union', () => {
    // Compile-time contract: the sanitizer's return is assignable to the
    // closed wire union — guarantees /api/models can only carry one of the
    // operational categories, never raw err.message strings.
    const value: ModelAvailabilityReason = sanitizeProbeReason(new Error('any'));
    expect(['unavailable', 'timed out']).toContain(value);
  });
});
