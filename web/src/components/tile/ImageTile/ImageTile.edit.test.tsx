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

interface RenderOptions {
  canEdit?: boolean;
  onEdit?: (() => Promise<boolean>) | undefined;
}

function renderTile({ canEdit = false, onEdit }: RenderOptions = {}) {
  return render(
    <ImageTile
      tile={imageTile}
      index={0}
      ratio="16:9"
      aspectRatio="16 / 9"
      canEdit={canEdit}
      onOpen={mock()}
      onDownload={mock()}
      onDelete={mock()}
      onEdit={onEdit}
    />,
  );
}

describe('ImageTile Edit action', () => {
  test('renders only when the tile is eligible and a handler is supplied', () => {
    const { rerender } = renderTile({ canEdit: true, onEdit: () => Promise.resolve(true) });
    expect(screen.getByRole('button', { name: 'Edit image 1' })).toBeTruthy();

    rerender(
      <ImageTile
        tile={imageTile}
        index={0}
        ratio="16:9"
        aspectRatio="16 / 9"
        canEdit={false}
        onOpen={mock()}
        onDownload={mock()}
        onDelete={mock()}
        onEdit={() => Promise.resolve(true)}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Edit image 1' })).toBeNull();
  });

  test('invokes the handler and shows a pending state until it settles', async () => {
    let resolveEdit: ((value: boolean) => void) | undefined;
    const onEdit = mock(() => new Promise<boolean>((resolve) => { resolveEdit = resolve; }));
    renderTile({ canEdit: true, onEdit });

    const button = screen.getByRole('button', { name: 'Edit image 1' });
    fireEvent.click(button);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      resolveEdit?.(true);
      await Promise.resolve();
    });
    expect(button.getAttribute('aria-busy')).toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
