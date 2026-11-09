import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useState, type ReactNode } from 'react';
import { allDoneBatch } from '../../../test/fixtures/batches';
import { useAtelierStore } from '../../store/atelier';
import MovePopover from './index';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  mock.restore();
  useAtelierStore.setState({ toasts: [] });
});

async function pendingCreate(stage: 'create' | 'move', keyboardButton = false) {
  const writes: { method: string; body: unknown }[] = [];
  let resolve!: (response: Response) => void;
  const collection = { id: 'created-one', name: 'Draft', count: 0, archivedCount: 0, createdAt: 1 };
  globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') return Promise.resolve(Response.json({
      items: [{ ...collection, id: 'other', name: 'Other collection' }],
      summary: { totalCount: 1, pinnedCount: 0, unsortedCount: 1, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
    }));
    writes.push({ method, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as unknown });
    if ((stage === 'create' && method === 'POST') || (stage === 'move' && method === 'PATCH')) {
      return new Promise<Response>((release) => { resolve = release; });
    }
    return Promise.resolve(Response.json(method === 'POST' ? collection : { ...allDoneBatch, collectionId: collection.id }));
  }) as unknown as typeof fetch;
  const anchorRef = createRef<HTMLButtonElement>();
  const onClose = mock();
  function Host() {
    const [open, setOpen] = useState(true);
    return <>
      <button ref={anchorRef} type="button" onClick={() => { setOpen(true); }}>anchor</button>
      {open && <MovePopover batch={allDoneBatch} anchorRef={anchorRef} open view={{ kind: 'unsorted' }} q=""
        onClose={() => { onClose(); setOpen(false); }} />}
    </>;
  }
  const rendered = render(<Host />, { wrapper });
  await screen.findByRole('button', { name: 'Other collection' });
  fireEvent.click(screen.getByRole('button', { name: 'New collection' }));
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Collection name' });
  fireEvent.change(input, { target: { value: 'Draft' } });
  const move = screen.getByRole<HTMLButtonElement>('button', { name: 'Move' });
  if (keyboardButton) {
    act(() => { move.focus(); });
    fireEvent.click(move);
    // happy-dom refuses to blur a disabled control. Model the browser's body
    // focus transfer, then deliver that control's native focusout explicitly.
    act(() => { document.body.focus(); });
    fireEvent.blur(move, { relatedTarget: null });
  } else fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => { expect(writes).toHaveLength(stage === 'create' ? 1 : 2); expect(input.readOnly).toBe(true); });
  return { ...rendered, input, move, writes, onClose, collection, release: (success = false) => {
    resolve(success ? Response.json(stage === 'create' ? collection : { ...allDoneBatch, collectionId: collection.id })
      : Response.json({ error: `${stage} refused` }, { status: 400 }));
  } };
}

describe('MovePopover pending ownership', () => {
  for (const stage of ['create', 'move'] as const) {
    for (const leave of ['focus', 'pointer', 'Escape', 'close'] as const) {
      test.each([false, true])(`${stage} settles after ${leave}, success=%s, without reviving the draft`, async (success) => {
        const pending = await pendingCreate(stage);
        const other = screen.getByRole('button', { name: 'Other collection' });
        if (leave === 'focus') act(() => { other.focus(); });
        if (leave === 'pointer') {
          fireEvent.pointerDown(other);
          act(() => { other.focus(); });
        }
        if (leave === 'Escape') {
          for (const event of [{ isComposing: true }, { keyCode: 229 }]) {
            fireEvent.keyDown(pending.input, { key: 'Escape', ...event });
            expect(pending.input.isConnected).toBe(true);
          }
          fireEvent.keyDown(pending.input, { key: 'Escape' });
        }
        if (leave === 'close') {
          fireEvent.pointerDown(document.body);
          await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
          expect(screen.queryByRole('dialog') === null).toBe(true);
        } else {
          await waitFor(() => { expect(screen.queryByRole('textbox') === null).toBe(true); });
          await waitFor(() => { expect(document.activeElement === (leave === 'Escape' ? screen.getByRole('button', { name: 'New collection' }) : other)).toBe(true); });
          if (leave === 'Escape') {
            const create = screen.getByRole('button', { name: 'New collection' });
            expect(create.getAttribute('aria-disabled')).toBe('true');
            expect(create.getAttribute('aria-busy')).toBe('true');
            fireEvent.click(create);
            expect(screen.queryByRole('textbox')).toBeNull();
          }
        }
        const focus = document.activeElement;
        await act(async () => { pending.release(success); await Promise.resolve(); });
        await waitFor(() => {
          if (!success) expect(useAtelierStore.getState().toasts.some((toast) => toast.text === `${stage} refused`)).toBe(true);
          expect(pending.writes).toHaveLength(stage === 'create' && !success ? 1 : 2);
        });
        expect(screen.queryByRole('textbox') === null).toBe(true);
        expect(document.activeElement === focus).toBe(true);
        expect(pending.onClose).toHaveBeenCalledTimes(leave === 'close' ? 1 : 0);
        if (leave === 'Escape') {
          await waitFor(() => { expect(screen.getByRole('button', { name: 'New collection' }).getAttribute('aria-disabled')).toBe('false'); });
          fireEvent.keyDown(screen.getByRole('button', { name: 'New collection' }), { key: 'Escape' });
          await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
          expect(screen.queryByRole('dialog') === null).toBe(true);
        }
      });
    }

    test(`${stage} draft survives a cancelled pointer gesture before and after failure`, async () => {
      const pending = await pendingCreate(stage);
      const other = screen.getByRole('button', { name: 'Other collection' });
      for (const settled of [false, true]) {
        if (settled) {
          await act(async () => { pending.release(); await Promise.resolve(); });
          await waitFor(() => { expect(pending.input.readOnly).toBe(false); });
        }
        fireEvent.pointerDown(other, { pointerType: 'touch', pointerId: 1 });
        fireEvent.pointerCancel(other, { pointerType: 'touch', pointerId: 1 });
        expect(pending.input.isConnected).toBe(true);
        expect(pending.input.value).toBe('Draft');
        expect(pending.onClose).not.toHaveBeenCalled();
      }
    });

    test.each(['button', 'input'] as const)(`${stage} failure preserves a pending submission when %s loses focus to body`, async (origin) => {
      const pending = await pendingCreate(stage, origin === 'button');
      if (origin === 'input') {
        fireEvent.pointerDown(pending.move);
        act(() => { document.body.focus(); });
        fireEvent.blur(pending.input, { relatedTarget: null });
      }
      expect(document.activeElement === document.body).toBe(true);
      expect(pending.input.isConnected).toBe(true);
      fireEvent.keyDown(pending.input, { key: 'Enter' });
      fireEvent.click(pending.move);
      expect(pending.writes).toHaveLength(stage === 'create' ? 1 : 2);
      await act(async () => { pending.release(); await Promise.resolve(); });
      await waitFor(() => {
        expect(pending.input.readOnly).toBe(false);
        expect(document.activeElement === pending.input).toBe(true);
        expect(pending.input.value).toBe('Draft');
      });
    });

    test(`${stage} failure cannot replace a newer rename context`, async () => {
      const pending = await pendingCreate(stage);
      const other = screen.getByRole('button', { name: 'Other collection' });
      act(() => { other.focus(); });
      fireEvent.doubleClick(other);
      const rename = screen.getByRole<HTMLInputElement>('textbox', { name: 'Rename collection' });
      fireEvent.change(rename, { target: { value: 'Newer draft' } });
      await act(async () => { pending.release(); await Promise.resolve(); });
      await waitFor(() => { expect(useAtelierStore.getState().toasts.some((toast) => toast.text === `${stage} refused`)).toBe(true); });
      expect(rename.value).toBe('Newer draft');
      expect(document.activeElement === rename).toBe(true);
      expect(screen.queryByRole('textbox', { name: 'Collection name' })).toBeNull();
    });
  }

  test('unmount and a fresh session cannot reuse an old created identity', async () => {
    const pending = await pendingCreate('move');
    pending.unmount();
    await act(async () => { pending.release(); await Promise.resolve(); });
    const fresh = await pendingCreate('create');
    expect(fresh.writes).toEqual([{ method: 'POST', body: { name: 'Draft' } }]);
    await act(async () => { fresh.release(); await Promise.resolve(); });
    await waitFor(() => { expect(fresh.input.readOnly).toBe(false); });
  });
});

describe('MovePopover focus after a move out of the scope', () => {
  test('creating a collection and moving the batch into it hands focus to the next row', async () => {
    const collection = { id: 'created-one', name: 'Draft', count: 0, archivedCount: 0, createdAt: 1 };
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Promise.resolve(Response.json({
        items: [],
        summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
      }));
      return Promise.resolve(Response.json(method === 'POST' ? collection : { ...allDoneBatch, collectionId: collection.id }));
    }) as unknown as typeof fetch;
    const anchorRef = createRef<HTMLButtonElement>();
    function Host() {
      const [open, setOpen] = useState(true);
      return <>
        <div data-batch-id={allDoneBatch.id}>
          <button ref={anchorRef} type="button">anchor</button>
          {open && <MovePopover batch={allDoneBatch} anchorRef={anchorRef} open view={{ kind: 'unsorted' }} q=""
            onClose={() => { setOpen(false); }} />}
        </div>
        <div data-batch-id="next-row"><button type="button">next row</button></div>
      </>;
    }
    render(<Host />, { wrapper });
    await screen.findByRole('button', { name: 'New collection' });
    fireEvent.click(screen.getByRole('button', { name: 'New collection' }));
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Collection name' });
    fireEvent.change(input, { target: { value: 'Draft' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const next = document.querySelector<HTMLButtonElement>('[data-batch-id="next-row"] button');
    // The create and move writes settle, then the exit fade (--dur-overlay,
    // 160ms fallback) runs out and the popover unmounts (timer-driven: sleep,
    // not waitFor).
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement === next).toBe(true);
  });

  test('a popover dismissed while the collection is created still hands focus on when the move removes its row', async () => {
    const collection = { id: 'created-one', name: 'Draft', count: 0, archivedCount: 0, createdAt: 1 };
    let releaseCreate!: (response: Response) => void;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Promise.resolve(Response.json({
        items: [],
        summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
      }));
      if (method === 'POST') return new Promise<Response>((release) => { releaseCreate = release; });
      return Promise.resolve(Response.json({ ...allDoneBatch, collectionId: collection.id }));
    }) as unknown as typeof fetch;
    const anchorRef = createRef<HTMLButtonElement>();
    function Host() {
      const [open, setOpen] = useState(true);
      return <>
        <div data-batch-id={allDoneBatch.id}>
          <button ref={anchorRef} type="button">anchor</button>
          {open && <MovePopover batch={allDoneBatch} anchorRef={anchorRef} open view={{ kind: 'unsorted' }} q=""
            onClose={() => { setOpen(false); }} />}
        </div>
        <div data-batch-id="next-row"><button type="button">next row</button></div>
      </>;
    }
    render(<Host />, { wrapper });
    await screen.findByRole('button', { name: 'New collection' });
    fireEvent.click(screen.getByRole('button', { name: 'New collection' }));
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Collection name' });
    fireEvent.change(input, { target: { value: 'Draft' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => { expect(input.readOnly).toBe(true); });
    // Dismiss while the POST is pending: the close restores focus to the trigger.
    fireEvent.pointerDown(document.body);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement === anchorRef.current).toBe(true);
    // The chain goes on: the collection exists, the move follows and removes the row.
    await act(async () => { releaseCreate(Response.json(collection)); await new Promise((resolve) => setTimeout(resolve, 50)); });
    const next = document.querySelector<HTMLButtonElement>('[data-batch-id="next-row"] button');
    expect(document.activeElement === next).toBe(true);
  });

  test('a Move popover reopened on the row while its collection is still being created hands focus on when the move removes the row', async () => {
    const collection = { id: 'created-one', name: 'Draft', count: 0, archivedCount: 0, createdAt: 1 };
    let releaseCreate!: (response: Response) => void;
    let removeRow: () => void = () => undefined;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Promise.resolve(Response.json({
        items: [],
        summary: { totalCount: 0, pinnedCount: 0, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
      }));
      if (method === 'POST') return new Promise<Response>((release) => { releaseCreate = release; });
      // The optimistic move removes the row (and the popover anchored to it).
      removeRow();
      return Promise.resolve(Response.json({ ...allDoneBatch, collectionId: collection.id }));
    }) as unknown as typeof fetch;
    const anchorRef = createRef<HTMLButtonElement>();
    function Host() {
      const [open, setOpen] = useState(true);
      const [present, setPresent] = useState(true);
      removeRow = () => { setPresent(false); };
      return <>
        {present && <div data-batch-id={allDoneBatch.id}>
          <button ref={anchorRef} type="button" onClick={() => { setOpen(true); }}>anchor</button>
          {open && <MovePopover batch={allDoneBatch} anchorRef={anchorRef} open view={{ kind: 'unsorted' }} q=""
            onClose={() => { setOpen(false); }} />}
        </div>}
        <div data-batch-id="next-row"><button type="button">next row</button></div>
      </>;
    }
    render(<Host />, { wrapper });
    await screen.findByRole('button', { name: 'New collection' });
    fireEvent.click(screen.getByRole('button', { name: 'New collection' }));
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Collection name' });
    fireEvent.change(input, { target: { value: 'Draft' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => { expect(input.readOnly).toBe(true); });
    fireEvent.pointerDown(document.body);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // Reopen Move on the same row while the POST is still pending.
    fireEvent.click(screen.getByRole('button', { name: 'anchor' }));
    await screen.findByRole('dialog');
    await act(async () => { await Promise.resolve(); });
    expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
    await act(async () => { releaseCreate(Response.json(collection)); await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(document.querySelector(`[data-batch-id="${allDoneBatch.id}"]`)).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const next = document.querySelector<HTMLButtonElement>('[data-batch-id="next-row"] button');
    expect(document.activeElement === next).toBe(true);
  });

  test('a move that only removes the collection chip (Pinned → Unsorted) restores focus to the row\'s Move button, not the next row', async () => {
    let removeChip: () => void = () => undefined;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Promise.resolve(Response.json({
        items: [{ id: 'collection-1', name: 'Other collection', count: 1, archivedCount: 0, createdAt: 1 }],
        summary: { totalCount: 1, pinnedCount: 1, unsortedCount: 0, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 },
      }));
      removeChip();
      return Promise.resolve(Response.json({ ...allDoneBatch, pinned: true, collectionId: null }));
    }) as unknown as typeof fetch;
    const anchorRef = createRef<HTMLButtonElement>();
    const moveBtnRef = createRef<HTMLButtonElement>();
    function Host() {
      const [open, setOpen] = useState(true);
      const [chip, setChip] = useState(true);
      removeChip = () => { setChip(false); };
      return <>
        <div data-batch-id={allDoneBatch.id}>
          <button ref={moveBtnRef} type="button">Move to collection</button>
          {chip && <button ref={anchorRef} type="button">Other collection, move to collection</button>}
          {open && <MovePopover batch={{ ...allDoneBatch, pinned: true, collectionId: 'collection-1' }} anchorRef={anchorRef}
            returnFocusFallbackRef={moveBtnRef} open view={{ kind: 'pinned' }} q="" onClose={() => { setOpen(false); }} />}
        </div>
        <div data-batch-id="next-row"><button type="button">next row</button></div>
      </>;
    }
    render(<Host />, { wrapper });
    const unsorted = await screen.findByRole('button', { name: '(Unsorted)' });
    // Keyboard activation (detail 0) moves at once.
    fireEvent.click(unsorted);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(anchorRef.current).toBeNull();
    expect(document.querySelector(`[data-batch-id="${allDoneBatch.id}"]`)).not.toBeNull();
    expect(document.activeElement === moveBtnRef.current).toBe(true);
  });
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('MovePopover closing', () => {
  test('Escape then Enter on the focused Unsorted row does not move the batch', async () => {
    const writes: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (method !== 'GET') writes.push(`${method} ${url}`);
      return Promise.resolve(Response.json({
        items: [],
        summary: {
          totalCount: 0,
          pinnedCount: 0,
          unsortedCount: 0,
          archivedTotalCount: 0,
          archivedPinnedCount: 0,
          archivedUnsortedCount: 0,
        },
      }));
    }) as unknown as typeof fetch;
    const anchorRef = createRef<HTMLButtonElement>();
    const onClose = mock(() => undefined);
    render(
      <>
        <button ref={anchorRef} type="button">anchor</button>
        <MovePopover
          batch={{ ...allDoneBatch, collectionId: 'collection-1' }}
          anchorRef={anchorRef}
          open
          view={{ kind: 'unsorted' }}
          q=""
          onClose={onClose}
        />
      </>,
      { wrapper },
    );

    const unsorted = screen.getByRole('button', { name: '(Unsorted)' });
    unsorted.focus();
    fireEvent.keyDown(unsorted, { key: 'Escape' });
    fireEvent.click(unsorted);
    fireEvent.click(screen.getByRole('button', { name: 'New collection' }));

    expect(screen.queryByRole('textbox', { name: 'Collection name' })).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });
});
