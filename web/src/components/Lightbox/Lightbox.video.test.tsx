import type { Batch, Model, Tile } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { allDoneBatch } from '../../../test/fixtures/batches';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
import Lightbox from './index';

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

function renderLightbox(batch: Batch) {
  return render(
    <Lightbox
      batch={batch}
      modelById={new Map([[imageModel.id, imageModel]])}
      triggerKey={batch.tiles[0]?.id ?? ''}
      deleteVariant="archive"
      onClose={mock()}
      onDownload={mock()}
      onDelete={mock()}
    />,
    { wrapper: wrapper() },
  );
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

describe('Lightbox video rendering', () => {
  test('renders video tiles as controls-enabled video with a poster', () => {
    renderLightbox({ ...allDoneBatch, tiles: [videoTile] });

    const video = document.body.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute('src')).toBe('/api/img/video-01');
    expect(video?.getAttribute('poster')).toBe('/api/img/video-01/thumb');
    expect(video?.hasAttribute('controls')).toBe(true);
    expect(document.body.querySelector('img')).toBeNull();
    expect(document.body.querySelector('[data-media="video"]')).toBeTruthy();
    expect(document.body.querySelector('div[data-media="video"] video')).toBe(video);
  });

  test('renders image tiles as images', () => {
    renderLightbox(allDoneBatch);

    expect(screen.getByRole('img', { name: /Expanded generated image/ })).toBeTruthy();
  });
});
