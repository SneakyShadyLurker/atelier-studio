import type { Batch, Model, Tile } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, type ReactNode } from 'react';
import { allDoneBatch } from '../../../test/fixtures/batches';
import { refImageThumbUrl, refImageUrl } from '../../api/uploads';
import { resetMediaCacheForTests } from '../../lib/mediaCache';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
import Lightbox from './index';

const imageModel: Model = {
  id: allDoneBatch.modelId,
  name: allDoneBatch.modelLabel,
  backend: 'cloud',
  tag: 'cloud',
  latency: 'fast',
  supportedRatios: ['1:1'],
  defaultRatio: '1:1',
  supportsReferenceImages: true,
  pool: 'shared',
  concurrencyCapPerUser: 4,
  maxCountPerBatch: 4,
};

const generatedTile: Extract<Tile, { status: 'done' }> = {
  id: 'generated-with-refs',
  status: 'done',
  url: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
  thumbUrl: '/api/img/generated-with-refs/thumb',
  ext: 'png',
  mime: 'image/png',
  seed: 42,
  completedAt: 1_700_000_000_000,
  refImageIds: ['ref-one', 'ref-two'],
};
const batch: Batch = { ...allDoneBatch, tiles: [generatedTile] };

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return function TestWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

async function renderLightbox() {
  const onDownload = mock();
  const onDelete = mock();
  render(
    <Lightbox
      batch={batch}
      modelById={new Map([[imageModel.id, imageModel]])}
      triggerKey={generatedTile.id}
      deleteVariant="archive"
      onClose={mock()}
      onDownload={onDownload}
      onDelete={onDelete}
    />,
    { wrapper: wrapper() },
  );
  await act(async () => { await import('./Content'); });
  return { onDownload, onDelete };
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

describe('Lightbox reference images', () => {
  test('returns to the generated image and only exposes actions for that image', async () => {
    const { onDownload, onDelete } = await renderLightbox();
    const generated = screen.getByRole('button', { name: 'View generated image' });
    const firstRef = screen.getByRole('button', { name: 'View reference image 1 of 2' });
    const secondRef = screen.getByRole('button', { name: 'View reference image 2 of 2' });
    expect(generated.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Download expanded image' })).toBeTruthy();

    fireEvent.click(firstRef);
    expect(generated.getAttribute('aria-pressed')).toBe('false');
    expect(firstRef.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Reference image')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download expanded image' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit from this image' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Animate this image' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive expanded image' })).toBeNull();

    fireEvent.click(secondRef);
    expect(firstRef.getAttribute('aria-pressed')).toBe('false');
    expect(secondRef.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(generated);
    expect(generated.getAttribute('aria-pressed')).toBe('true');
    expect(secondRef.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('img', { name: /Expanded generated image/ }).getAttribute('src')).toBe(generatedTile.url);
    fireEvent.click(screen.getByRole('button', { name: 'Download expanded image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive expanded image' }));
    expect(onDownload).toHaveBeenCalledWith(generatedTile);
    expect(onDelete).toHaveBeenCalledWith(generatedTile);
  });

  test('strip tiles read thumbnails through the session media cache, never the originals', async () => {
    resetMediaCacheForTests();
    const realFetch = globalThis.fetch;
    const realCreate = URL.createObjectURL.bind(URL);
    let objectUrls = 0;
    URL.createObjectURL = () => `blob:strip-${String(objectUrls++)}`;
    const requested: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      requested.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      return Promise.resolve(new Response(new Blob(['thumb'], { type: 'image/webp' })));
    }) as unknown as typeof fetch;
    try {
      await renderLightbox();
      const stripImages = () => [
        screen.getByRole('button', { name: 'View generated image' }),
        screen.getByRole('button', { name: 'View reference image 1 of 2' }),
        screen.getByRole('button', { name: 'View reference image 2 of 2' }),
      ].map((button) => button.querySelector('img')?.getAttribute('src'));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(stripImages().every((src) => src?.startsWith('blob:strip-') === true)).toBe(true);
      expect(requested).toContain(refImageThumbUrl('ref-one'));
      expect(requested).toContain(refImageThumbUrl('ref-two'));
      expect(requested).toContain('/api/img/generated-with-refs/thumb');
      expect(requested).not.toContain(refImageUrl('ref-one'));
      expect(requested).not.toContain(refImageUrl('ref-two'));

    } finally {
      cleanup();
      globalThis.fetch = realFetch;
      URL.createObjectURL = realCreate;
      resetMediaCacheForTests();
    }
  });

  test('a previous tile\'s strip, still shown from the deferred chrome, cannot select its reference on the new tile', async () => {
    const plainTile: Extract<Tile, { status: 'done' }> = { ...generatedTile, id: 'generated-without-refs', refImageIds: [] };
    const twoTiles: Batch = { ...allDoneBatch, tiles: [generatedTile, plainTile] };
    useAtelierStore.setState({ lightbox: { batchId: twoTiles.id, tileId: generatedTile.id } });
    let clickedStale = false;
    function Probe() {
      const tileId = useAtelierStore((state) => state.lightbox?.tileId);
      useLayoutEffect(() => {
        if (tileId !== plainTile.id || clickedStale) return;
        const stale = screen.queryByRole('button', { name: 'View reference image 1 of 2' });
        if (!stale) return;
        clickedStale = true;
        fireEvent.click(stale);
      }, [tileId]);
      return null;
    }
    render(
      <>
        <Lightbox
          batch={twoTiles}
          modelById={new Map([[imageModel.id, imageModel]])}
          triggerKey={generatedTile.id}
          deleteVariant="archive"
          onClose={mock()}
          onDownload={mock()}
          onDelete={mock()}
        />
        <Probe />
      </>,
      { wrapper: wrapper() },
    );
    await act(async () => { await import('./Content'); });

    // Awaited: the new tile's image suspends the render, and the deferred
    // chrome commits once act settles it.
    await act(() => {
      useAtelierStore.getState().setLightboxTile(plainTile.id);
      return Promise.resolve();
    });

    expect(clickedStale).toBe(true);
    expect(screen.queryByRole('button', { name: /^View reference image/ })).toBeNull();
    expect(screen.queryByAltText(/^Expanded reference image/)).toBeNull();
    expect(screen.getByAltText(/^Expanded generated image/)).toBeTruthy();
  });

  test('a failed full image offers retry and clears the error when the source changes', async () => {
    await renderLightbox();
    fireEvent.error(screen.getByRole('img', { name: /Expanded generated image/ }));
    expect(screen.getByText('Full image unavailable')).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Expanded generated image/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry image' }));
    expect(screen.getByRole('img', { name: /Expanded generated image/ }).getAttribute('src')).toBe(generatedTile.url);

    fireEvent.click(screen.getByRole('button', { name: 'View reference image 1 of 2' }));
    expect(screen.getByText('Reference image unavailable')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'View generated image' }));
    expect(screen.queryByText('Reference image unavailable')).toBeNull();
    expect(screen.getByRole('img', { name: /Expanded generated image/ }).getAttribute('src')).toBe(generatedTile.url);
  });
});
