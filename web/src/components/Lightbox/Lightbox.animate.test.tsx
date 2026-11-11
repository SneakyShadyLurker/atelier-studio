import type { Batch, Model, Tile } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import Lightbox from './index';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
import { allDoneBatch } from '../../../test/fixtures/batches';

const imageModel: Model = {
  id: 'gpt-image-2.6-sunburst-cloud',
  name: 'GPT Image 2.6 Sunburst',
  backend: 'cloud',
  tag: 'cloud',
  latency: 'fast',
  supportedRatios: ['1:1', '4:5', '16:9', '9:16'],
  supportsReferenceImages: true,
  pool: 'shared',
  concurrencyCapPerUser: 4,
  maxCountPerBatch: 4,
};

const wanModel: Model = {
  id: 'minimax-h3-i2v',
  name: 'MiniMax H3 I2V',
  backend: 'local',
  tag: 'video',
  latency: 'slow',
  supportedRatios: ['16:9', '9:16', '1:1'],
  supportsI2V: true,
  pool: 'local',
  concurrencyCapPerUser: 1,
  maxCountPerBatch: 1,
  defaultCount: 1,
};

const videoTile: Extract<Tile, { status: 'done' }> = {
  id: 'video-01',
  status: 'done',
  url: '/api/img/video-01',
  thumbUrl: '/api/img/video-01/thumb',
  ext: 'mp4',
  mime: 'video/mp4',
  seed: 9001,
  completedAt: 1_700_000_000_000,
};

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function TestWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

async function renderLightbox(
  batch: Batch = allDoneBatch,
  modelById: ReadonlyMap<string, Model> = new Map([[imageModel.id, imageModel], [wanModel.id, wanModel]]),
) {
  const onClose = mock(() => { return; });
  render(
    <Lightbox
      batch={batch}
      modelById={modelById}
      triggerKey={batch.tiles[0]?.id ?? ''}
      deleteVariant="archive"
      onClose={onClose}
      onDownload={mock()}
      onDelete={mock()}
    />,
    { wrapper: wrapper() },
  );
  await act(async () => { await import('./Content'); });
  return { onClose };
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

describe('Lightbox Animate action', () => {
  test('copies the active image tile on the server and switches the composer to H3 video mode', async () => {
    const uploadResponse = {
      id: 'upload-source-from-tile',
      mime: 'image/png',
      ext: 'png',
      sizeBytes: 11,
      width: 64,
      height: 64,
      createdAt: 1_700_000_000_000,
    };
    const copyRequests: (RequestInit | undefined)[] = [];
    const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      if (url === '/api/tiles/done-01/source-upload') {
        copyRequests.push(init);
        return Promise.resolve(Response.json(uploadResponse, { status: 201 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { onClose } = await renderLightbox();

    const animate = screen.getByRole('button', { name: 'Animate this image' });
    expect(animate.getAttribute('data-tip')).toBe('Animate');

    fireEvent.click(animate);

    await waitFor(() => {
      expect(useAtelierStore.getState().draft.modelId).toBe('minimax-h3-i2v');
      expect(useAtelierStore.getState().draft.i2vSourceUploadId).toBe('upload-source-from-tile');
    });
    expect(useAtelierStore.getState().draft.refImages).toHaveLength(0);
    expect(copyRequests).toHaveLength(1);
    expect(copyRequests[0]?.method).toBe('POST');
    expect(copyRequests[0]?.body ?? null).toBeNull();
    // The original never travels to the browser and back.
    const urls = fetchMock.mock.calls.map(([input]) => fetchInputUrl(input));
    expect(urls).not.toContain('/api/img/done-01');
    expect(urls).not.toContain('/api/uploads');
    // Dismissal rides the shared exit transition (useExitTransition).
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(onClose).toHaveBeenCalled();
  });

  test('does not show Animate for a video tile', async () => {
    await renderLightbox({ ...allDoneBatch, tiles: [videoTile] });

    expect(screen.queryByRole('button', { name: 'Animate this image' })).toBeNull();
  });

  test('does not show Animate when no H3 model is available', async () => {
    await renderLightbox(allDoneBatch, new Map([[imageModel.id, imageModel]]));

    expect(screen.queryByRole('button', { name: 'Animate this image' })).toBeNull();
  });
});

describe('Lightbox busy actions', () => {
  test('Animate stays focusable while preparing: aria-disabled, never disabled', async () => {
    // The tile fetch never settles, so the action stays busy.
    globalThis.fetch = mock(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    await renderLightbox();
    const animate = screen.getByRole('button', { name: 'Animate this image' });
    animate.focus();
    fireEvent.click(animate);
    await waitFor(() => { expect(animate.getAttribute('aria-busy')).toBe('true'); });
    expect(animate.getAttribute('aria-disabled')).toBe('true');
    expect(animate.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement === animate).toBe(true);
  });
});
