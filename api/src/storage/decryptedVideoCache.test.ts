import { afterEach, describe, expect, test } from 'bun:test';
import { testRuntime } from '../test/helpers';
import { writeAtomic } from './files';
import { decryptedVideoFile, resetDecryptedVideoCacheForTests, videoCacheBudgetForTests, VIDEO_CACHE_BUDGET_BYTES } from './decryptedVideoCache';

afterEach(() => { resetDecryptedVideoCacheForTests(); });

describe('decrypted video playback cache', () => {
  test('publication versions replace cached bytes and retain user isolation', async () => {
    const { config } = testRuntime();
    const id = crypto.randomUUID();
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([1, 2, 3]));
    await writeAtomic(config.DATA_DIR, 'images', 'bob', id, 'mp4', new Uint8Array([7, 8, 9]));
    const first = await decryptedVideoFile(config.DATA_DIR, 'alice', id, 'mp4', '1');
    if (!first) throw new Error('missing first cached video');
    expect(new Uint8Array(await first.arrayBuffer()))
      .toEqual(new Uint8Array([1, 2, 3]));
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([4, 5, 6]));
    const second = await decryptedVideoFile(config.DATA_DIR, 'alice', id, 'mp4', '2');
    if (!second) throw new Error('missing second cached video');
    expect(new Uint8Array(await second.arrayBuffer()))
      .toEqual(new Uint8Array([4, 5, 6]));
    const otherUser = await decryptedVideoFile(config.DATA_DIR, 'bob', id, 'mp4', '2');
    if (!otherUser) throw new Error('missing other user cached video');
    expect(new Uint8Array(await otherUser.arrayBuffer()))
      .toEqual(new Uint8Array([7, 8, 9]));
  });

  test('publication invalidated during materialization is discarded and releases its budget', async () => {
    const { config } = testRuntime();
    const id = crypto.randomUUID();
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([1, 2, 3]));
    expect(await decryptedVideoFile(config.DATA_DIR, 'alice', id, 'mp4', '1', () => false)).toBeNull();
    expect(videoCacheBudgetForTests().tryAcquire(VIDEO_CACHE_BUDGET_BYTES)).toBe(true);
    videoCacheBudgetForTests().release(VIDEO_CACHE_BUDGET_BYTES);
  });

  test('a cached video retains native HTTP Range playback', async () => {
    const { config } = testRuntime();
    const id = crypto.randomUUID();
    await writeAtomic(config.DATA_DIR, 'images', 'alice', id, 'mp4', new Uint8Array([1, 2, 3, 4]));
    const video = await decryptedVideoFile(config.DATA_DIR, 'alice', id, 'mp4');
    if (!video) throw new Error('missing cached video');
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(video) });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { Range: 'bytes=1-2' } });
      expect(response.status).toBe(206);
      expect(response.headers.get('Content-Range')).toBe('bytes 1-2/4');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([2, 3]));
    } finally {
      await server.stop(true);
    }
  });
});
