import { afterEach, describe, expect, mock, test } from 'bun:test';
import { fetchArchivePage } from './archive';
import { fetchHistoryPage } from './history';
import { uploadRefImage } from './uploads';

afterEach(() => {
  mock.restore();
});

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise to reject');
}

function videoTile() {
  return {
    id: 'tile-video',
    seed: 123,
    status: 'done',
    url: '/img/tile-video',
    thumbUrl: '/img/tile-video/thumb',
    ext: 'mp4',
    mime: 'video/mp4',
    completedAt: 1_700_000_000_000,
  };
}

describe('video media API validation', () => {
  test('accepts video tiles in history responses', async () => {
    globalThis.fetch = mock(() => Response.json({
      items: [{
        id: 'batch-video',
        prompt: 'animate this',
        ratio: '16:9',
        modelId: 'minimax-h3-i2v',
        modelLabel: 'MiniMax H3 I2V',
        createdAt: 1_700_000_000_000,
        collectionId: null,
        pinned: false,
        status: 'done',
        tiles: [videoTile()],
      }],
      nextCursor: null,
    })) as unknown as typeof fetch;

    const page = await fetchHistoryPage(null);

    expect(page.items[0]?.tiles[0]).toMatchObject({
      ext: 'mp4',
      mime: 'video/mp4',
      url: '/api/img/tile-video?media=2',
      thumbUrl: '/api/img/tile-video/thumb?media=2',
    });
  });

  test('accepts video tiles in archive responses', async () => {
    globalThis.fetch = mock(() => Response.json({
      items: [{
        ...videoTile(),
        batchId: 'batch-video',
        prompt: 'A slow cinematic pan',
        modelLabel: 'MiniMax H3',
        ratio: '16:9',
        archivedAt: 1_700_000_001_000,
      }],
      nextCursor: null,
      total: 1,
    })) as unknown as typeof fetch;

    const page = await fetchArchivePage(null);

    expect(page.items[0]).toMatchObject({
      ext: 'mp4',
      mime: 'video/mp4',
      url: '/api/img/tile-video?media=2',
      thumbUrl: '/api/img/tile-video/thumb?media=2',
    });
  });

  test('still rejects video upload responses because uploads are image-only', async () => {
    globalThis.fetch = mock(() => Response.json({
      id: 'upload-video',
      mime: 'video/mp4',
      ext: 'mp4',
      sizeBytes: 10,
      width: 1280,
      height: 720,
      createdAt: 1_700_000_000_000,
    })) as unknown as typeof fetch;

    expect(await rejectedValue(uploadRefImage(new File(['mp4'], 'clip.mp4', { type: 'video/mp4' }))))
      .toMatchObject({ message: 'invalid upload response' });
  });

  test('rejects mismatched media pairs in history responses', async () => {
    for (const tile of [
      { ...videoTile(), ext: 'mp4', mime: 'image/png' },
      { ...videoTile(), ext: 'png', mime: 'video/mp4' },
    ]) {
      globalThis.fetch = mock(() => Response.json({
        items: [{
          id: 'batch-video',
          prompt: 'animate this',
          ratio: '16:9',
          modelId: 'minimax-h3-i2v',
          modelLabel: 'MiniMax H3 I2V',
          createdAt: 1_700_000_000_000,
          collectionId: null,
          pinned: false,
          status: 'done',
          tiles: [tile],
        }],
        nextCursor: null,
      })) as unknown as typeof fetch;

      expect(await rejectedValue(fetchHistoryPage(null)))
        .toMatchObject({ message: 'invalid response shape' });
    }
  });

  test('rejects mismatched media pairs in archive responses', async () => {
    for (const tile of [
      { ...videoTile(), ext: 'mp4', mime: 'image/png' },
      { ...videoTile(), ext: 'png', mime: 'video/mp4' },
    ]) {
      globalThis.fetch = mock(() => Response.json({
        items: [{
          ...tile,
          batchId: 'batch-video',
          prompt: 'A slow cinematic pan',
          modelLabel: 'MiniMax H3',
          ratio: '16:9',
          archivedAt: 1_700_000_001_000,
        }],
        nextCursor: null,
        total: 1,
      })) as unknown as typeof fetch;

      expect(await rejectedValue(fetchArchivePage(null)))
        .toMatchObject({ message: 'invalid response shape' });
    }
  });
});
