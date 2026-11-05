import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { DialogShell } from '../DialogShell';
import Toast from '../Toast';
import { getToastHost } from '../../lib/toastHost';
import { initialAtelierState, useAtelierStore } from '../../store/atelier';
import OverflowMenu from './index';

// happy-dom honours `inert` but not the top layer: browsers refuse focus to
// anything outside an open modal <dialog>. Emulate that so a restore attempted
// while the dialog is up fails here as it does in the browser.
// eslint-disable-next-line @typescript-eslint/unbound-method -- re-called with an explicit `this`
const nativeFocus = HTMLElement.prototype.focus;
const nativeMatchMedia = window.matchMedia.bind(window);
beforeEach(() => {
  HTMLElement.prototype.focus = function focus(this: HTMLElement, options?: FocusOptions) {
    const modal = Array.from(document.querySelectorAll('dialog')).find((dialog) => dialog.open);
    if (modal && !modal.contains(this)) return;
    nativeFocus.call(this, options);
  };
});

afterEach(() => {
  cleanup();
  HTMLElement.prototype.focus = nativeFocus;
  window.matchMedia = nativeMatchMedia;
  useAtelierStore.setState(initialAtelierState, true);
});

const GROUPS = [{ key: 'main', items: [{ action: 'edit' as const, label: 'Edit', icon: null }] }];

// The owner pattern both callers use: selecting closes the menu and opens a
// dialog in the same handler.
function Harness() {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => { setMenuOpen(true); }}>More</button>
      <OverflowMenu
        label="Actions"
        anchorRef={triggerRef}
        open={menuOpen}
        groups={GROUPS}
        onClose={() => { setMenuOpen(false); }}
        onSelect={() => {
          setMenuOpen(false);
          setDialogOpen(true);
        }}
      />
      <DialogShell open={dialogOpen} onCancel={() => { setDialogOpen(false); }} label="Edit">
        <button type="button" onClick={() => { setDialogOpen(false); }}>Done</button>
      </DialogShell>
    </>
  );
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe('OverflowMenu', () => {
  it.each([false, true])('keeps live feedback and Undo outside menu semantics inside the trapped panel (phone: %s)', async (phone) => {
    window.matchMedia = mock((query: string) => ({
      matches: phone && query.includes('width < 768px'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }));
    render(<><Harness /><Toast /></>);
    const trigger = screen.getByRole('button', { name: 'More' });
    trigger.focus();
    fireEvent.click(trigger);
    await flush();
    const menu = screen.getByRole('menu', { name: 'Actions' });
    const panel = menu.parentElement;
    expect(panel).toBe(getToastHost()?.element ?? null);
    const undoAction = mock();
    act(() => {
      useAtelierStore.getState().addToast('Saved', 'success');
      useAtelierStore.getState().addToast('Could not save', 'error');
      useAtelierStore.getState().addToast('Archived', 'success', 5000, { label: 'Undo', onClick: undoAction });
    });
    await flush();
    const undo = screen.getByRole('button', { name: 'Undo' });
    const feedback = [...screen.getAllByRole('status'), screen.getByRole('alert')];
    expect(feedback.some((region) => region.textContent === 'Saved')).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe('Could not save');
    for (const region of feedback) {
      expect(panel?.contains(region)).toBe(true);
      expect(menu.contains(region)).toBe(false);
    }
    expect(panel?.contains(undo)).toBe(true);
    expect(menu.contains(undo)).toBe(false);
    expect(undo.closest('[inert], [aria-hidden="true"]')).toBeNull();

    const item = screen.getByRole('menuitem', { name: 'Edit' });
    item.focus();
    fireEvent.keyDown(item, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(undo);
    fireEvent.click(undo);
    expect(undoAction).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(undo, { key: 'Tab' });
    expect(document.activeElement).toBe(item);
    expect(screen.getByRole('menu', { name: 'Actions' })).toBe(menu);
  });

  it('returns focus to its trigger when an action opens a dialog that then closes', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'More' });
    trigger.focus();
    fireEvent.click(trigger);
    await flush();
    const item = screen.getByRole('menuitem', { name: 'Edit' });
    item.focus();
    expect(document.activeElement).toBe(item);

    fireEvent.click(item);
    await flush();
    const done = screen.getByRole('button', { name: 'Done' });
    // showModal() focuses the dialog's first control in the browser; happy-dom does not.
    done.focus();
    expect(document.activeElement).toBe(done);

    fireEvent.click(done);
    await flush();
    expect(document.activeElement).toBe(trigger);
  });
});
