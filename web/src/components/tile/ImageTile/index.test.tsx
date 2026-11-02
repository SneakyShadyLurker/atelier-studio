import type { Tile } from '@atelier/shared';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ImageTile from './index';

afterEach(cleanup);

const tile: Extract<Tile, { status: 'done' }> = {
  id: 'tile-1',
  status: 'done',
  url: 'http://atelier.test/api/img/tile-1',
  ext: 'png',
  mime: 'image/png',
  seed: 1,
  completedAt: 1,
};

describe('ImageTile frame semantics', () => {
  test('uses a native button frame without nesting tile action buttons inside it', () => {
    render(
      <ImageTile
        tile={tile}
        index={0}
        ratio="1:1"
        aspectRatio="1 / 1"
        onOpen={mock()}
        onDownload={mock()}
        onDelete={mock()}
      />,
    );

    const frame = screen.getByRole('button', { name: 'Open image 1' });
    expect(frame.tagName).toBe('BUTTON');
    expect(within(frame).queryByRole('button', { name: 'Download tile' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Download tile' })).toBeTruthy();
  });

  test('loads above-fold images eagerly with high fetch priority', () => {
    render(
      <ImageTile
        tile={tile}
        index={0}
        isAboveFold
        ratio="1:1"
        aspectRatio="1 / 1"
        onOpen={mock()}
        onDownload={mock()}
        onDelete={mock()}
      />,
    );

    const image = screen.getByRole('img', { name: 'Generated image 1' });
    expect(image.getAttribute('loading')).toBe('eager');
    expect(image.getAttribute('fetchpriority')).toBe('high');
  });
});

describe('ImageTile media failure', () => {
  test('keeps the mat until decode settles and ignores a stale image after fallback', async () => {
    const { container } = render(<ImageTile tile={{ ...tile, thumbUrl: 'http://atelier.test/thumb' }} index={0} ratio="1:1" aspectRatio="1 / 1" seen onOpen={mock()} onDownload={mock()} onDelete={mock()} />);
    const frame = screen.getByRole('button', { name: 'Open image 1' });
    const thumb = container.querySelector('img');
    if (!thumb) throw new Error('missing thumb');
    let finishDecode: () => void = () => undefined;
    Object.defineProperty(thumb, 'naturalWidth', { value: 400 });
    thumb.decode = () => new Promise<void>((resolve) => { finishDecode = resolve; });
    fireEvent.load(thumb);
    expect(frame.getAttribute('data-media-ready')).toBeNull();
    fireEvent.error(thumb);
    await act(async () => { finishDecode(); await Promise.resolve(); });
    expect(frame.getAttribute('data-media-ready')).toBeNull();
    const full = container.querySelector('img');
    if (!full) throw new Error('missing full image');
    Object.defineProperty(full, 'naturalWidth', { value: 400 });
    full.decode = () => Promise.resolve();
    await act(async () => { fireEvent.load(full); await Promise.resolve(); });
    expect(frame.getAttribute('data-media-ready')).toBe('true');
  });
  test('falls back from thumbnail to full image, then offers a retry instead of a broken image', () => {
    const onOpen = mock();
    const { container } = render(
      <ImageTile
        tile={{ ...tile, thumbUrl: 'http://atelier.test/api/img/tile-1/thumb' }}
        index={0}
        ratio="1:1"
        aspectRatio="1 / 1"
        onOpen={onOpen}
        onDownload={mock()}
        onDelete={mock()}
      />,
    );

    const thumb = container.querySelector('img');
    expect(thumb?.getAttribute('src')).toBe('http://atelier.test/api/img/tile-1/thumb');
    if (!thumb) throw new Error('missing img');
    fireEvent.error(thumb);
    const full = container.querySelector('img');
    expect(full?.getAttribute('src')).toBe('http://atelier.test/api/img/tile-1');
    if (!full) throw new Error('missing img');
    fireEvent.error(full);

    expect(container.querySelector('img')).toBeNull();
    const retry = screen.getByRole('button', { name: 'Image 1 failed to load. Retry' });
    fireEvent.click(retry);

    expect(onOpen).not.toHaveBeenCalled();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('http://atelier.test/api/img/tile-1/thumb');
    expect(screen.getByRole('button', { name: 'Open image 1' })).toBeTruthy();
  });
});
