import type { Tile } from '@atelier/shared';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ImageTile from './index';

afterEach(cleanup);

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
  test('renders video tiles as video with poster and play badge', () => {
    const { container } = renderTile(videoTile);

    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute('poster')).toBe('http://atelier.test/api/img/video-tile-1/thumb');
    expect(video?.getAttribute('preload')).toBe('none');
    expect(video?.hasAttribute('muted')).toBe(true);
    expect(video?.hasAttribute('playsinline')).toBe(true);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('play-badge')).toBeTruthy();
  });

  test('renders image tiles as images without play badge', () => {
    const { container } = renderTile(imageTile);

    expect(screen.getByRole('img', { name: 'Generated image 1' })).toBeTruthy();
    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByTestId('play-badge')).toBeNull();
  });

  test('poster errors do not replace video tiles with a broken image path', () => {
    const { container } = renderTile(videoTile);

    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    if (!video) throw new Error('expected video');
    fireEvent.error(video);

    expect(container.querySelector('video')).toBe(video);
    expect(container.querySelector('img')).toBeNull();
  });
});
