import type { Batch } from '@atelier/shared';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useKeyboard, useKeyboardScopeActive, useKeyboardScoped } from './useKeyboard';
import { useAtelierStore } from '../store/atelier';

const lightboxBatch: Batch = {
  id: 'batch-keyboard',
  prompt: 'keyboard lightbox',
  ratio: '1:1',
  modelId: 'gpt-image-2.5-sunburst-cloud',
  modelLabel: 'GPT Image 2.5 Sunburst',
  createdAt: 1,
  collectionId: null,
  pinned: false,
  status: 'done',
  tiles: [
    {
      id: 'tile-1',
      seed: 1,
      status: 'done',
      url: '/one.png',
      ext: 'png',
      mime: 'image/png',
      completedAt: 1,
    },
    {
      id: 'tile-2',
      seed: 2,
      status: 'done',
      url: '/two.png',
      ext: 'png',
      mime: 'image/png',
      completedAt: 2,
    },
  ],
};

function LightboxKeyboardHarness() {
  useKeyboard([lightboxBatch]);
  return <button type="button">target</button>;
}

function ArchiveLightboxKeyboardHarness() {
  const archivedBatch: Batch = {
    ...lightboxBatch,
    id: 'archive-batch',
    tiles: lightboxBatch.tiles.map((tile) => ({ ...tile, id: `archive-${tile.id}` })),
  };
  useKeyboard((batchId) => (batchId === archivedBatch.id ? archivedBatch : undefined));
  return <button type="button">target</button>;
}

function ScopedKeyboardHarness({
  composerActive = false,
  confirmActive = false,
  onComposerEnter = mock(),
  onConfirmEnter = mock(),
}: {
  composerActive?: boolean;
  confirmActive?: boolean;
  onComposerEnter?: (event: KeyboardEvent) => void;
  onConfirmEnter?: (event: KeyboardEvent) => void;
}) {
  useKeyboard([]);
  useKeyboardScopeActive('composer', composerActive);
  useKeyboardScoped('composer', 'Enter', onComposerEnter, composerActive);
  useKeyboardScopeActive('confirm-open', confirmActive);
  useKeyboardScoped('confirm-open', 'Enter', onConfirmEnter, confirmActive);
  return <button type="button">target</button>;
}

function SameScopeKeyboardHarness({
  firstActive,
  secondActive,
  onFirstEnter,
  onSecondEnter,
}: {
  firstActive: boolean;
  secondActive: boolean;
  onFirstEnter: (event: KeyboardEvent) => void;
  onSecondEnter: (event: KeyboardEvent) => void;
}) {
  useKeyboard([]);
  useKeyboardScopeActive('chipselect-open', firstActive);
  useKeyboardScoped('chipselect-open', 'Enter', onFirstEnter, firstActive);
  useKeyboardScopeActive('chipselect-open', secondActive);
  useKeyboardScoped('chipselect-open', 'Enter', onSecondEnter, secondActive);
  return <button type="button">target</button>;
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ lightbox: null, sidebarOpen: false });
});

describe('useKeyboard', () => {
  test('scoped handler fires when its scope is active', () => {
    const onConfirmEnter = mock();
    render(<ScopedKeyboardHarness confirmActive onConfirmEnter={onConfirmEnter} />);

    fireEvent.keyDown(document, { key: 'Enter' });

    expect(onConfirmEnter).toHaveBeenCalledTimes(1);
  });

  test('scoped handler does not fire when its scope is inactive', () => {
    const onConfirmEnter = mock();
    render(<ScopedKeyboardHarness onConfirmEnter={onConfirmEnter} />);

    fireEvent.keyDown(document, { key: 'Enter' });

    expect(onConfirmEnter).not.toHaveBeenCalled();
  });

  test('topmost active scope wins when two scopes share a key', () => {
    const onComposerEnter = mock();
    const onConfirmEnter = mock();
    render(
      <ScopedKeyboardHarness
        composerActive
        confirmActive
        onComposerEnter={onComposerEnter}
        onConfirmEnter={onConfirmEnter}
      />,
    );

    fireEvent.keyDown(document, { key: 'Enter' });

    expect(onConfirmEnter).toHaveBeenCalledTimes(1);
    expect(onComposerEnter).not.toHaveBeenCalled();
  });

  test('same-scope scoped dispatch ignores inactive sibling handlers', () => {
    const onFirstEnter = mock();
    const onSecondEnter = mock();
    render(
      <SameScopeKeyboardHarness
        firstActive
        secondActive={false}
        onFirstEnter={onFirstEnter}
        onSecondEnter={onSecondEnter}
      />,
    );

    fireEvent.keyDown(document, { key: 'Enter' });

    expect(onFirstEnter).toHaveBeenCalledTimes(1);
    expect(onSecondEnter).not.toHaveBeenCalled();
  });

  test('lightbox arrow keys update the store-owned active tile', () => {
    useAtelierStore.setState({ lightbox: { batchId: 'batch-keyboard', tileId: 'tile-1' } });
    render(<LightboxKeyboardHarness />);

    fireEvent.keyDown(document, { key: 'ArrowRight' });

    expect(useAtelierStore.getState().lightbox?.tileId).toBe('tile-2');
  });

  test('lightbox arrow keys can resolve an archive-only batch', () => {
    useAtelierStore.setState({ lightbox: { batchId: 'archive-batch', tileId: 'archive-tile-1' } });
    render(<ArchiveLightboxKeyboardHarness />);

    fireEvent.keyDown(document, { key: 'ArrowRight' });

    expect(useAtelierStore.getState().lightbox?.tileId).toBe('archive-tile-2');
  });
});
