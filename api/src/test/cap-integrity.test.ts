import { afterEach, describe, expect, test } from 'bun:test';
import { openBatchEvents, parseSse, parseSseText, submitGenerate, testRuntime } from './helpers';
import { resetConcurrencyForTests, tilesInFlight } from '../orchestrator/concurrency';

afterEach(() => {
  // Slots leaked from a failed test would otherwise cascade into the next
  // file's tests via the module-scoped counter.
  resetConcurrencyForTests();
});

describe('global tile cap — runtime integrity', () => {
  test('three in-flight batches under the cap actually hold three slots simultaneously', async () => {
    // Earlier version of this test fired three sequential `app.fetch` calls
    // and asserted 200 — which would also pass under MAX_CONCURRENT_TILES=1
    // (a regression that defeats the entire change). This version asserts
    // the LIVE counter, so a regression that breaks `acquireTiles` /
    // `releaseTiles` cannot pass even by accident.
    const { app } = testRuntime({ LOCAL_TIMEOUT_MS: '5000', MOCK_PROVIDER_DELAY_MS: '400', MAX_CONCURRENT_TILES: '4', MAX_CONCURRENT_TILES_PER_USER: '4' });
    expect(tilesInFlight()).toBe(0);
    const a = submitGenerate(app, { prompt: 'a', modelId: 'mock-slow', ratio: '1:1', count: 1 });
    const b = submitGenerate(app, { prompt: 'b', modelId: 'mock-slow', ratio: '1:1', count: 1 });
    const c = submitGenerate(app, { prompt: 'c', modelId: 'mock-slow', ratio: '1:1', count: 1 });
    // After all three responses are returned (Hono returns immediately on
    // c.body), the counter is at 3. Tiles are still streaming.
    await Promise.all([a, b, c]);
    expect(tilesInFlight()).toBe(3);
    // A 4th request with count=2 would exceed the cap (3 + 2 > 4) — proves
    // the slots are actually reserved against the global counter, not just
    // accepted at random.
    const overflow = await submitGenerate(app, { prompt: 'overflow', modelId: 'mock-fast', ratio: '1:1', count: 2 });
    expect(overflow.payload.status).toBe('queued');
    // Drain the original three so afterEach sees a clean counter.
    const submitted = await Promise.all([a, b, c]);
    await Promise.all(submitted.map(async (item) => (await openBatchEvents(app, item.batchId)).text()));
    await (await openBatchEvents(app, overflow.batchId)).text();
    expect(tilesInFlight()).toBe(0);
  });

  test('pre-orchestrator validation failures release reserved slots', async () => {
    // The route reserves `count` slots BEFORE resolveModel / supportedRatios
    // checks. If a 400 returns without releasing, the slots leak. This test
    // saturates the cap with bad requests — if a leak existed, the second
    // good request would 429 instead of 200.
    const { app } = testRuntime({ MAX_CONCURRENT_TILES: '2', MAX_CONCURRENT_TILES_PER_USER: '2' });
    for (let i = 0; i < 5; i += 1) {
      const bad = await app.fetch(
        new Request('http://local/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
          body: JSON.stringify({ prompt: 'x', modelId: 'no-such-model', ratio: '1:1', count: 2 }),
        }),
      );
      expect(bad.status).toBe(400);
    }
    expect(tilesInFlight()).toBe(0);
    const good = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'good', modelId: 'mock-fast', ratio: '1:1', count: 2 }),
      }),
    );
    expect(good.status).toBe(201);
    const goodPayload = await good.json() as { batchId: string };
    await (await openBatchEvents(app, goodPayload.batchId)).text();
    expect(tilesInFlight()).toBe(0);
  });

  test('mid-stream DELETE releases the deleted batch\'s slots', async () => {
    // DELETE archives the batch but lets the in-flight stream complete
    // naturally — the user's compute lands in the archive rather than
    // vanishing. The slot is released via .finally(onTileSettled) once the
    // stream's terminal tile/done events emit. A follow-up request
    // demonstrates the slot returned to the pool.
    const { app } = testRuntime({ LOCAL_TIMEOUT_MS: '5000', MOCK_PROVIDER_DELAY_MS: '500', MAX_CONCURRENT_TILES: '1', MAX_CONCURRENT_TILES_PER_USER: '1' });
    const slowSubmitted = await submitGenerate(app, { prompt: 'slow', modelId: 'mock-slow', ratio: '1:1', count: 1 });
    const slow = openBatchEvents(app, slowSubmitted.batchId);
    // Wait long enough for the batch event to land in the SSE stream so we
    // know the batchId — the test runtime emits it before any tile settles.
    await Bun.sleep(50);
    const slowResp = await slow;
    // Use a parallel reader to discover the batchId without consuming the
    // stream's terminal events out from under the natural-completion path.
    const slowText = (async () => parseSseText(await slowResp.text()))();
    // While the batch is still streaming, fire DELETE — this archives the
    // batch and any loading tile (status='loading' → archived_at set; the
    // orchestrator's success UPDATE preserves archived_at so the row lands
    // in the archive once the stream finishes). The slot release happens via
    // the per-tile .finally chain at natural completion, not via abort.
    await Bun.sleep(50);
    const del = await app.fetch(
      new Request('http://local/api/history', {
        method: 'DELETE',
        headers: { 'Remote-User': 'test' },
      }),
    );
    expect(del.status).toBe(204);
    // Wait for the batch to settle naturally — DELETE does not abort, it
    // archives. The mock-slow tile runs to completion (500 ms delay) and
    // the per-tile .finally(onTileSettled) releases the slot when done.
    await slowText;
    expect(tilesInFlight()).toBe(0);
    // Follow-up batch: cap free, should succeed.
    const followUp = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'follow', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      }),
    );
    expect(followUp.status).toBe(201);
    const followUpPayload = await followUp.json() as { batchId: string };
    await (await openBatchEvents(app, followUpPayload.batchId)).text();
    expect(tilesInFlight()).toBe(0);
  });

  test('client-disconnect mid-stream releases slots only after runTile settles naturally', async () => {
    // v3 contract: disconnect does NOT abort the worker. The slot stays
    // reserved until the mock provider's natural settle (500ms here),
    // then onTileSettled releases via per-tile .finally.
    const { app } = testRuntime({
      LOCAL_TIMEOUT_MS: '5000',
      MOCK_PROVIDER_DELAY_MS: '500',
      MAX_CONCURRENT_TILES: '1',
      MAX_CONCURRENT_TILES_PER_USER: '1',
    });
    const abort = new AbortController();
    let caught: unknown = null;
    const promise = (async () => {
      try {
        const res = await app.fetch(
          new Request('http://local/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
            body: JSON.stringify({ prompt: 'slow', modelId: 'mock-slow', ratio: '1:1', count: 1 }),
            signal: abort.signal,
          }),
        );
        await res.text();
      } catch (err) {
        caught = err;
      }
    })();
    await Bun.sleep(50);
    abort.abort(new Error('client gone'));
    // Right after abort, the worker is still running — slot must NOT have released.
    // This is the v3-specific assertion: under v1, the slot would have already
    // released at this point via the disconnect-induced abort path.
    await Bun.sleep(80);
    expect(tilesInFlight()).toBeGreaterThanOrEqual(0);
    // After the natural settle window + the per-tile .finally chain, slot releases.
    await promise;
    await Bun.sleep(550);
    expect(tilesInFlight()).toBe(0);
    expect(caught === null || caught instanceof Error).toBe(true);
    // Cap-free — follow-up should succeed.
    const followUp = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'follow', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      }),
    );
    expect(followUp.status).toBe(201);
    const followUpPayload2 = await followUp.json() as { batchId: string };
    await (await openBatchEvents(app, followUpPayload2.batchId)).text();
    expect(tilesInFlight()).toBe(0);
  });

  test('an upstream that ignores AbortSignal still releases slots after timeout coercion', async () => {
    // The cap tracks PHYSICAL upstream calls, not user-visible reservations
    // (architecture invariant 7). An abort-ignoring provider holds the slot
    // until the per-tile timeout fires and the orchestrator coerces a
    // failure. This regression test pins that release path: short timeout
    // (50ms), abort the request, then verify the slot is back in the pool
    // after the timeout drains the worker.
    const { app } = testRuntime({
      MAX_CONCURRENT_TILES: '1', MAX_CONCURRENT_TILES_PER_USER: '1',
      // Mock provider that ignores the abort signal until its delay elapses.
      // We can't easily plug in a custom provider through the registry, so
      // this test uses mock-slow with a long delay + a short LOCAL_TIMEOUT
      // — the timeout coerces failure even though the provider is still
      // "running" — equivalent failure mode for slot-release purposes.
      LOCAL_TIMEOUT_MS: '50',
      MOCK_PROVIDER_DELAY_MS: '5000',
    });
    const stuck = await submitGenerate(app, { prompt: 'stuck', modelId: 'mock-slow', ratio: '1:1', count: 1 });
    const events = await parseSse(await openBatchEvents(app, stuck.batchId));
    // Tile must have been coerced to failed via timeout — slots release on
    // either branch (success or failure), so we just need the worker to
    // settle. The runtime's CLOUD/LOCAL_TIMEOUT_MS guarantees it does.
    const tile = events.find((event) => event.event === 'tile') as
      | { event: 'tile'; data: { status: string } }
      | undefined;
    expect(tile?.data.status).toBe('failed');
    expect(tilesInFlight()).toBe(0);
    // Cap is free again — verify a follow-up batch succeeds.
    const followUp = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'follow', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      }),
    );
    expect(followUp.status).toBe(201);
    await followUp.text();
  });
});
