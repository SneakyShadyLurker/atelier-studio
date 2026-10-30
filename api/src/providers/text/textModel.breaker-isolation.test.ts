import { describe, expect, test } from 'bun:test';
import { buildResilientPolicy } from '../../lifecycle/resilient-call';
import { genericTextModel, testTextModelProvider } from '../../test/textModelProvider';

describe('per-capability breaker isolation', () => {
  test('tripping infer breaker leaves enhance and draftList breakers closed', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response('boom', { status: 500 }))) as unknown as typeof fetch;
    try {
      const provider = testTextModelProvider({ origin: 'http://x', token: 't', model: genericTextModel('m'), maxResponseBytes: 1_000_000, enhanceOpenTimeoutMs: 30_000, enhancePolicy: buildResilientPolicy({
          timeoutPerAttemptMs: 5_000,
          maxAttempts: 1,
          initialBackoffMs: 1,
          maxBackoffMs: 1,
          breakerThreshold: 8,
          halfOpenAfterMs: 30_000,
          noTimeout: true,
        }), draftListPolicy: buildResilientPolicy({
          timeoutPerAttemptMs: 5_000,
          maxAttempts: 1,
          initialBackoffMs: 1,
          maxBackoffMs: 1,
          breakerThreshold: 8,
          halfOpenAfterMs: 30_000,
        }), inferPolicy: buildResilientPolicy({
          timeoutPerAttemptMs: 5_000,
          maxAttempts: 1,
          initialBackoffMs: 1,
          maxBackoffMs: 1,
          breakerThreshold: 3,
          halfOpenAfterMs: 30_000,
        }) });

      for (let i = 0; i < 4; i += 1) {
        await provider.inferDimensions('{}', new AbortController().signal);
      }
      expect(provider.inferBreakerState?.()).toBe('open');

      const eIter = provider.enhance('hi', [], new AbortController().signal);
      const eFirst = await eIter[Symbol.asyncIterator]().next();
      expect(eFirst.done).toBe(false);

      const dr = await provider.draftList(
        { name: 'x', existing: [], target: 5 },
        new AbortController().signal,
      );
      expect(dr.type).toBe('failed');
    } finally {
      globalThis.fetch = original;
    }
  });
});
