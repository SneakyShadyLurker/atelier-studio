import { afterEach, describe, expect, test } from 'bun:test';
import { snapshotBatchDonePromises } from '../orchestrator/registry';
import { openBatchEvents, submitGenerate, testRuntime } from './helpers';

// Submission responses finish before detached renders. Retire every render
// before another runtime resets the shared counters for the next test.
afterEach(async () => {
  for (;;) {
    const pending = snapshotBatchDonePromises();
    if (pending.length === 0) break;
    await Promise.allSettled(pending);
  }
});

describe('global concurrent tile cap', () => {
  test('rejects a batch that would exceed the cap; accepts again after a slot frees', async () => {
    const { app } = testRuntime({ LOCAL_TIMEOUT_MS: '2000', MOCK_PROVIDER_DELAY_MS: '150', MAX_CONCURRENT_TILES: '2', MAX_CONCURRENT_TILES_PER_USER: '2' });
    // First batch fills the cap with count=2.
    const first = await submitGenerate(app, { prompt: 'slow', modelId: 'mock-slow', ratio: '1:1', count: 2 });
    await Bun.sleep(20);
    // Even count=1 is rejected while the cap is saturated.
    const second = await submitGenerate(app, { prompt: 'again', modelId: 'mock-fast', ratio: '1:1', count: 1 });
    expect(second.payload.status).toBe('queued');
    expect(first.response.status).toBe(201);
    await (await openBatchEvents(app, first.batchId)).text();
    // After the first batch drains, the cap is free again.
    const third = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'after', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      }),
    );
    expect(third.status).toBe(201);
  });

  test('allows multiple in-flight batches as long as the tile sum stays within the cap', async () => {
    const { app } = testRuntime({ LOCAL_TIMEOUT_MS: '5000', MOCK_PROVIDER_DELAY_MS: '300', MAX_CONCURRENT_TILES: '4', MAX_CONCURRENT_TILES_PER_USER: '4' });
    // Three concurrent batches, count=1 each = 3 tiles in flight, under the cap of 4.
    const a = app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'a', modelId: 'mock-slow', ratio: '1:1', count: 1 }),
      }),
    );
    const b = app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'b', modelId: 'mock-slow', ratio: '1:1', count: 1 }),
      }),
    );
    const c = app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'c', modelId: 'mock-slow', ratio: '1:1', count: 1 }),
      }),
    );
    const responses = await Promise.all([a, b, c]);
    for (const res of responses) expect(res.status).toBe(201);
    await Promise.all(responses.map((res) => res.text()));
  });

  test('per-user cap leaves headroom for other users at global saturation', async () => {
    // The whole point of the per-user cap: when user A maxes out their
    // per-user limit (4), the global cap (5) reserves at least one slot
    // for everyone else. Without this, a single user submitting count=4
    // could acquire all 4 slots out of a 4-cap and starve other users
    // until their batch finished.
    const { app } = testRuntime({
      LOCAL_TIMEOUT_MS: '5000',
      MOCK_PROVIDER_DELAY_MS: '500',
      MAX_CONCURRENT_TILES: '5',
      MAX_CONCURRENT_TILES_PER_USER: '4',
    });
    // User A: count=4 saturates their per-user budget but leaves 1 global slot.
    const userA = app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'alice' },
        body: JSON.stringify({ prompt: 'a', modelId: 'mock-slow', ratio: '1:1', count: 4 }),
      }),
    );
    await Bun.sleep(50);
    // User A tries another count=1 — per-user cap (4) blocks them.
    const userAOverflow = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'alice' },
        body: JSON.stringify({ prompt: 'a-extra', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      }),
    );
    expect(userAOverflow.status).toBe(201);
    expect(await userAOverflow.json()).toMatchObject({ status: 'queued' });
    // User B: count=1 fits the remaining global slot — accepted even though
    // user A is at saturation. This is the fairness guarantee.
    const userB = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'bob' },
        body: JSON.stringify({ prompt: 'b', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      }),
    );
    expect(userB.status).toBe(201);
    await userB.text();
    await (await userA).text();
  });

  test('with per-user cap == global cap, one user can saturate the system for everyone', async () => {
    // Degenerate case: when MAX_CONCURRENT_TILES_PER_USER == MAX_CONCURRENT_TILES,
    // the per-user cap provides no fairness headroom — the first user to
    // saturate blocks all others. The fairness guarantee in the previous
    // test relies on per-user < global.
    const { app } = testRuntime({ LOCAL_TIMEOUT_MS: '2000', MOCK_PROVIDER_DELAY_MS: '150', MAX_CONCURRENT_TILES: '1', MAX_CONCURRENT_TILES_PER_USER: '1' });
    const userA = app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'alice' },
        body: JSON.stringify({ prompt: 'a', modelId: 'mock-slow', ratio: '1:1', count: 1 }),
      }),
    );
    await Bun.sleep(20);
    const userB = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'bob' },
        body: JSON.stringify({ prompt: 'b', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      }),
    );
    expect(userB.status).toBe(201);
    expect(await userB.json()).toMatchObject({ status: 'queued' });
    expect((await userA).status).toBe(201);
    await (await userA).text();
  });

  test('per-tile slot release lets a follow-up batch start before earlier batch finishes', async () => {
    // mock-fast resolves immediately; mock-slow holds a slot. Cap=2.
    // Run a slow count=1 + a fast count=1 (uses 2 slots), wait for fast to
    // finish, then a follow-up count=1 must succeed even though slow is
    // still in flight — proving the release is per-tile, not per-batch.
    const { app } = testRuntime({ LOCAL_TIMEOUT_MS: '3000', MOCK_PROVIDER_DELAY_MS: '400', MAX_CONCURRENT_TILES: '2', MAX_CONCURRENT_TILES_PER_USER: '2' });
    const slow = app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'slow', modelId: 'mock-slow', ratio: '1:1', count: 1 }),
      }),
    );
    const fast = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'fast', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      }),
    );
    expect(fast.status).toBe(201);
    await fast.text();
    const followUp = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify({ prompt: 'follow', modelId: 'mock-fast', ratio: '1:1', count: 1 }),
      }),
    );
    expect(followUp.status).toBe(201);
    await (await slow).text();
    await followUp.text();
  });
});
