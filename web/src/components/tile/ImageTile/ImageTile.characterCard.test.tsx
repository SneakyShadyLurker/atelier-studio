import type { Tile } from '@atelier/shared';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ImageTile from './index';

afterEach(cleanup);

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

const videoTile: Extract<Tile, { status: 'done' }> = {
  ...imageTile,
  id: 'video-tile-1',
  url: 'http://atelier.test/api/img/video-tile-1',
  thumbUrl: 'http://atelier.test/api/img/video-tile-1/thumb',
  ext: 'mp4',
  mime: 'video/mp4',
};

interface RenderOptions {
  tile?: Extract<Tile, { status: 'done' }>;
  canCreateCard?: boolean;
  creatingCard?: boolean;
  onCreateCard?: (() => Promise<boolean>) | undefined;
}

function tileElement({ tile = imageTile, canCreateCard = false, creatingCard = false, onCreateCard }: RenderOptions = {}) {
  return (
    <ImageTile
      tile={tile}
      index={0}
      ratio="16:9"
      aspectRatio="16 / 9"
      canCreateCard={canCreateCard}
      creatingCard={creatingCard}
      onOpen={mock()}
      onDownload={mock()}
      onDelete={mock()}
      onCreateCard={onCreateCard}
    />
  );
}

const cardButtonName = 'Create character card from image 1';

describe('ImageTile Character card action', () => {
  test('renders only with eligibility and a handler, and never on a video tile', () => {
    const handler = () => Promise.resolve(true);
    const { rerender } = render(tileElement({ canCreateCard: true, onCreateCard: handler }));
    const button = screen.getByRole('button', { name: cardButtonName });
    expect(button.getAttribute('data-tip')).toBe('Character card');

    rerender(tileElement({ canCreateCard: false, onCreateCard: handler }));
    expect(screen.queryByRole('button', { name: cardButtonName })).toBeNull();

    rerender(tileElement({ canCreateCard: true }));
    expect(screen.queryByRole('button', { name: cardButtonName })).toBeNull();

    rerender(tileElement({ tile: videoTile, canCreateCard: true, onCreateCard: handler }));
    expect(screen.queryByRole('button', { name: /character card/i })).toBeNull();
  });

  test('invokes the handler once and ignores a second click while creating', () => {
    const onCreateCard = mock(() => new Promise<boolean>(() => undefined));
    const { rerender } = render(tileElement({ canCreateCard: true, onCreateCard }));

    fireEvent.click(screen.getByRole('button', { name: cardButtonName }));
    expect(onCreateCard).toHaveBeenCalledTimes(1);

    // The store marks the tile pending; the parent passes it back down.
    rerender(tileElement({ canCreateCard: true, creatingCard: true, onCreateCard }));
    fireEvent.click(screen.getByRole('button', { name: cardButtonName }));
    expect(onCreateCard).toHaveBeenCalledTimes(1);
  });

  test('a remount while creating shows the spinner on a disabled button', () => {
    render(tileElement({ canCreateCard: true, creatingCard: true, onCreateCard: () => Promise.resolve(true) }));
    const button = screen.getByRole<HTMLButtonElement>('button', { name: cardButtonName });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('data-tip')).toBe('Writing card…');
    expect(button.querySelector('svg')).toBeNull();
    expect(button.querySelector('span[aria-hidden="true"]')).not.toBeNull();
  });
});
