import { afterEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import type { Batch } from '@atelier/shared';
import BatchOverflowMenu, { type BatchOverflowAction } from './index';
import { allDoneBatch } from '../../../test/fixtures/batches';

const originalMatchMedia = window.matchMedia.bind(window);

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

function installPhone(): void {
  window.matchMedia = mock((query: string) => ({
    matches: query.includes('width < 768px'),
    media: query,
    onchange: null,
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
    addListener: mock(() => undefined),
    removeListener: mock(() => undefined),
    dispatchEvent: mock(() => true),
  }));
}

function makeBatch(overrides: Partial<Batch>): Batch {
  return { ...allDoneBatch, ...overrides };
}

function renderMenu(batch: Batch, opts?: { promptsEnabled?: boolean; readOnlyActions?: boolean }) {
  const anchorRef = createRef<HTMLButtonElement>();
  const onSelect = mock((_a: BatchOverflowAction) => { return; });
  const onClose = mock(() => { return; });
  render(
    <>
      <button ref={anchorRef}>anchor</button>
      <BatchOverflowMenu
        batch={batch}
        anchorRef={anchorRef}
        open
        promptsEnabled={opts?.promptsEnabled ?? true}
        readOnlyActions={opts?.readOnlyActions ?? false}
        onSelect={onSelect}
        onClose={onClose}
      />
    </>,
  );
  return { onSelect, onClose };
}

describe('BatchOverflowMenu', () => {
  it('renders the grouped action items as a menu', () => {
    renderMenu(makeBatch({ pinned: false, provenance: { templateId: 't1', templateName: 'T', rollSeed: 1, pins: {} } }));
    expect(screen.getByRole('menu', { name: /batch actions/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /re-roll/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /reopen in picker/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /copy prompt/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /save to templates/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /^pin batch$/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /move to collection/i })).toBeTruthy();
  });

  it('hides Pin when already pinned', () => {
    renderMenu(makeBatch({ pinned: true }));
    expect(screen.queryByRole('menuitem', { name: /^pin batch$/i })).toBeNull();
  });

  it('hides Reopen when there is no template provenance', () => {
    const { provenance: _omit, ...batchWithoutProvenance } = allDoneBatch;
    renderMenu({ ...batchWithoutProvenance });
    expect(screen.queryByRole('menuitem', { name: /reopen in picker/i })).toBeNull();
  });

  it('hides Save to templates when prompts are disabled', () => {
    renderMenu(makeBatch({}), { promptsEnabled: false });
    expect(screen.queryByRole('menuitem', { name: /save to templates/i })).toBeNull();
  });

  it('hides Reopen behind the prompt-library gate even with template provenance', () => {
    renderMenu(
      makeBatch({ provenance: { templateId: 't1', templateName: 'T', rollSeed: 1, pins: {} } }),
      { promptsEnabled: false },
    );
    expect(screen.queryByRole('menuitem', { name: /reopen in picker/i })).toBeNull();
  });

  it('ignores a row activation during the exit fade after Escape', async () => {
    const { onSelect, onClose } = renderMenu(makeBatch({ pinned: false }));
    const reroll = screen.getByRole('menuitem', { name: /re-roll/i });
    reroll.focus();
    fireEvent.keyDown(reroll, { key: 'Escape' });
    // Enter on the still-focused row inside the fade window.
    fireEvent.click(reroll);
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('fires onSelect with the action when a row is clicked', () => {
    const { onSelect } = renderMenu(makeBatch({ pinned: false }));
    fireEvent.click(screen.getByRole('menuitem', { name: /re-roll/i }));
    expect(onSelect).toHaveBeenCalledWith('reroll');
  });

  it('disables non-copy actions under readOnlyActions but keeps Copy enabled', () => {
    renderMenu(makeBatch({ pinned: false }), { readOnlyActions: true });
    const rerollBtn = screen.getByRole('menuitem', { name: /re-roll/i });
    const copyBtn = screen.getByRole('menuitem', { name: /copy prompt/i });
    expect((rerollBtn as HTMLButtonElement).disabled).toBe(true);
    expect((copyBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('closes on Escape from inside the menu', async () => {
    const { onClose } = renderMenu(makeBatch({ pinned: false }));
    const reroll = screen.getByRole('menuitem', { name: /re-roll/i });
    reroll.focus();
    // Dismissal rides the shared exit transition (useExitTransition).
    fireEvent.keyDown(reroll, { key: 'Escape' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(onClose).toHaveBeenCalled();
  });

  it('moves focus between enabled items with Arrow/Home/End keys', () => {
    renderMenu(makeBatch({ pinned: false, provenance: { templateId: 't1', templateName: 'T', rollSeed: 1, pins: {} } }));
    const menu = screen.getByRole('menu', { name: /batch actions/i });
    const reroll = screen.getByRole('menuitem', { name: /re-roll/i });
    const copy = screen.getByRole('menuitem', { name: /copy prompt/i });
    const move = screen.getByRole('menuitem', { name: /move to collection/i });
    reroll.focus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(reroll);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(move);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(reroll); // wraps from last to first
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(move); // wraps from first to last
    reroll.focus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /reopen in picker/i }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(copy);
  });

  // Geometry is asserted in a real browser (e2e/native-anchors.spec.ts); here
  // only the contract the stylesheet relies on.
  it('desktop: a manual popover placed by CSS, with no script geometry on the panel', () => {
    renderMenu(makeBatch({ pinned: false }));
    const menu = screen.getByRole('menu', { name: /batch actions/i });
    expect(menu.getAttribute('data-anchor-place')).toBe('below-end');
    expect(menu.getAttribute('popover')).toBe('manual');
    expect(menu.getAttribute('style')).toBeNull();
  });

  it('phone: the sheet is an ordinary element with no anchoring at all', () => {
    installPhone();
    renderMenu(makeBatch({ pinned: false }));
    const menu = screen.getByRole('menu', { name: /batch actions/i });
    expect(menu.getAttribute('data-mobile')).toBe('true');
    expect(menu.hasAttribute('data-anchor-place')).toBe(false);
    expect(menu.hasAttribute('popover')).toBe(false);
    expect(screen.getByRole('button', { name: 'Close menu' })).toBeTruthy();
  });
});
