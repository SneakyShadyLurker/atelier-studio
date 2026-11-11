import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
import { refImageThumbUrl, refImageUrl } from '../../api/uploads';
import { resetMediaCacheForTests } from '../../lib/mediaCache';
import { RefImageRow } from './RefImageRow';

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL.bind(URL);

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
  resetMediaCacheForTests();
});

describe('RefImageRow chip previews', () => {
  test('a chip without a local blob reads the upload thumbnail through the session media cache', async () => {
    resetMediaCacheForTests();
    URL.createObjectURL = () => 'blob:cached-thumb';
    const requested: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      requested.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      return Promise.resolve(new Response(new Blob(['thumb'], { type: 'image/webp' })));
    }) as unknown as typeof fetch;

    render(
      <RefImageRow
        files={[
          { clientId: 'restored', serverId: 'upload-1', status: 'ready', mime: 'image/jpeg', sizeBytes: 1, previewUrl: refImageThumbUrl('upload-1') },
          { clientId: 'local', serverId: 'upload-2', status: 'ready', mime: 'image/png', sizeBytes: 1, previewUrl: 'blob:local-preview' },
        ]}
        maxRefImages={4}
        onAdd={() => undefined}
        onRemove={() => undefined}
        onCapReached={() => undefined}
        disabled={false}
      />,
    );
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(screen.getByRole('img', { name: 'Reference image 1' }).getAttribute('src')).toBe('blob:cached-thumb');
    expect(screen.getByRole('img', { name: 'Reference image 2' }).getAttribute('src')).toBe('blob:local-preview');
    expect(requested).toEqual([refImageThumbUrl('upload-1')]);
    expect(requested).not.toContain(refImageUrl('upload-1'));
  });
});
