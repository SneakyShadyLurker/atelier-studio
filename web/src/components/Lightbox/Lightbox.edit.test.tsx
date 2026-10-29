import type { Batch, Model, Tile } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  maxRefImages: 4,
  defaultCount: 4,
  pool: 'shared',
  concurrencyCapPerUser: 4,
  maxCountPerBatch: 4,
};

const plainModel: Model = {
  ...imageModel,
  id: 'plain-image-model',
  name: 'Plain Image',
  supportsReferenceImages: false,
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

const originalFetch = globalThis.fetch;
const createObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const revokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

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
  modelById: ReadonlyMap<string, Model> = new Map([[imageModel.id, imageModel]]),
) {
  const onClose = mock(() => { return; });
  const rendered = render(
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
  return { onClose, unmount: rendered.unmount };
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  if (createObjectURLDescriptor) Object.defineProperty(URL, 'createObjectURL', createObjectURLDescriptor);
  if (revokeObjectURLDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeObjectURLDescriptor);
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

describe('Lightbox Edit action', () => {
  test('uploads the active generated image and opens the composer on its source model', async () => {
    URL.createObjectURL = mock(() => 'blob:generated-edit');
    URL.revokeObjectURL = mock(() => undefined);
    useAtelierStore.setState((state) => ({
      draft: {
        ...state.draft,
        modelId: plainModel.id,
        count: 1,
        i2vSourceUploadId: 'upload-old-video-source',
        motionPrompt: 'old motion',
      },
      composerExpanded: false,
    }));
    const uploadResponse = {
      id: 'upload-generated-edit',
      mime: 'image/png',
      ext: 'png',
      sizeBytes: 10,
      width: 64,
      height: 64,
      createdAt: 1_700_000_000_000,
    };
    const fetchMock = mock((input: RequestInfo | URL) => {
      const url = fetchInputUrl(input);
      if (url === '/api/img/done-01') {
        return Promise.resolve(new Response(new Blob(['tile-bytes'], { type: 'image/png' })));
      }
      if (url === '/api/uploads') return Promise.resolve(Response.json(uploadResponse));
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { onClose } = renderLightbox(
      allDoneBatch,
      new Map([[imageModel.id, imageModel], [plainModel.id, plainModel]]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit from this image' }));

    await waitFor(() => {
      const state = useAtelierStore.getState();
      expect(state.draft.modelId).toBe(imageModel.id);
      expect(state.draft.count).toBe(4);
      expect(state.draft.i2vSourceUploadId).toBeUndefined();
      expect(state.draft.motionPrompt).toBeUndefined();
      expect(state.draft.lastImageModelId).toBe(imageModel.id);
      expect(state.draft.refImages[0]?.serverId).toBe(uploadResponse.id);
      expect(state.composerExpanded).toBe(true);
    });
    expect(fetchMock.mock.calls.some(([input]) => fetchInputUrl(input) === '/api/img/done-01')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onClose).toHaveBeenCalled();
  });

  test('does not offer Edit for videos or models without reference-image support', () => {
    const { unmount } = renderLightbox({ ...allDoneBatch, tiles: [videoTile] });
    expect(screen.queryByRole('button', { name: 'Edit from this image' })).toBeNull();
    unmount();

    renderLightbox(
      { ...allDoneBatch, modelId: plainModel.id, modelLabel: plainModel.name },
      new Map([[plainModel.id, plainModel]]),
    );
    expect(screen.queryByRole('button', { name: 'Edit from this image' })).toBeNull();
  });
});
