import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { testRuntime } from '../test/helpers';
import { writeAtomic } from './files';
import { acquireDecryptedVideo, resetDecryptedVideoCacheForTests, sweepDecryptedVideoCache, videoCacheBudgetForTests, VIDEO_CACHE_BUDGET_BYTES } from './decryptedVideoCache';
import { videoResponse } from '../routes/_video-response';

afterEach(() => { resetDecryptedVideoCacheForTests(); });

async function expectPlaybackError(result: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown;
  try { await result; }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (failure instanceof Error) expect(failure.message).toContain(message);
}

describe('decrypted video playback cache', () => {
  for (const paused of [false, true]) {
    test(`${paused ? 'paused' : 'unconsumed'} playback errors on idle and permits cache eviction exactly once`, async () => {
      const { config } = testRuntime();
      const id = crypto.randomUUID();
      await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array(512 * 1024));
      const lease = await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4');
      if (!lease) throw new Error('missing lease');
      const release = spyOn(lease, 'release');
      const response = videoResponse(lease, new Request('http://local/'), 40);
      if (!response.body) throw new Error('missing playback body');
      const reader = response.body.getReader();
      if (paused) expect((await reader.read()).done).toBe(false);
      sweepDecryptedVideoCache(Date.now() + 10 * 60_000);
      const budget = videoCacheBudgetForTests();
      expect(budget.tryAcquire(VIDEO_CACHE_BUDGET_BYTES)).toBe(false);
      await Bun.sleep(100);
      await expectPlaybackError(reader.read(), 'video playback idle timeout');
      expect(release).toHaveBeenCalledTimes(1);
      sweepDecryptedVideoCache(Date.now() + 10 * 60_000);
      expect(budget.tryAcquire(VIDEO_CACHE_BUDGET_BYTES)).toBe(true);
      budget.release(VIDEO_CACHE_BUDGET_BYTES);
      await Bun.sleep(50);
      expect(release).toHaveBeenCalledTimes(1);
    });
  }

  test('progress refreshes the idle deadline throughout a longer transfer', async () => {
    const { config } = testRuntime();
    const id = crypto.randomUUID();
    const bytes = new Uint8Array(2 * 1024 * 1024);
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', bytes);
    const lease = await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4');
    if (!lease) throw new Error('missing lease');
    const release = spyOn(lease, 'release');
    const response = videoResponse(lease, new Request('http://local/'), 120);
    if (!response.body) throw new Error('missing playback body');
    const reader = response.body.getReader();
    sweepDecryptedVideoCache(Date.now() + 10 * 60_000);
    const began = Date.now();
    let received = 0;
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw new Error('unexpected playback chunk');
      received += result.value.byteLength;
      await Bun.sleep(40);
    }
    expect(Date.now() - began).toBeGreaterThan(120);
    expect(received).toBe(bytes.byteLength);
    expect(release).toHaveBeenCalledTimes(1);
    sweepDecryptedVideoCache(Date.now() + 10 * 60_000);
    expect(videoCacheBudgetForTests().tryAcquire(VIDEO_CACHE_BUDGET_BYTES)).toBe(true);
    videoCacheBudgetForTests().release(VIDEO_CACHE_BUDGET_BYTES);
  });

  for (const boundary of ['cancel', 'abort', 'already aborted'] as const) {
    test(`${boundary} before first pull closes the reader and clears its idle deadline`, async () => {
      const { config } = testRuntime();
      const id = crypto.randomUUID();
      await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([1, 2, 3]));
      const lease = await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4');
      if (!lease) throw new Error('missing lease');
      const release = spyOn(lease, 'release');
      const abort = new AbortController();
      if (boundary === 'already aborted') abort.abort(new Error('playback aborted'));
      const response = videoResponse(lease, new Request('http://local/', { signal: abort.signal }), 40);
      if (!response.body) throw new Error('missing playback body');
      sweepDecryptedVideoCache(Date.now() + 10 * 60_000);
      if (boundary === 'cancel') await response.body.cancel();
      else {
        abort.abort(new Error('playback aborted'));
        await expectPlaybackError(response.arrayBuffer(), 'playback aborted');
      }
      await Bun.sleep(100);
      expect(release).toHaveBeenCalledTimes(1);
      sweepDecryptedVideoCache(Date.now() + 10 * 60_000);
      expect(videoCacheBudgetForTests().tryAcquire(VIDEO_CACHE_BUDGET_BYTES)).toBe(true);
      videoCacheBudgetForTests().release(VIDEO_CACHE_BUDGET_BYTES);
    });
  }

  test('a seek reuses an active copy after the cache idle interval', async () => {
    const { config } = testRuntime();
    const id = crypto.randomUUID();
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([1, 2, 3, 4]));
    const first = await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4');
    if (!first) throw new Error('missing active copy');
    sweepDecryptedVideoCache(Date.now() + 10 * 60_000);
    const seek = await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4');
    if (!seek) throw new Error('missing seek copy');
    expect(seek.file.name).toBe(first.file.name);
    const budget = videoCacheBudgetForTests();
    expect(budget.tryAcquire(VIDEO_CACHE_BUDGET_BYTES - 4)).toBe(true);
    budget.release(VIDEO_CACHE_BUDGET_BYTES - 4);
    seek.release();
    first.release();
    sweepDecryptedVideoCache(Date.now() + 10 * 60_000);
    expect(budget.tryAcquire(VIDEO_CACHE_BUDGET_BYTES)).toBe(true);
    budget.release(VIDEO_CACHE_BUDGET_BYTES);
  });

  test('publication versions replace cached bytes and retain user isolation', async () => {
    const { config } = testRuntime();
    const id = crypto.randomUUID();
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([1, 2, 3]));
    await writeAtomic(config.DATA_DIR, 'images', 'bob', id, 'mp4', new Uint8Array([7, 8, 9]));
    const first = await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4', '1');
    if (!first) throw new Error('missing first cached video');
    expect(new Uint8Array(await first.file.arrayBuffer()))
      .toEqual(new Uint8Array([1, 2, 3]));
    first.release();
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([4, 5, 6]));
    const second = await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4', '2');
    if (!second) throw new Error('missing second cached video');
    expect(new Uint8Array(await second.file.arrayBuffer()))
      .toEqual(new Uint8Array([4, 5, 6]));
    second.release();
    const otherUser = await acquireDecryptedVideo(config.DATA_DIR, 'bob', id, 'mp4', '2');
    if (!otherUser) throw new Error('missing other user cached video');
    expect(new Uint8Array(await otherUser.file.arrayBuffer()))
      .toEqual(new Uint8Array([7, 8, 9]));
    otherUser.release();
  });

  test('publication invalidated during materialization is discarded and releases its budget', async () => {
    const { config } = testRuntime();
    const id = crypto.randomUUID();
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([1, 2, 3]));
    expect(await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4', '1', () => false)).toBeNull();
    expect(videoCacheBudgetForTests().tryAcquire(VIDEO_CACHE_BUDGET_BYTES)).toBe(true);
    videoCacheBudgetForTests().release(VIDEO_CACHE_BUDGET_BYTES);
  });

  test('a leased video retains HTTP Range playback', async () => {
    const { config } = testRuntime();
    const id = crypto.randomUUID();
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([1, 2, 3, 4]));
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => {
      const video = await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4');
      if (!video) throw new Error('missing cached video');
      return videoResponse(video, request);
    } });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { Range: 'bytes=1-2' } });
      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe('bytes 1-2/4');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([2, 3]));
    } finally {
      await server.stop(true);
    }
  });

  test('eviction/replacement retain active reader bytes until cancellation finishes', async () => {
    const { config } = testRuntime();
    const id = crypto.randomUUID();
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([1, 2, 3]));
    const first = await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4', '1');
    if (!first) throw new Error('missing first lease');
    const response = videoResponse(first, new Request('http://local/'));
    sweepDecryptedVideoCache(Date.now() + 10 * 60_000);
    const budget = videoCacheBudgetForTests();
    expect(budget.tryAcquire(VIDEO_CACHE_BUDGET_BYTES - 2)).toBe(false);
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([4, 5, 6, 7]));
    const second = await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4', '2');
    if (!second) throw new Error('missing replacement lease');
    second.release();
    sweepDecryptedVideoCache(Date.now() + 10 * 60_000);
    expect(budget.tryAcquire(VIDEO_CACHE_BUDGET_BYTES)).toBe(false);
    await response.body?.cancel();
    first.release(); // duplicate release must not refund another entry's bytes
    expect(budget.tryAcquire(VIDEO_CACHE_BUDGET_BYTES)).toBe(true);
    budget.release(VIDEO_CACHE_BUDGET_BYTES);
  });

  for (const [method, range, status, expected] of [
    ['GET', 'bytes=1-', 206, [2, 3, 4]],
    ['GET', 'bytes=-2', 206, [3, 4]],
    ['GET', 'bytes=-4', 206, [1, 2, 3, 4]],
    ['GET', 'bytes=-5', 206, [1, 2, 3, 4]],
    ['GET', 'bytes=-65536', 206, [1, 2, 3, 4]],
    ['GET', 'BYTES=-65536', 206, [1, 2, 3, 4]],
    ['GET', 'bytes=1-2,-65536', 206, [1, 2, 3, 4]],
    ['GET', 'bytes=-0', 416, []],
    ['GET', 'Bytes=1-2', 206, [2, 3]],
    ['GET', 'BYTES=-2', 206, [3, 4]],
    ['GET', 'bytes=20-', 416, []],
    ['HEAD', 'bytes=1-2', 200, []],
    ['GET', 'bytes=0-0,2-2', 200, [1, 2, 3, 4]],
  ] as const) {
    test(`${method} ${range} closes its lease`, async () => {
      const { config } = testRuntime();
      const id = crypto.randomUUID();
      await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([1, 2, 3, 4]));
      const lease = await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4');
      if (!lease) throw new Error('missing lease');
      const response = videoResponse(lease, new Request('http://local/', { method, headers: { Range: range } }));
      expect(response.status).toBe(status);
      if (status === 206) expect(response.headers.get('Content-Range')).toMatch(/^bytes \d+-\d+\/4$/);
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...expected]);
      sweepDecryptedVideoCache(Date.now() + 10 * 60_000);
      expect(videoCacheBudgetForTests().tryAcquire(VIDEO_CACHE_BUDGET_BYTES)).toBe(true);
      videoCacheBudgetForTests().release(VIDEO_CACHE_BUDGET_BYTES);
    });
  }

  test('a suffix range against an empty video remains unsatisfiable and releases the lease', async () => {
    const { config } = testRuntime();
    const id = crypto.randomUUID();
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array());
    const lease = await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4');
    if (!lease) throw new Error('missing empty video lease');
    const release = spyOn(lease, 'release');
    const response = videoResponse(lease, new Request('http://local/', { headers: { Range: 'bytes=-65536' } }));
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */0');
    expect(await response.text()).toBe('');
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('If-Range without a published validator returns the full representation', async () => {
    const { config } = testRuntime();
    const id = crypto.randomUUID();
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([1, 2, 3, 4]));
    const lease = await acquireDecryptedVideo(config.DATA_DIR, 'alice', id, 'mp4');
    if (!lease) throw new Error('missing lease');
    const response = videoResponse(lease, new Request('http://local/', {
      headers: { Range: 'bytes=1-2', 'If-Range': '"stale"' },
    }));
    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });
});
