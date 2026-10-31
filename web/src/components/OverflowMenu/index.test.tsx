import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { DialogShell } from '../DialogShell';
import OverflowMenu from './index';

// happy-dom honours `inert` but not the top layer: browsers refuse focus to
// anything outside an open modal <dialog>. Emulate that so a restore attempted
// while the dialog is up fails here as it does in the browser.
// eslint-disable-next-line @typescript-eslint/unbound-method -- re-called with an explicit `this`
const nativeFocus = HTMLElement.prototype.focus;
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
