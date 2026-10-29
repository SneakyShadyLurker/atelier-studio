import { afterEach, describe, expect, test } from 'bun:test';
import { openBatchEvents, submitGenerate, testRuntime } from './helpers';
import {
  byokTilesInFlight,
  resetConcurrencyForTests,
  tilesInFlight,
} from '../orchestrator/concurrency';
import { pngBytes } from './image-fixtures';

const pngBase64 = Buffer.from(pngBytes()).toString('base64');
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetConcurrencyForTests();
});

function googleSuccessJson(): string {
  return JSON.stringify({
    candidates: [
      {
        content: { parts: [{ inlineData: { mimeType: 'image/png', data: pngBase64 } }] },
      },
    ],
  });
}

// Stubs `globalThis.fetch` so each upstream call to Google blocks until the
// returned `releaseAll` is called. Lets the test observe in-flight counters
// while batches are mid-stream.
function slowGoogleStub(): { releaseAll: () => void } {
  const pending: (() => void)[] = [];
  globalThis.fetch = ((_input, _init) =>
    new Promise<Response>((resolve) => {
      pending.push(() => {
        resolve(
          new Response(googleSuccessJson(), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      });
    })) as typeof fetch;
  return {
    releaseAll: () => {
      while (pending.length > 0) pending.shift()?.();
    },
  };
}

describe('BYOK cap — runtime integrity', () => {
  test('BYOK Gemini tiles do not consume the shared CLIProxyAPI counter', async () => {
    const runtime = testRuntime();
    await runtime.seedKey('alice', 'google', `AIza${'x'.repeat(35)}`);
    const stub = slowGoogleStub();

    const res = await submitGenerate(
      runtime.app,
      {
        prompt: 'a',
        modelId: 'gemini-3-pro-image-preview',
        ratio: '1:1',
        count: 4,
      },
      'alice',
    );
    expect(res.response.status).toBe(201);

    // Mid-stream: BYOK counter has the 4 reserved tiles, shared counter is
    // untouched — proves the route picked the BYOK semaphore.
    expect(byokTilesInFlight('alice')).toBe(4);
    expect(tilesInFlight()).toBe(0);

    stub.releaseAll();
    await (await openBatchEvents(runtime.app, res.batchId, 'alice')).text();
    expect(byokTilesInFlight('alice')).toBeLessThanOrEqual(1);
    expect(tilesInFlight()).toBe(0);
  });

  test('two BYOK users can each saturate the per-user cap (no cross-user starvation)', async () => {
    const runtime = testRuntime({ MAX_CONCURRENT_TILES_PER_USER_BYOK: '8' });
    await runtime.seedKey('alice', 'google', `AIza${'x'.repeat(35)}`);
    await runtime.seedKey('bob', 'google', `AIza${'y'.repeat(35)}`);
    const stub = slowGoogleStub();

    // Alice fills her 8-slot BYOK cap with two count=4 batches.
    const a1 = await submitGenerate(
      runtime.app,
      { prompt: 'a1', modelId: 'gemini-3-pro-image-preview', ratio: '1:1', count: 4 },
      'alice',
    );
    const a2 = await submitGenerate(
      runtime.app,
      { prompt: 'a2', modelId: 'gemini-3-pro-image-preview', ratio: '1:1', count: 4 },
      'alice',
    );
    expect(a1.response.status).toBe(201);
    expect(a2.response.status).toBe(201);
    expect(byokTilesInFlight('alice')).toBe(8);

    // Alice's 9th tile is over cap — 429.
    const aOver = await submitGenerate(
      runtime.app,
      { prompt: 'over', modelId: 'gemini-3-pro-image-preview', ratio: '1:1', count: 1 },
      'alice',
    );
    expect(aOver.payload.status).toBe('queued');

    // Bob can still saturate his own 8 slots — independent per-user counter.
    const b1 = await submitGenerate(
      runtime.app,
      { prompt: 'b1', modelId: 'gemini-3-pro-image-preview', ratio: '1:1', count: 4 },
      'bob',
    );
    const b2 = await submitGenerate(
      runtime.app,
      { prompt: 'b2', modelId: 'gemini-3-pro-image-preview', ratio: '1:1', count: 4 },
      'bob',
    );
    expect(b1.response.status).toBe(201);
    expect(b2.response.status).toBe(201);
    expect(byokTilesInFlight('bob')).toBe(8);

    // Shared cap is still completely untouched throughout.
    expect(tilesInFlight()).toBe(0);

    stub.releaseAll();
    await Promise.all([
      openBatchEvents(runtime.app, a1.batchId, 'alice').then((res) => res.text()),
      openBatchEvents(runtime.app, a2.batchId, 'alice').then((res) => res.text()),
      openBatchEvents(runtime.app, b1.batchId, 'bob').then((res) => res.text()),
      openBatchEvents(runtime.app, b2.batchId, 'bob').then((res) => res.text()),
    ]);
    expect(byokTilesInFlight('alice')).toBeLessThanOrEqual(1);
    expect(byokTilesInFlight('bob')).toBe(0);
  });

  test('shared CLIProxyAPI cap still applies independently while BYOK is saturated', async () => {
    const runtime = testRuntime({
      MAX_CONCURRENT_TILES_PER_USER_BYOK: '8',
      MAX_CONCURRENT_TILES: '4',
      MAX_CONCURRENT_TILES_PER_USER: '4',
      MOCK_PROVIDER_DELAY_MS: '400',
      LOCAL_TIMEOUT_MS: '5000',
    });
    await runtime.seedKey('alice', 'google', `AIza${'x'.repeat(35)}`);
    const stub = slowGoogleStub();

    // Saturate Alice's BYOK cap (8 tiles).
    const byok1 = await submitGenerate(
      runtime.app,
      { prompt: 'byok-1', modelId: 'gemini-3-pro-image-preview', ratio: '1:1', count: 4 },
      'alice',
    );
    const byok2 = await submitGenerate(
      runtime.app,
      { prompt: 'byok-2', modelId: 'gemini-3-pro-image-preview', ratio: '1:1', count: 4 },
      'alice',
    );
    expect(byok1.response.status).toBe(201);
    expect(byok2.response.status).toBe(201);
    expect(byokTilesInFlight('alice')).toBe(8);

    // Despite BYOK at cap, the shared counter is empty and a non-BYOK
    // request from the same user can still acquire its full per-user cap.
    expect(tilesInFlight()).toBe(0);
    const shared = await submitGenerate(
      runtime.app,
      { prompt: 'shared', modelId: 'mock-slow', ratio: '1:1', count: 4 },
      'alice',
    );
    expect(shared.response.status).toBe(201);
    expect(tilesInFlight()).toBe(4);

    stub.releaseAll();
    await Promise.all([byok1, byok2, shared].map(async (item) => (await openBatchEvents(runtime.app, item.batchId, 'alice')).text()));
    expect(tilesInFlight()).toBe(0);
    expect(byokTilesInFlight('alice')).toBe(0);
  });
});
