import type { Tile } from '@atelier/shared';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

interface RenderOpts {
  canAnimate?: boolean;
  onAnimate?: (() => Promise<boolean>) | undefined;
}

function renderTile({ canAnimate = false, onAnimate }: RenderOpts = {}) {
  return render(
    <ImageTile
      tile={imageTile}
      index={0}
      ratio="16:9"
      aspectRatio="16 / 9"
      canAnimate={canAnimate}
      onOpen={mock()}
      onDownload={mock()}
      onDelete={mock()}
      onAnimate={onAnimate}
    />,
  );
}

describe('ImageTile Animate action', () => {
  test('renders the Animate button when enabled and a handler is supplied', () => {
    renderTile({ canAnimate: true, onAnimate: () => Promise.resolve(true) });
    expect(screen.getByRole('button', { name: 'Animate image 1' })).toBeTruthy();
  });

  test('hides the Animate button when not eligible', () => {
    renderTile({ canAnimate: false, onAnimate: () => Promise.resolve(true) });
    expect(screen.queryByRole('button', { name: 'Animate image 1' })).toBeNull();
  });

  test('hides the Animate button when no handler is supplied', () => {
    renderTile({ canAnimate: true });
    expect(screen.queryByRole('button', { name: 'Animate image 1' })).toBeNull();
  });

  test('invokes the handler and shows a pending state until it settles', async () => {
    let resolveAnimate: ((value: boolean) => void) | undefined;
    const onAnimate = mock(() => new Promise<boolean>((resolve) => { resolveAnimate = resolve; }));
    renderTile({ canAnimate: true, onAnimate });

    const button = screen.getByRole('button', { name: 'Animate image 1' });
    fireEvent.click(button);
    expect(onAnimate).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolveAnimate?.(true);
      await Promise.resolve();
    });
    expect(button.getAttribute('aria-busy')).toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
