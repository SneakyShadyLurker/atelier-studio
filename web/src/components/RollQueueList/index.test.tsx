import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { useRef, type PropsWithChildren } from 'react';
import { createPortal } from 'react-dom';
import Toast from '../Toast';
import { deleteBatch } from '../../api/history';
import { useDeleteUpload } from '../../hooks/useDeleteUpload';
import { useModalChrome } from '../../hooks/useModalChrome';
import { initialAtelierState, useAtelierStore, workHeldUploadIds } from '../../store/atelier';
import type { QueuedRoll, RollSubmission } from '../../store/atelier';
import RollQueueList from './index';

// The PromptPicker wiring: the queue lives in a body-portalled panel that is
// the registered toast host, and unmounts as soon as the queue is empty.
function PickerPanel() {
  const portalRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const queue = useAtelierStore((state) => state.draft.rollQueue);
  const clearRollQueue = useAtelierStore((state) => state.clearRollQueue);
  useModalChrome({ open: true, onCancel: () => undefined, portalRef, toastHostRef: panelRef });
  return createPortal(
    <div ref={portalRef}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Templates">
        {queue.length > 0 ? (
          <RollQueueList rolls={queue} onRemove={mock()} onReorder={mock()} onClear={clearRollQueue} variant="panel" />
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

const rolls: readonly QueuedRoll[] = [
  { id: 'a', text: 'first queued prompt', seed: 11, source: 'template' },
  { id: 'b', text: 'second queued prompt', seed: 22, source: 'template' },
];

beforeEach(() => {
  useAtelierStore.setState(initialAtelierState, true);
});

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

describe('RollQueueList', () => {
  test('renders queue rows with seeds and removes a row', () => {
    const onRemove = mock();
    render(
      <RollQueueList
        rolls={rolls}
        onRemove={onRemove}
        onReorder={mock()}
        onClear={mock()}
        variant="inline"
      />,
    );

    const region = screen.getByRole('region', { name: /roll-queue/i });
    expect(within(region).getByText('first queued prompt')).toBeTruthy();
    expect(within(region).getByText('Seed 11')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: /remove queued roll · first queued prompt/i }));
    expect(onRemove).toHaveBeenCalledWith('a');
  });

  test('Alt+ArrowDown reorders rows by index', () => {
    const onReorder = mock();
    render(
      <RollQueueList
        rolls={rolls}
        onRemove={mock()}
        onReorder={onReorder}
        onClear={mock()}
        variant="panel"
      />,
    );

    const firstRow = screen.getAllByRole('listitem')[0];
    expect(firstRow).toBeDefined();
    if (!firstRow) return;
    firstRow.focus();
    fireEvent.keyDown(firstRow, { key: 'ArrowDown', altKey: true });
    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });

  test('clear snapshots the queue, shows Undo, and restores from the toast action', () => {
    useAtelierStore.setState((state) => ({ ...state, draft: { ...state.draft, rollQueue: rolls } }));
    const onClear = () => { useAtelierStore.getState().clearRollQueue(); };
    render(
      <>
        <RollQueueList
          rolls={useAtelierStore.getState().draft.rollQueue}
          onRemove={mock()}
          onReorder={mock()}
          onClear={onClear}
          variant="inline"
        />
        <Toast />
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
    useAtelierStore.getState().stashRoll({ id: 'c', text: 'new queued prompt', seed: 33, source: 'template' });
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(useAtelierStore.getState().draft.rollQueue.map((roll) => roll.id)).toEqual(['a', 'b', 'c']);
  });

  test('inside a modal panel, Undo renders in the panel and outlives the emptied queue', () => {
    useAtelierStore.setState((state) => ({ ...state, draft: { ...state.draft, rollQueue: rolls } }));
    render(
      <>
        <Toast />
        <PickerPanel />
      </>,
    );
    const panel = screen.getByRole('dialog', { name: 'Templates' });

    fireEvent.click(within(panel).getByRole('button', { name: /^clear$/i }));
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
    expect(within(panel).queryByRole('region')).toBeNull();

    const undo = within(panel).getByRole('button', { name: 'Undo' });
    act(() => { useAtelierStore.getState().stashRoll({ id: 'c', text: 'new queued prompt', seed: 33, source: 'template' }); });
    fireEvent.click(undo);
    expect(useAtelierStore.getState().draft.rollQueue.map((roll) => roll.id)).toEqual(['a', 'b', 'c']);
  });

  test('announces the queued count through a polite status region', () => {
    render(
      <RollQueueList
        rolls={rolls}
        onRemove={mock()}
        onReorder={mock()}
        onClear={mock()}
        variant="inline"
      />,
    );

    expect(screen.getByRole('status').textContent).toBe('2 rolls queued');
  });
});

describe('Clear holds the cleared rolls\' media while Undo is offered', () => {
  const originalFetch = globalThis.fetch;
  const sent: { method: string | undefined; url: string }[] = [];

  const refSubmission = (refImageIds: string[]): RollSubmission => ({
    request: { modelId: 'model-a', ratio: '1:1', count: 1, refImageIds },
    lockedSeed: null,
    wantsMotion: false,
    motionFields: {},
  });
  const refRolls: readonly QueuedRoll[] = [
    { id: 'r1', text: 'first ref roll', seed: 1, source: 'composer', submission: refSubmission(['up-ref-1']) },
    { id: 'r2', text: 'second ref roll', seed: 2, source: 'composer', submission: refSubmission(['up-ref-2']) },
  ];

  const uploadDeletes = () => sent.filter((request) => request.method === 'DELETE' && request.url.includes('/uploads/'));
  const keepUploadsOf = (url: string) => new URL(url, 'http://localhost').searchParams.get('keepUploads')?.split(',') ?? [];

  beforeEach(() => {
    sent.length = 0;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      sent.push({ method: init?.method, url });
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function renderClearable() {
    useAtelierStore.setState((state) => ({
      ...state,
      draft: {
        ...state.draft,
        rollQueue: refRolls,
        // The composer still shows the first roll's chip when Clear is pressed.
        refImages: [{ clientId: 'chip-1', serverId: 'up-ref-1', status: 'ready', mime: 'image/png', sizeBytes: 1, previewUrl: '' }],
      },
    }));
    render(
      <>
        <RollQueueList
          rolls={useAtelierStore.getState().draft.rollQueue}
          onRemove={mock()}
          onReorder={mock()}
          onClear={() => { useAtelierStore.getState().clearRollQueue(); }}
          variant="inline"
        />
        <Toast />
      </>,
    );
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return renderHook(() => useDeleteUpload(), { wrapper }).result;
  }

  function clearedToast() {
    const toast = useAtelierStore.getState().toasts.find((entry) => entry.text === 'Queue cleared');
    if (!toast) throw new Error('Queue cleared toast missing');
    return toast;
  }

  // Chip removed from the composer and the origin batch deleted while Undo is
  // on screen: the snapshot's uploads must survive both.
  async function loseEveryOtherReference(deleteUpload: ReturnType<typeof renderClearable>): Promise<void> {
    useAtelierStore.getState().clearRefImages();
    await deleteBatch('origin');
    const originDelete = sent[sent.length - 1];
    expect(originDelete?.url).toContain('/history/origin');
    expect(keepUploadsOf(originDelete?.url ?? '')).toContain('up-ref-1');
    expect(keepUploadsOf(originDelete?.url ?? '')).toContain('up-ref-2');

    let outcome: unknown;
    await act(async () => { outcome = await deleteUpload.current.mutateAsync('up-ref-2'); });
    expect(outcome).toEqual({ referenced: true });
  }

  test('a paused Undo toast keeps the hold until its onDismiss runs, then releases without deleting media', async () => {
    const deleteUpload = renderClearable();

    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
    expect(workHeldUploadIds().has('up-ref-1')).toBe(true);
    expect(workHeldUploadIds().has('up-ref-2')).toBe(true);

    await loseEveryOtherReference(deleteUpload);

    // Hovering/focusing the toast pauses its lifetime; the hold is not on a
    // clock of its own, so it stays for as long as Undo is reachable.
    fireEvent.focus(screen.getByRole('button', { name: 'Undo' }));
    expect(workHeldUploadIds().has('up-ref-1')).toBe(true);
    expect(workHeldUploadIds().has('up-ref-2')).toBe(true);

    // Leaving the toast runs the same onDismiss as its expiry.
    act(() => { useAtelierStore.getState().removeToast(clearedToast().id); });
    expect(workHeldUploadIds().has('up-ref-1')).toBe(false);
    expect(workHeldUploadIds().has('up-ref-2')).toBe(false);

    // Releasing a hold only stops protecting the media; nothing deletes it.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(uploadDeletes()).toEqual([]);
  });

  test('Undo restores the snapshot whose media the queue then holds again', async () => {
    const deleteUpload = renderClearable();

    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    await loseEveryOtherReference(deleteUpload);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(useAtelierStore.getState().draft.rollQueue.map((roll) => roll.id)).toEqual(['r1', 'r2']);

    act(() => { useAtelierStore.getState().removeToast(clearedToast().id); });
    expect(workHeldUploadIds().has('up-ref-1')).toBe(true);
    expect(workHeldUploadIds().has('up-ref-2')).toBe(true);

    let outcome: unknown;
    await act(async () => { outcome = await deleteUpload.current.mutateAsync('up-ref-1'); });
    expect(outcome).toEqual({ referenced: true });
    expect(uploadDeletes()).toEqual([]);
  });
});
