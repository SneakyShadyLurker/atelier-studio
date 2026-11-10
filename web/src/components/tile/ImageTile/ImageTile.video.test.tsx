import type { Tile } from '@atelier/shared';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { resetMediaCacheForTests } from '../../../lib/mediaCache';
import ImageTile from './index';

interface FetchCall { url: string; resolve: (response: Response) => void }

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL.bind(URL);
const realRevoke = URL.revokeObjectURL.bind(URL);
let calls: FetchCall[] = [];

beforeEach(() => {
  calls = [];
  resetMediaCacheForTests({ capBytes: 10_000, backoffMs: 1, maxRetryAfterMs: 1 });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, resolve });
    init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); });
  })) as typeof fetch;
  URL.createObjectURL = () => 'blob:poster/1';
  URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
  cleanup();
  resetMediaCacheForTests();
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await new Promise((resolve) => { setTimeout(resolve, 2); });
  });
}

const videoTile: Extract<Tile, { status: 'done' }> = {
  id: 'video-tile-1',
  status: 'done',
  url: 'http://atelier.test/api/img/video-tile-1',
  thumbUrl: 'http://atelier.test/api/img/video-tile-1/thumb',
  ext: 'mp4',
  mime: 'video/mp4',
  seed: 1,
  completedAt: 1,
};

const imageTile: Extract<Tile, { status: 'done' }> = {
  id: 'image-tile-1',
  status: 'done',
  url: 'http://atelier.test/api/img/image-tile-1',
  thumbUrl: 'http://atelier.test/api/img/image-tile-1/thumb',
  ext: 'png',
  mime: 'image/png',
  seed: 2,
  completedAt: 1,
};

function renderTile(tile: Extract<Tile, { status: 'done' }>) {
  return render(
    <ImageTile
      tile={tile}
      index={0}
      ratio="16:9"
      aspectRatio="16 / 9"
      onOpen={mock()}
      onDownload={mock()}
      onDelete={mock()}
    />,
  );
}

describe('ImageTile video rendering', () => {
  test('renders video tiles as video with a cached poster and play badge', async () => {
    const { container } = renderTile(videoTile);

    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    // The plate mat shows under the badge until the poster bytes arrive.
    expect(video?.hasAttribute('poster')).toBe(false);
    expect(calls.map((call) => call.url)).toEqual(['http://atelier.test/api/img/video-tile-1/thumb']);
    calls[0]?.resolve(new Response(new Blob([new Uint8Array(8)]), { status: 200 }));
    await settle();
    expect(container.querySelector('video')?.getAttribute('poster')).toBe('blob:poster/1');
    expect(video?.getAttribute('preload')).toBe('none');
    expect(video?.hasAttribute('muted')).toBe(true);
    expect(video?.hasAttribute('playsinline')).toBe(true);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('play-badge')).toBeTruthy();
  });

  test('renders image tiles as images without play badge', async () => {
    const { container } = renderTile(imageTile);
    calls[0]?.resolve(new Response(new Blob([new Uint8Array(8)]), { status: 200 }));
    await settle();

    expect(screen.getByRole('img', { name: 'Generated image 1' })).toBeTruthy();
    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByTestId('play-badge')).toBeNull();
  });

  test('names the clip as a video', () => {
    renderTile(videoTile);
    expect(screen.getByRole('button', { name: 'Open video 1' })).toBeTruthy();
  });

  test('a poster that fails to download leaves the plate mat, not a broken poster', async () => {
    const { container } = renderTile(videoTile);
    calls[0]?.resolve(new Response(null, { status: 404 }));
    await settle();
    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.hasAttribute('poster')).toBe(false);
    expect(screen.getByTestId('play-badge')).toBeTruthy();
  });

  test('a clip whose media errors shows the failed state, and Retry reloads the clip', () => {
    const onOpen = mock();
    const { container } = render(
      <ImageTile tile={videoTile} index={0} ratio="16:9" aspectRatio="16 / 9" onOpen={onOpen} onDownload={mock()} onDelete={mock()} />,
    );
    const video = container.querySelector('video');
    if (!video) throw new Error('expected video');
    fireEvent.error(video);

    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText('Couldn’t load. Retry')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Video 1 failed to load. Retry' });
    fireEvent.click(retry);

    expect(onOpen).not.toHaveBeenCalled();
    const reloaded = container.querySelector('video');
    expect(reloaded).toBeTruthy();
    expect(reloaded === video).toBe(false);
    expect(screen.getByRole('button', { name: 'Open video 1' })).toBeTruthy();
  });
});
