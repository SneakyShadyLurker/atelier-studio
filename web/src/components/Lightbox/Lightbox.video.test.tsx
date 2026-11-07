import type { Batch, Model, Tile } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, render, screen } from '@testing-library/react';
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

async function renderLightbox(batch: Batch) {
  const rendered = render(
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
  await act(async () => { await import('./Content'); });
  return rendered;
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

describe('Lightbox video rendering', () => {
  test('renders video tiles as controls-enabled video with a poster', async () => {
    await renderLightbox({ ...allDoneBatch, tiles: [videoTile] });

    const video = document.body.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute('src')).toBe('/api/img/video-01');
    expect(video?.getAttribute('poster')).toBe('/api/img/video-01/thumb');
    expect(video?.hasAttribute('controls')).toBe(true);
    expect(document.body.querySelector('img')).toBeNull();
    expect(document.body.querySelector('[data-media="video"]')).toBeTruthy();
    expect(document.body.querySelector('div[data-media="video"] video')).toBe(video);
  });

  test('renders image tiles as images', async () => {
    await renderLightbox(allDoneBatch);

    expect(screen.getByRole('img', { name: /Expanded generated image/ })).toBeTruthy();
  });
});


test('keeps the same frame through still and video navigation', async () => {
  const first = allDoneBatch.tiles[0];
  if (!first) throw new Error('still fixture required');
  useAtelierStore.getState().openLightbox(allDoneBatch.id, first.id);
  await renderLightbox({ ...allDoneBatch, tiles: [first, videoTile] });
  const frame = document.querySelector('dialog > [aria-busy]');
  act(() => { useAtelierStore.getState().setLightboxTile(videoTile.id); });
  expect(document.querySelector('dialog > [aria-busy]')).toBe(frame);
  expect(frame?.querySelector('video')?.getAttribute('poster')).toBe(videoTile.thumbUrl);
  expect((frame as HTMLElement | null)?.style.getPropertyValue('--frame-ratio')).toBe('');
  act(() => { useAtelierStore.getState().setLightboxTile(first.id); });
  expect(document.querySelector('dialog > [aria-busy]')).toBe(frame);
  expect(frame?.querySelector('img')).toBeTruthy();
});

test('a sequence master keeps native controls, download and no tile navigation', async () => {
  const download = mock();
  await act(async () => {
    render(<Lightbox batch={{ ...allDoneBatch, tiles: [videoTile] }} modelById={new Map()} triggerKey={videoTile.id} deleteVariant="archive" onClose={mock()} onDownload={mock()} onDelete={mock()} master={{ url: '/sequence/master.mp4', durationLabel: '10 seconds', onDownload: download }} />, { wrapper: wrapper() });
    await import('./Content');
  });
  const video = document.querySelector('video');
  expect(video?.getAttribute('src')).toBe('/sequence/master.mp4');
  expect(video?.hasAttribute('controls')).toBe(true);
  expect(video?.hasAttribute('playsinline')).toBe(true);
  expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Next image' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Previous image' })).toBeNull();
  screen.getByRole('button', { name: 'Download sequence master' }).click();
  expect(download).toHaveBeenCalledTimes(1);
});
