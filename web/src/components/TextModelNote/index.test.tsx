import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState, type ReactNode } from 'react';
import TextModelNote from './index';

const realFetch = globalThis.fetch;
const realMatchMedia = window.matchMedia.bind(window);

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.matchMedia = realMatchMedia;
});

type Respond = () => Promise<Response>;

/** `/text-providers` decides admin; `/text-models` is irrelevant to the note. */
function serveProviders(respond: Respond): void {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/text-providers')) return respond();
    return new Promise<Response>(() => undefined);
  }) as unknown as typeof fetch;
}

const asAdmin: Respond = () => Promise.resolve(Response.json({ providers: [] }));
const asMember: Respond = () => Promise.resolve(new Response('not found', { status: 404 }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function Host({ navigate = () => undefined, onClose = () => undefined }: { navigate?: () => void; onClose?: () => void }) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchorRef} type="button" onClick={() => { setOpen(true); }}>Enhance</button>
      {open && (
        <TextModelNote
          open
          action="Enhance"
          anchorRef={anchorRef}
          escape="top-level"
          navigateToTextModels={navigate}
          onClose={() => { onClose(); setOpen(false); }}
        />
      )}
    </>
  );
}

function openNote(): HTMLElement {
  const anchor = screen.getByRole('button', { name: 'Enhance' });
  anchor.focus();
  fireEvent.click(anchor);
  return anchor;
}

const settleExit = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });

describe('TextModelNote', () => {
  test('admins get "Set up text models", which closes the note and navigates', async () => {
    serveProviders(asAdmin);
    const navigate = mock(() => undefined);
    const onClose = mock(() => undefined);
    render(<Host navigate={navigate} onClose={onClose} />, { wrapper });
    openNote();
    const note = screen.getByRole('dialog', { name: 'Enhance needs a text model.' });
    const setUp = await screen.findByRole('button', { name: 'Set up text models' });
    expect(note.contains(setUp)).toBe(true);
    expect(note.getAttribute('data-anchor-place')).toBe('below-start');
    fireEvent.click(setUp);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test('non-admins are told to ask their admin', async () => {
    serveProviders(asMember);
    render(<Host />, { wrapper });
    openNote();
    await screen.findByText('Ask your admin to connect a text model.');
    expect(screen.queryByRole('button', { name: 'Set up text models' })).toBeNull();
  });

  test('a non-admin note keeps focus inside on a Close button that plays the exit', async () => {
    serveProviders(asMember);
    const onClose = mock(() => undefined);
    render(<Host onClose={onClose} />, { wrapper });
    openNote();
    const note = screen.getByRole('dialog');
    const close = await screen.findByRole('button', { name: 'Close' });
    expect(note.contains(close)).toBe(true);
    await waitFor(() => { expect(document.activeElement === close).toBe(true); });
    fireEvent.click(close);
    expect(note.getAttribute('data-closing')).toBe('true');
    await settleExit();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('an unknown admin reads as non-admin, then upgrades when the probe settles', async () => {
    let settle: (response: Response) => void = () => undefined;
    serveProviders(() => new Promise<Response>((resolve) => { settle = resolve; }));
    render(<Host />, { wrapper });
    openNote();
    expect(screen.getByText('Ask your admin to connect a text model.')).toBeTruthy();
    await act(async () => { settle(Response.json({ providers: [] })); await Promise.resolve(); });
    await screen.findByRole('button', { name: 'Set up text models' });
    expect(screen.queryByText('Ask your admin to connect a text model.')).toBeNull();
  });

  test('Escape closes only the note through its exit and returns focus to the anchor', async () => {
    serveProviders(asMember);
    const onClose = mock(() => undefined);
    render(<Host onClose={onClose} />, { wrapper });
    const anchor = openNote();
    const note = screen.getByRole('dialog');
    await waitFor(() => { expect(note.contains(document.activeElement)).toBe(true); });
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' });
    expect(note.getAttribute('data-closing')).toBe('true');
    expect(onClose).not.toHaveBeenCalled();
    await settleExit();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => { expect(document.activeElement === anchor).toBe(true); });
  });

  test('phone renders a sheet with a backdrop that dismisses on click, not pointerdown', () => {
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
    serveProviders(asMember);
    render(<Host />, { wrapper });
    openNote();
    const note = screen.getByRole('dialog');
    expect(note.getAttribute('data-mobile')).toBe('true');
    expect(note.hasAttribute('data-anchor-place')).toBe(false);
    const backdrop = screen.getByRole('button', { name: 'Close note' });
    fireEvent.pointerDown(backdrop);
    expect(note.getAttribute('data-closing')).toBeNull();
    fireEvent.click(backdrop);
    expect(note.getAttribute('data-closing')).toBe('true');
  });
});
