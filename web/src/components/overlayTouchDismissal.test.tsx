import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import type { PropsWithChildren } from 'react';
import BatchOverflowMenu from './BatchOverflowMenu';
import MovePopover from './MovePopover';
import HelpPanel from './PromptManager/HelpPanel';
import { allDoneBatch } from '../../test/fixtures/batches';
import { APP_VIEW_UNSORTED } from '../store/atelier';

/*
 * One rule, four surfaces (the fifth, PromptPicker + its axis sheet, is covered
 * in PromptPicker/index.test.tsx alongside its own nesting cases).
 *
 * A tap fires pointerdown BEFORE click. A sheet that dismisses on pointerdown
 * unmounts its backdrop mid-tap, and WebKit then dispatches the click on
 * whatever is under the finger — so the tap bleeds into the layer below,
 * closing a parent sheet or hitting a tile. Every surface that renders its own
 * backdrop therefore disables `useOutsidePointer` in that mode and dismisses
 * from the backdrop's CLICK.
 *
 * These assert the EXIT, not the parent's `onClose` callback: the shared
 * `useExitTransition` defers `onClose` past the exit animation, so a wrongly
 * started exit would still leave `onClose` uncalled at a synchronous assertion.
 * `data-closing` is stamped the moment `requestClose` fires, which is the thing
 * a pointerdown must not do.
 */

const originalMatchMedia = window.matchMedia.bind(window);

function installPhoneMatchMedia(): void {
  window.matchMedia = mock((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
    addListener: mock(() => undefined),
    removeListener: mock(() => undefined),
    dispatchEvent: mock(() => true),
  }));
}

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

/** pointerdown must be inert; the completed click must start the exit. */
function expectClickOnlyDismissal(backdrop: HTMLElement): void {
  fireEvent.pointerDown(backdrop);
  expect(backdrop.getAttribute('data-closing')).toBeNull();

  fireEvent.click(backdrop);
  expect(backdrop.getAttribute('data-closing')).toBe('true');
}

describe('phone sheets dismiss on a completed backdrop tap, never on pointerdown', () => {
  test('batch overflow menu', () => {
    installPhoneMatchMedia();
    const anchorRef = createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={anchorRef}>anchor</button>
        <BatchOverflowMenu
          batch={allDoneBatch}
          anchorRef={anchorRef}
          open
          promptsEnabled
          readOnlyActions={false}
          onSelect={mock(() => undefined)}
          onClose={mock(() => undefined)}
        />
      </>,
    );

    const backdrop = screen.getByRole('button', { name: 'Close menu' });
    expectClickOnlyDismissal(backdrop);
  });

  test('move popover', () => {
    installPhoneMatchMedia();
    const anchorRef = createRef<HTMLButtonElement>();
    render(
      <>
        <button ref={anchorRef}>anchor</button>
        <MovePopover
          batch={allDoneBatch}
          anchorRef={anchorRef}
          open
          view={APP_VIEW_UNSORTED}
          q=""
          onClose={mock(() => undefined)}
        />
      </>,
      { wrapper: wrapper(newClient()) },
    );

    const backdrop = screen.getByRole('button', { name: 'Close move popover' });
    expectClickOnlyDismissal(backdrop);
  });

  // HelpPanel closes straight through onClose (no exit choreography), so the
  // observable difference is whether the panel is still mounted.
  test('prompt library help panel', () => {
    installPhoneMatchMedia();
    const onClose = mock(() => undefined);
    render(<HelpPanel open panelId="help-panel" onClose={onClose} />);

    // Backdrop first, panel close button second — both are labelled "Close help".
    const backdrop = screen.getAllByRole('button', { name: 'Close help' })[0];
    if (!backdrop) throw new Error('no backdrop');
    fireEvent.pointerDown(backdrop);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });
});
