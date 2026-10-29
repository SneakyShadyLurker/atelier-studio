import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Batch, Tile } from '@atelier/shared';
import { downloadFilename, fetchImageBlob } from '../src/api/images';

afterEach(() => {
  mock.restore();
});

const tile: Extract<Tile, { status: 'done' }> = {
  id: 'tile-1',
  seed: 1,
  status: 'done',
  url: '/api/img/tile-1',
  ext: 'webp',
  mime: 'image/webp',
  completedAt: 1,
};

function batch(prompt: string): Batch {
  return {
    id: 'batch-1',
    prompt,
    ratio: '1:1',
    modelId: 'model-1',
    modelLabel: 'Model',
    createdAt: 1,
    collectionId: null,
      pinned: false,
      status: 'done',
    tiles: [{ ...tile, id: 'other' }, tile],
  };
}

describe('image download helpers', () => {
  test('uses the first six ASCII words and tile index for filenames', () => {
    expect(downloadFilename(batch('Ångström ceramic espresso cup on brushed steel workstation'), tile)).toBe('angstrom-ceramic-espresso-cup-on-brushed-02.webp');
  });

  test('falls back to atelier-image when the prompt has no ASCII words', () => {
    expect(downloadFilename(batch('絵文字だけ'), tile)).toBe('atelier-image-02.webp');
  });

  test('returns a blob with the tile mime type', async () => {
    globalThis.fetch = mock(() => new Response(new Blob(['bytes'], { type: 'application/octet-stream' }), { status: 200 })) as unknown as typeof fetch;

    const blob = await fetchImageBlob(tile);

    expect(blob.type).toBe('image/webp');
  });
});
