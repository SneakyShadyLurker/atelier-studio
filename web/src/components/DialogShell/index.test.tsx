import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { DialogShell } from './index';

/*
 * Focus restore after a native modal closes. happy-dom's showModal() does not
 * move focus, so the platform's dialog focusing step (the first focusable
 * descendant takes focus) is reproduced here; without it the double-invoked
 * layout effect of StrictMode could not capture the wrong element.
 */
const originalShowModal: (this: HTMLDialogElement) => void = Reflect.get(HTMLDialogElement.prototype, 'showModal');

function flushMicrotasks(): Promise<void> {
  return act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function Harness({ open, restore }: { open: boolean; restore?: (opener: HTMLElement) => () => HTMLElement | null }) {
  return (
    <>
      <div data-testid="feed">
        <button type="button" id="before">before</button>
        {/* The opener lives outside the harness so tests can remove it. */}
        <button type="button" id="after">after</button>
      </div>
      <DialogShell open={open} onCancel={() => undefined} label="Viewer" restoreFocus={restore}>
        <button type="button" id="inside">Close</button>
      </DialogShell>
    </>
  );
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    originalShowModal.call(this);
    this.querySelector<HTMLElement>('button')?.focus();
  };
});

afterEach(() => {
  HTMLDialogElement.prototype.showModal = originalShowModal;
  cleanup();
  document.getElementById('opener')?.remove();
});

function mountOpener(): HTMLButtonElement {
  const opener = document.createElement('button');
  opener.id = 'opener';
  opener.textContent = 'Open image';
  document.body.append(opener);
  opener.focus();
  return opener;
}

describe('DialogShell focus restore', () => {
  test('returns focus to the opener when the dialog closes', async () => {
    const opener = mountOpener();
    const view = render(<Harness open />);
    expect(document.activeElement?.id).toBe('inside');
    view.rerender(<Harness open={false} />);
    await flushMicrotasks();
    expect(document.activeElement === opener).toBe(true);
  });

  test('a re-run layout effect (StrictMode) keeps the original opener', async () => {
    const opener = mountOpener();
    const view = render(<StrictMode><Harness open /></StrictMode>);
    await flushMicrotasks();
    // The simulated unmount must not hand focus out of the open dialog.
    expect(document.activeElement?.id).toBe('inside');
    view.rerender(<StrictMode><Harness open={false} /></StrictMode>);
    await flushMicrotasks();
    expect(document.activeElement === opener).toBe(true);
  });

  test('the owner resolves the target after a real close from what it recorded at open', async () => {
    const opener = mountOpener();
    const recorded: { with: HTMLElement | null } = { with: null };
    let resolved = 0;
    const view = render(
      <StrictMode>
        <Harness
          open
          restore={(from) => {
            recorded.with = from;
            return () => { resolved += 1; return from.isConnected ? from : document.getElementById('after'); };
          }}
        />
      </StrictMode>,
    );
    await flushMicrotasks();
    // StrictMode's re-run did not resolve a target.
    expect(resolved).toBe(0);
    expect(recorded.with === opener).toBe(true);
    opener.remove();
    view.rerender(<StrictMode><Harness open={false} /></StrictMode>);
    await flushMicrotasks();
    expect(resolved).toBe(1);
    expect(document.activeElement?.id).toBe('after');
  });

  test('leaves focus alone when the owner already moved it out of the dialog', async () => {
    mountOpener();
    const view = render(<Harness open />);
    view.rerender(<Harness open={false} />);
    document.getElementById('before')?.focus();
    await flushMicrotasks();
    expect(document.activeElement?.id).toBe('before');
  });
});
