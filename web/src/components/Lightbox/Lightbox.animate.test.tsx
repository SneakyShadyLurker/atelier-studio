import type { Batch, Model, Tile } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import Lightbox from './index';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
import { allDoneBatch } from '../../../test/fixtures/batches';

const imageModel: Model = {
  id: 'gpt-image-2.5-sunburst-cloud',
  name: 'GPT Image 2.5 Sunburst',
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

function renderLightbox(
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
  test('uploads the active image tile and switches the composer to H3 video mode', async () => {
    const uploadResponse = {
      id: 'upload-source-from-tile',
      mime: 'image/png',
      ext: 'png',
      sizeBytes: 11,
      width: 64,
      height: 64,
      createdAt: 1_700_000_000_000,
    };
    const uploadedBodies: BodyInit[] = [];
    const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      if (url === '/api/img/done-01') {
        return Promise.resolve(new Response(new Blob(['tile-bytes'], { type: 'image/png' })));
      }
      if (url === '/api/uploads') {
        if (init?.body != null) uploadedBodies.push(init.body);
        return Promise.resolve(Response.json(uploadResponse));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { onClose } = renderLightbox();

    const animate = screen.getByRole('button', { name: 'Animate this image' });
    expect(animate.getAttribute('data-tip')).toBe('Animate');

    fireEvent.click(animate);

    await waitFor(() => {
      expect(useAtelierStore.getState().draft.modelId).toBe('minimax-h3-i2v');
      expect(useAtelierStore.getState().draft.i2vSourceUploadId).toBe('upload-source-from-tile');
    });
    expect(useAtelierStore.getState().draft.refImages).toHaveLength(0);
    const imageCall = fetchMock.mock.calls.find(([input]) => fetchInputUrl(input) === '/api/img/done-01');
    expect(imageCall).toBeDefined();
    const imageHeaders = new Headers(imageCall?.[1]?.headers);
    expect(imageHeaders.get('Accept')).toBe('image/png');
    expect(uploadedBodies).toHaveLength(1);
    const uploadBody = uploadedBodies[0];
    expect(uploadBody).toBeInstanceOf(FormData);
    if (!(uploadBody instanceof FormData)) throw new Error('expected upload body to be FormData');
    const file = uploadBody.get('file');
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new Error('expected upload file');
    expect(file.name).toBe('done-01.png');
    expect(file.type).toBe('image/png');
    expect(await file.text()).toBe('tile-bytes');
    // Dismissal rides the shared exit transition (useExitTransition).
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(onClose).toHaveBeenCalled();
  });

  test('does not show Animate for a video tile', () => {
    renderLightbox({ ...allDoneBatch, tiles: [videoTile] });

    expect(screen.queryByRole('button', { name: 'Animate this image' })).toBeNull();
  });

  test('does not show Animate when no H3 model is available', () => {
    renderLightbox(allDoneBatch, new Map([[imageModel.id, imageModel]]));

    expect(screen.queryByRole('button', { name: 'Animate this image' })).toBeNull();
  });
});
