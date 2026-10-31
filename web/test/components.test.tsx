import { afterEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import App from '../src/App';
import BatchView from '../src/components/Batch';
import Canvas from '../src/components/Canvas';
import Composer from '../src/components/Composer';
import Lightbox from '../src/components/Lightbox';
import Sidebar from '../src/components/Sidebar';
import Toast from '../src/components/Toast';
import { fixtureBatches, historyFixture } from './fixtures/batches';
import { fixtureModels } from './fixtures/models';
import { flushQueryNotifications } from './fixtures/queryNotifications';
import { collectionKeys } from '../src/api/collections';
import { APP_VIEW_PINNED, APP_VIEW_UNSORTED, toGenerateRequest, useAtelierStore } from '../src/store/atelier';

const originalMatchMedia = window.matchMedia.bind(window);
const fixtureModelById = new Map(fixtureModels.map((model) => [model.id, model]));

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  window.matchMedia = originalMatchMedia;
  mock.restore();
  useAtelierStore.getState().clearRefImages();
  useAtelierStore.setState({
    draft: { prompt: '', modelId: '', ratio: '1:1', durationFrames: null, count: 2, refImages: [], rollQueue: [] },
    view: APP_VIEW_UNSORTED,
    q: '',
    activeBatchId: null,
    sidebarOpen: false,
    lightbox: null,
    toasts: [],
  });
});

function installMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media: MediaQueryList = {
    get matches() { return matches; },
    media: '(width < 768px)',
    onchange: null,
    addEventListener: mock((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'change' && typeof listener === 'function') listeners.add(listener);
    }),
    removeEventListener: mock((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'change' && typeof listener === 'function') listeners.delete(listener);
    }),
    addListener: mock((listener: (event: MediaQueryListEvent) => void) => { listeners.add(listener); }),
    removeListener: mock((listener: (event: MediaQueryListEvent) => void) => { listeners.delete(listener); }),
    dispatchEvent: mock(() => true),
  };
  window.matchMedia = mock((query: string) => {
    if (query === '(width < 768px)') return media;
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: mock(() => undefined),
      removeEventListener: mock(() => undefined),
      addListener: mock(() => undefined),
      removeListener: mock(() => undefined),
      dispatchEvent: mock(() => true),
    };
  });

  return {
    setMatches(next: boolean) {
      matches = next;
      const event = Object.assign(new Event('change'), { matches, media: media.media });
      for (const listener of listeners) listener(event);
    },
  };
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`Missing fixture: ${label}`);
  return value;
}

function withQueryClient(node: ReactNode, archivedTotalCount = 0) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(collectionKeys.list(), { items: [], summary: { totalCount: historyFixture.items.length, pinnedCount: 0, unsortedCount: historyFixture.items.length, archivedTotalCount, archivedPinnedCount: 0, archivedUnsortedCount: 0 } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function file(name = 'ref.png', type = 'image/png') {
  return new File(['image-bytes'], name, { type });
}

function uploadResponse(id = '019e11fd-b3b5-7bb8-b0bf-f8327c748925') {
  return Response.json({
    id,
    mime: 'image/png',
    ext: 'png',
    sizeBytes: 11,
    width: 1,
    height: 1,
    createdAt: 123,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function mockAppFetch(archivedTotalCount = 0, collectionArchivedTotalCount = archivedTotalCount) {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.endsWith('/models')) return Response.json(fixtureModels);
    if (url.endsWith('/collections')) return Response.json({ items: [], summary: { totalCount: historyFixture.items.length, pinnedCount: 0, unsortedCount: historyFixture.items.length, archivedTotalCount: collectionArchivedTotalCount, archivedPinnedCount: 0, archivedUnsortedCount: 0 } });
    if (url.includes('/history')) return Response.json(historyFixture);
    if (url.includes('/archive')) return Response.json({ items: [], nextCursor: null, total: archivedTotalCount });
    return Response.json({});
  }) as unknown as typeof fetch;
}

async function renderAppForDrawer(isPhone: boolean) {
  installMatchMedia(isPhone);
  mockAppFetch();
  const rendered = render(withQueryClient(<App />));
  await waitFor(() => { expect(screen.getAllByText(fixtureBatches[0]?.prompt ?? '').length).toBeGreaterThan(0); });
  return rendered;
}

describe('visual scaffold components', () => {
  test('Sidebar renders fixture history and selects a batch', () => {
    const onSelect = mock();
    useAtelierStore.setState({ view: APP_VIEW_UNSORTED });
    render(withQueryClient(
      <Sidebar
        history={historyFixture}
        models={fixtureModels}
        activeBatchId={fixtureBatches[0]?.id ?? null}
        historyQ=""
        archivedCount={0}
        onSelect={onSelect}
        onSelectView={() => undefined}
        onClear={() => undefined}
      />,
    ));

    expect(screen.getByText('Atelier')).toBeTruthy();
    const secondBatch = requireValue(fixtureBatches[1], 'second batch');
    const row = screen.getByRole('button', { name: `Open batch: ${secondBatch.prompt.slice(0, 80)}` });
    expect(row.tagName).toBe('BUTTON');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(secondBatch.id);
  });

  test('Canvas renders empty state and fixture batches', () => {
    const noop = () => undefined;
    const { rerender } = render(withQueryClient(
      <Canvas
        batches={[]}
        modelById={fixtureModelById}
        collections={[]}
        activeView={APP_VIEW_UNSORTED}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
        onBatchAction={noop}
        promptsEnabled={false}
        onTileAction={noop}
        onOpenTile={noop}
        q=""
      />,
    ));
    expect(screen.getByText('What would you like to make?')).toBeTruthy();

    rerender(
      withQueryClient(<Canvas
        batches={fixtureBatches}
        modelById={fixtureModelById}
        collections={[]}
        activeView={APP_VIEW_UNSORTED}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
        onBatchAction={noop}
        promptsEnabled={false}
        onTileAction={noop}
        onOpenTile={noop}
        q=""
      />),
    );
    expect(screen.getAllByRole('img', { name: /generated image/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Generation failed').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/s$/).length).toBeGreaterThan(0);
  });

  test('Canvas virtualizes long feeds instead of mounting every batch', () => {
    const noop = () => undefined;
    const batches = Array.from({ length: 40 }, (_, index) => ({
      ...requireValue(fixtureBatches[0], 'first batch'),
      id: `batch-${String(index)}`,
      prompt: `Generated batch ${String(index)}`,
    }));
    const { container } = render(withQueryClient(
      <Canvas
        batches={batches}
        modelById={fixtureModelById}
        collections={[]}
        activeView={APP_VIEW_UNSORTED}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
        onBatchAction={noop}
        promptsEnabled={false}
        onTileAction={noop}
        onOpenTile={noop}
        q=""
      />,
    ));

    expect(container.querySelector('[data-virtualized="canvas"]')).not.toBeNull();
    const mountedBatches = container.querySelectorAll('[data-batch-id]');
    expect(mountedBatches.length).toBeGreaterThan(0);
    expect(mountedBatches.length).toBeLessThan(40);
    expect(screen.getByText('Generated batch 0')).not.toBeNull();
  });

  test('Canvas distinguishes search-empty and history-error states from the new-user empty state', () => {
    const noop = () => undefined;
    const { rerender } = render(withQueryClient(
      <Canvas
        batches={[]}
        modelById={fixtureModelById}
        collections={[]}
        activeView={APP_VIEW_UNSORTED}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
        onBatchAction={noop}
        promptsEnabled={false}
        onTileAction={noop}
        onOpenTile={noop}
        q="brass lamp"
      />,
    ));

    expect(screen.getByText('No results found')).toBeTruthy();
    expect(screen.queryByText('What would you like to make?')).toBeNull();

    rerender(
      withQueryClient(<Canvas
        batches={[]}
        modelById={fixtureModelById}
        collections={[]}
        activeView={APP_VIEW_UNSORTED}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
        onBatchAction={noop}
        promptsEnabled={false}
        onTileAction={noop}
        onOpenTile={noop}
        q=""
        error="History unavailable"
        onRetry={noop}
      />),
    );

    expect(screen.getByText('History unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText('What would you like to make?')).toBeNull();

    rerender(
      withQueryClient(<Canvas
        batches={historyFixture.items}
        modelById={fixtureModelById}
        collections={[]}
        activeView={APP_VIEW_UNSORTED}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={noop}
        onBatchAction={noop}
        promptsEnabled={false}
        onTileAction={noop}
        onOpenTile={noop}
        q=""
        error="History unavailable"
        onRetry={noop}
      />),
    );

    expect(screen.queryByText('History unavailable')).toBeNull();
    expect(screen.getAllByRole('img', { name: /generated image/i }).length).toBeGreaterThan(0);
  });

  test('Composer filters ratios per selected model and submits controlled draft', () => {
    const onSubmit = mock();
    const onPromptChange = mock();
    const onModelChange = mock();
    const onRatioChange = mock();
    render(withQueryClient(
      <Composer
        models={fixtureModels}
        modelById={fixtureModelById}
        prompt="small cinematic product still"
        modelId="flux-schnell-local"
        ratio="1:1"
        count={2}
        onPromptChange={onPromptChange}
        onModelChange={onModelChange}
        onRatioChange={onRatioChange}
        onDurationChange={() => undefined}
        onCountChange={() => undefined}
        onSubmit={onSubmit}
      />,
    ));

    const textbox = screen.getByPlaceholderText('Describe an image…');
    fireEvent.change(textbox, { target: { value: 'small cinematic product still with flowers' } });
    expect(onPromptChange).toHaveBeenCalledWith('small cinematic product still with flowers');

    const modelTrigger = screen.getByRole('button', { name: 'Model' });
    fireEvent.click(modelTrigger);
    fireEvent.click(screen.getByRole('option', { name: /GPT Image 2.5 Sunburst/ }));
    expect(onModelChange).toHaveBeenCalledWith('gpt-image-2.5-sunburst-cloud');

    const ratioTrigger = screen.getByLabelText('Ratio');
    expect(within(ratioTrigger).getByText('1:1')).toBeTruthy();
    fireEvent.click(ratioTrigger);
    expect(screen.queryByRole('option', { name: /16:9/ })).toBeNull();

    fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalled();
  });

  test('Composer uploads a dropped PNG and transitions the optimistic chip to ready', async () => {
    const revokeObjectURL = mock(() => undefined);
    URL.createObjectURL = mock(() => 'blob:ref-preview');
    URL.revokeObjectURL = revokeObjectURL;
    crypto.randomUUID = mock(() => 'client-upload') as unknown as typeof crypto.randomUUID;
    globalThis.fetch = mock(() => uploadResponse('upload-ready')) as unknown as typeof fetch;

    render(withQueryClient(
      <Composer
        models={fixtureModels}
        modelById={fixtureModelById}
        prompt="edit this"
        modelId="gpt-image-2.5-sunburst-cloud"
        ratio="1:1"
        count={1}
        onPromptChange={() => undefined}
        onModelChange={() => undefined}
        onRatioChange={() => undefined}
        onDurationChange={() => undefined}
        onCountChange={() => undefined}
        onSubmit={() => undefined}
      />,
    ));

    fireEvent.drop(screen.getByTestId('composer-drop-surface'), { dataTransfer: { files: [file()] } });

    expect(screen.getByRole('img', { name: 'Reference image 1' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Reference image 1' }).getAttribute('src')).toBe('/api/uploads/upload-ready?media=2');
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:ref-preview');
    expect(toGenerateRequest(useAtelierStore.getState().draft, 'gpt-image-2.5-sunburst-cloud', '1:1')).toMatchObject({
      refImageIds: ['upload-ready'],
    });
  });

  test('Composer maps upload quota failures to an error chip and toast', async () => {
    URL.createObjectURL = mock(() => 'blob:quota-preview');
    URL.revokeObjectURL = mock(() => undefined);
    crypto.randomUUID = mock(() => 'client-quota') as unknown as typeof crypto.randomUUID;
    globalThis.fetch = mock(() => new Response(JSON.stringify({ error: 'quota exceeded' }), { status: 429 })) as unknown as typeof fetch;

    render(withQueryClient(
      <Composer
        models={fixtureModels}
        modelById={fixtureModelById}
        prompt="edit this"
        modelId="gpt-image-2.5-sunburst-cloud"
        ratio="1:1"
        count={1}
        onPromptChange={() => undefined}
        onModelChange={() => undefined}
        onRatioChange={() => undefined}
        onDurationChange={() => undefined}
        onCountChange={() => undefined}
        onSubmit={() => undefined}
      />,
    ));

    fireEvent.drop(screen.getByTestId('composer-drop-surface'), { dataTransfer: { files: [file()] } });

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Reference image 1' })).toBeTruthy();
      expect(useAtelierStore.getState().toasts[0]?.text).toBe('quota exceeded');
    });
    expect(screen.getByRole('button', { name: /generate/i }).getAttribute('aria-disabled')).toBe('true');
  });

  test('Composer Clear button resets the prompt and removes ref images, disabled when empty', () => {
    const seen: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/uploads/upload-ready') && init?.method === 'DELETE') {
        return Response.json({ id: 'upload-ready', referenced: false });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    useAtelierStore.setState({
      draft: {
        prompt: 'starter prompt',
        modelId: 'gpt-image-2.5-sunburst-cloud',
        ratio: '1:1',
        durationFrames: null,
        count: 1,
        refImages: [{
          clientId: 'client-ready',
          serverId: 'upload-ready',
          status: 'ready',
          mime: 'image/png',
          sizeBytes: 1,
          previewUrl: '/api/uploads/upload-ready',
        }],
        rollQueue: [],
      },
    });

    const onPromptChange = mock(() => undefined);
    render(withQueryClient(
      <Composer
        models={fixtureModels}
        modelById={fixtureModelById}
        prompt="starter prompt"
        modelId="gpt-image-2.5-sunburst-cloud"
        ratio="1:1"
        count={1}
        onPromptChange={onPromptChange}
        onModelChange={() => undefined}
        onRatioChange={() => undefined}
        onDurationChange={() => undefined}
        onCountChange={() => undefined}
        onSubmit={() => undefined}
      />,
    ));

    const clearButton = screen.getByRole('button', { name: 'Clear prompt and reference images' });
    expect(clearButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(clearButton);

    // Clear writes the draft directly (snapshot + Undo toast); the destructive
    // server delete is deferred past the 5s Undo window, so it must NOT have
    // fired synchronously.
    expect(useAtelierStore.getState().draft.prompt).toBe('');
    expect(useAtelierStore.getState().draft.refImages).toEqual([]);
    const undoToast = useAtelierStore.getState().toasts.find((toast) => toast.text === 'Composer cleared');
    expect(undoToast?.action?.label).toBe('Undo');
    expect(seen).not.toContain('DELETE /api/uploads/upload-ready');

    // Undo restores both the prompt and the ref images.
    act(() => { undoToast?.action?.onClick(); });
    expect(useAtelierStore.getState().draft.prompt).toBe('starter prompt');
    expect(useAtelierStore.getState().draft.refImages).toHaveLength(1);
  });

  test('Composer Clear button is disabled when prompt is empty and no refs attached', () => {
    render(withQueryClient(
      <Composer
        models={fixtureModels}
        modelById={fixtureModelById}
        prompt=""
        modelId="gpt-image-2.5-sunburst-cloud"
        ratio="1:1"
        count={1}
        onPromptChange={() => undefined}
        onModelChange={() => undefined}
        onRatioChange={() => undefined}
        onDurationChange={() => undefined}
        onCountChange={() => undefined}
        onSubmit={() => undefined}
      />,
    ));
    expect(screen.getByRole('button', { name: 'Clear prompt and reference images' }).hasAttribute('disabled')).toBe(true);
  });

  test('Composer disables submit while a reference upload is in flight', async () => {
    URL.createObjectURL = mock(() => 'blob:pending-preview');
    URL.revokeObjectURL = mock(() => undefined);
    globalThis.fetch = mock(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

    render(withQueryClient(
      <Composer
        models={fixtureModels}
        modelById={fixtureModelById}
        prompt="edit this"
        modelId="gpt-image-2.5-sunburst-cloud"
        ratio="1:1"
        count={1}
        onPromptChange={() => undefined}
        onModelChange={() => undefined}
        onRatioChange={() => undefined}
        onDurationChange={() => undefined}
        onCountChange={() => undefined}
        onSubmit={() => undefined}
      />,
    ));

    fireEvent.drop(screen.getByTestId('composer-drop-surface'), { dataTransfer: { files: [file()] } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate/i }).getAttribute('aria-disabled')).toBe('true');
    });
    // Clear is gated too: an uploading ref has no serverId yet, so the
    // deferred teardown couldn't delete the server artifact and Undo would
    // restore a permanently-stuck 'uploading' chip.
    expect(screen.getByRole('button', { name: 'Clear prompt and reference images' }).hasAttribute('disabled')).toBe(true);
  });

  test('Composer disables submit with reference chips on a model that does not support them', () => {
    useAtelierStore.setState({
      draft: {
        prompt: '',
        modelId: '',
        ratio: '1:1',
        durationFrames: null,
        count: 1,
        refImages: [{
          clientId: 'client-ready',
          serverId: 'upload-ready',
          status: 'ready',
          mime: 'image/png',
          sizeBytes: 1,
          previewUrl: '/api/uploads/upload-ready',
        }],
        rollQueue: [],
      },
    });

    render(withQueryClient(
      <Composer
        models={fixtureModels}
        modelById={fixtureModelById}
        prompt="edit this"
        modelId="sdxl-local"
        ratio="1:1"
        count={1}
        onPromptChange={() => undefined}
        onModelChange={() => undefined}
        onRatioChange={() => undefined}
        onDurationChange={() => undefined}
        onCountChange={() => undefined}
        onSubmit={() => undefined}
      />,
    ));

    expect(screen.getByText('Model does not accept refs')).toBeTruthy();
    expect(screen.getByRole('button', { name: /generate/i }).getAttribute('aria-disabled')).toBe('true');
  });

  test('Composer rejects a fifth dropped reference without mutating existing chips', () => {
    globalThis.fetch = mock(() => uploadResponse('should-not-upload')) as unknown as typeof fetch;
    useAtelierStore.setState({
      draft: {
        prompt: '',
        modelId: '',
        ratio: '1:1',
        durationFrames: null,
        count: 1,
        refImages: [1, 2, 3, 4].map((index) => ({
          clientId: `client-${index}`,
          serverId: `upload-${index}`,
          status: 'ready' as const,
          mime: 'image/png',
          sizeBytes: index,
          previewUrl: `/api/uploads/upload-${index}`,
        })),
        rollQueue: [],
      },
    });

    render(withQueryClient(
      <Composer
        models={fixtureModels}
        modelById={fixtureModelById}
        prompt="edit this"
        modelId="gpt-image-2.5-sunburst-cloud"
        ratio="1:1"
        count={1}
        onPromptChange={() => undefined}
        onModelChange={() => undefined}
        onRatioChange={() => undefined}
        onDurationChange={() => undefined}
        onCountChange={() => undefined}
        onSubmit={() => undefined}
      />,
    ));

    fireEvent.drop(screen.getByTestId('composer-drop-surface'), { dataTransfer: { files: [file('fifth.png')] } });

    expect(useAtelierStore.getState().draft.refImages.map((ref) => ref.serverId)).toEqual(['upload-1', 'upload-2', 'upload-3', 'upload-4']);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().toasts[0]?.text).toBe('Maximum 4 reference images');
  });

  test('Composer keeps attached refs (and their previews) alive across unmount', async () => {
    const revokeObjectURL = mock(() => undefined);
    URL.createObjectURL = mock(() => 'blob:cleanup-preview');
    URL.revokeObjectURL = revokeObjectURL;
    globalThis.fetch = mock(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

    const { unmount } = render(withQueryClient(
      <Composer
        models={fixtureModels}
        modelById={fixtureModelById}
        prompt="edit this"
        modelId="gpt-image-2.5-sunburst-cloud"
        ratio="1:1"
        count={1}
        onPromptChange={() => undefined}
        onModelChange={() => undefined}
        onRatioChange={() => undefined}
        onDurationChange={() => undefined}
        onCountChange={() => undefined}
        onSubmit={() => undefined}
      />,
    ));

    fireEvent.drop(screen.getByTestId('composer-drop-surface'), { dataTransfer: { files: [file()] } });
    await waitFor(() => { expect(screen.getByRole('img', { name: 'Reference image 1' })).toBeTruthy(); });
    unmount();

    // Refs are ComposerDraft state and survive view navigation like every
    // other draft field — unmount must NOT clear them or revoke previews
    // (the store's ref-image transitions own blob-URL hygiene).
    expect(useAtelierStore.getState().draft.refImages).toHaveLength(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  test('Batch renders done, loading, and failed tile states with no-op actions', () => {
    const mixedBatch = requireValue(fixtureBatches.find((batch) =>
      batch.tiles.some((tile) => tile.status === 'failed'),
    ), 'mixed batch');

    render(withQueryClient(
      <BatchView
        batch={mixedBatch}
        modelById={fixtureModelById}
        activeView={APP_VIEW_UNSORTED}
        onBatchAction={() => undefined}
        promptsEnabled={false}
        onTileAction={() => undefined}
        onOpenTile={() => undefined}
        q=""
      />,
    ));

    expect(screen.getByText(mixedBatch.prompt)).toBeTruthy();
    expect(screen.getByText('Generation failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry failed tile' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss failed tile' })).toBeTruthy();
  });

  test('Lightbox traps focus, navigates done tiles only, closes, and returns focus', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'trigger tile';
    document.body.appendChild(trigger);
    trigger.focus();

    const onClose = mock();
    const doneBatch = requireValue(fixtureBatches[0], 'done batch');
    const firstTile = requireValue(doneBatch.tiles[0], 'first done tile');
    // Store is the single source of truth for the active tile — App only
    // renders Lightbox while lightbox state is open, so tests model that.
    useAtelierStore.getState().openLightbox(doneBatch.id, firstTile.id);
    const { rerender } = render(withQueryClient(
      <Lightbox
        batch={doneBatch}
        modelById={fixtureModelById}
        triggerKey={firstTile.id}
        deleteVariant="archive"
        onClose={onClose}
        onDownload={() => undefined}
        onDelete={() => undefined}
      />,
    ));

    const dialog = screen.getByRole('dialog', {
      name: new RegExp(`Image preview, 1 of 4, prompt: ${doneBatch.prompt}`),
    });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(labelId).not.toBe('lightbox-label');
    expect(dialog.getAttribute('aria-label')).toBeNull();
    expect(document.getElementById(labelId ?? '')?.tagName).toBe('H2');

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(screen.getByText(/02\/04/)).toBeTruthy();

    const close = screen.getByRole('button', { name: 'Close lightbox' });
    close.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Dismissal rides the shared exit transition (useExitTransition); the
    // close callback lands ~160ms after Escape.
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(onClose).toHaveBeenCalled();

    rerender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><></></QueryClientProvider>);
    await waitFor(() => { expect(document.activeElement).toBe(trigger); });
    trigger.remove();
  });

  test('Lightbox shows Edit only for models that support reference images', () => {
    const doneBatch = requireValue(fixtureBatches[0], 'done batch');
    const firstTile = requireValue(doneBatch.tiles[0], 'first done tile');
    const { rerender } = render(withQueryClient(
      <Lightbox
        batch={doneBatch}
        modelById={fixtureModelById}
        triggerKey={firstTile.id}
        deleteVariant="archive"
        onClose={() => undefined}
        onDownload={() => undefined}
        onDelete={() => undefined}
      />,
    ));

    expect(screen.getByRole('button', { name: 'Edit from this image' })).toBeTruthy();

    rerender(withQueryClient(
      <Lightbox
        batch={{ ...doneBatch, modelId: 'sdxl-local', modelLabel: 'SDXL 1.0' }}
        modelById={fixtureModelById}
        triggerKey={firstTile.id}
        deleteVariant="archive"
        onClose={() => undefined}
        onDownload={() => undefined}
        onDelete={() => undefined}
      />,
    ));

    expect(screen.queryByRole('button', { name: 'Edit from this image' })).toBeNull();
  });

  test('Lightbox renders the active tile at full resolution regardless of thumbUrl', () => {
    const doneBatch = requireValue(fixtureBatches[0], 'done batch');
    const firstTile = requireValue(doneBatch.tiles[0], 'first done tile');
    const tileWithThumb = firstTile.status === 'done'
      ? { ...firstTile, thumbUrl: '/api/img/done-01/thumb' }
      : firstTile;
    render(withQueryClient(
      <Lightbox
        batch={{ ...doneBatch, tiles: [tileWithThumb, ...doneBatch.tiles.slice(1)] }}
        modelById={fixtureModelById}
        triggerKey={firstTile.id}
        deleteVariant="archive"
        onClose={() => undefined}
        onDownload={() => undefined}
        onDelete={() => undefined}
      />,
    ));

    const full = screen.getByRole('img', { name: new RegExp(`Expanded generated image, prompt: ${doneBatch.prompt}`) });
    expect(full.getAttribute('src')).toBe(firstTile.status === 'done' ? firstTile.url : '');
    expect(full.getAttribute('fetchpriority')).toBe('high');
    expect(full.parentElement?.getAttribute('style')).toContain('/api/img/done-01/thumb');
    expect(screen.queryByRole('presentation', { hidden: true })).toBeNull();
  });

  test('Lightbox Edit pushes the active tile into the composer, focuses prompt, and closes', async () => {
    URL.createObjectURL = mock(() => 'blob:edit-preview');
    URL.revokeObjectURL = mock(() => undefined);
    crypto.randomUUID = mock(() => 'client-edit') as unknown as typeof crypto.randomUUID;
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith('/img/done-01')) return new Response('tile-bytes', { status: 200, headers: { 'Content-Type': 'image/png' } });
      if (url.endsWith('/uploads')) return uploadResponse('upload-edit');
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const prompt = document.createElement('textarea');
    prompt.id = 'atelier-composer-prompt';
    document.body.appendChild(prompt);

    const onClose = mock();
    const doneBatch = requireValue(fixtureBatches[0], 'done batch');
    const firstTile = requireValue(doneBatch.tiles[0], 'first done tile');
    const { unmount } = render(withQueryClient(
      <Lightbox
        batch={doneBatch}
        modelById={fixtureModelById}
        triggerKey={firstTile.id}
        deleteVariant="archive"
        onClose={onClose}
        onDownload={() => undefined}
        onDelete={() => undefined}
      />,
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Edit from this image' }));

    await waitFor(() => {
      expect(useAtelierStore.getState().draft.refImages).toHaveLength(1);
      expect(useAtelierStore.getState().draft.refImages[0]).toMatchObject({ clientId: 'client-edit', serverId: 'upload-edit', status: 'ready' });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(onClose).toHaveBeenCalled();
    // editFromTile hands focus to the composer from the lightbox's unmount
    // cleanup — App unmounts the lightbox in response to onClose. Model that.
    unmount();
    await waitFor(() => { expect(document.activeElement).toBe(prompt); });
    prompt.remove();
  });

  test('Lightbox Edit with four chips replaces the fourth and deletes the evicted upload', async () => {
    URL.createObjectURL = mock(() => 'blob:edit-preview');
    URL.revokeObjectURL = mock(() => undefined);
    crypto.randomUUID = mock(() => 'client-edit') as unknown as typeof crypto.randomUUID;
    const seen: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/img/done-01')) return new Response('tile-bytes', { status: 200, headers: { 'Content-Type': 'image/png' } });
      if (url.endsWith('/uploads') && init?.method === 'POST') return uploadResponse('upload-edit');
      if (url.endsWith('/uploads/upload-4') && init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    useAtelierStore.setState({
      draft: {
        prompt: '',
        modelId: '',
        ratio: '1:1',
        durationFrames: null,
        count: 1,
        refImages: [1, 2, 3, 4].map((index) => ({
          clientId: `client-${index}`,
          serverId: `upload-${index}`,
          status: 'ready' as const,
          mime: 'image/png',
          sizeBytes: index,
          previewUrl: `/api/uploads/upload-${index}`,
        })),
        rollQueue: [],
      },
    });

    const doneBatch = requireValue(fixtureBatches[0], 'done batch');
    const firstTile = requireValue(doneBatch.tiles[0], 'first done tile');
    render(withQueryClient(
      <Lightbox
        batch={doneBatch}
        modelById={fixtureModelById}
        triggerKey={firstTile.id}
        deleteVariant="archive"
        onClose={() => undefined}
        onDownload={() => undefined}
        onDelete={() => undefined}
      />,
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Edit from this image' }));

    await waitFor(() => {
      expect(useAtelierStore.getState().draft.refImages.map((ref) => ref.serverId)).toEqual(['upload-1', 'upload-2', 'upload-3', 'upload-edit']);
      expect(seen).toContain('DELETE /api/uploads/upload-4');
    });
  });

  test('Lightbox Edit restores the evicted fourth chip if the replacement upload fails', async () => {
    URL.createObjectURL = mock(() => 'blob:edit-preview');
    URL.revokeObjectURL = mock(() => undefined);
    crypto.randomUUID = mock(() => 'client-edit') as unknown as typeof crypto.randomUUID;
    const seen: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/img/done-01')) return new Response('tile-bytes', { status: 200, headers: { 'Content-Type': 'image/png' } });
      if (url.endsWith('/uploads') && init?.method === 'POST') return new Response(JSON.stringify({ error: 'quota exceeded' }), { status: 429 });
      if (url.endsWith('/uploads/upload-4') && init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    useAtelierStore.setState({
      draft: {
        prompt: '',
        modelId: '',
        ratio: '1:1',
        durationFrames: null,
        count: 1,
        refImages: [1, 2, 3, 4].map((index) => ({
          clientId: `client-${index}`,
          serverId: `upload-${index}`,
          status: 'ready' as const,
          mime: 'image/png',
          sizeBytes: index,
          previewUrl: `/api/uploads/upload-${index}`,
        })),
        rollQueue: [],
      },
    });

    const doneBatch = requireValue(fixtureBatches[0], 'done batch');
    const firstTile = requireValue(doneBatch.tiles[0], 'first done tile');
    render(withQueryClient(
      <Lightbox
        batch={doneBatch}
        modelById={fixtureModelById}
        triggerKey={firstTile.id}
        deleteVariant="archive"
        onClose={() => undefined}
        onDownload={() => undefined}
        onDelete={() => undefined}
      />,
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Edit from this image' }));

    await waitFor(() => {
      expect(useAtelierStore.getState().draft.refImages.map((ref) => ref.serverId)).toEqual(['upload-1', 'upload-2', 'upload-3', 'upload-4']);
      expect(useAtelierStore.getState().toasts[0]?.text).toBe('quota exceeded');
    });
    expect(seen).not.toContain('DELETE /api/uploads/upload-4');
  });

  test('Lightbox arrow buttons clear the active provenance preview', () => {
    const doneBatch = requireValue(fixtureBatches[0], 'done batch');
    const firstTile = requireValue(doneBatch.tiles[0], 'first done tile');
    const secondTile = requireValue(doneBatch.tiles[1], 'second done tile');
    useAtelierStore.getState().openLightbox(doneBatch.id, firstTile.id);
    render(withQueryClient(
      <Lightbox
        batch={{
          ...doneBatch,
          tiles: doneBatch.tiles.map((tile, index) =>
            index === 0 && tile.status === 'done' ? { ...tile, refImageIds: ['upload-ref-1'] } : tile,
          ),
        }}
        modelById={fixtureModelById}
        triggerKey={firstTile.id}
        deleteVariant="archive"
        onClose={() => undefined}
        onDownload={() => undefined}
        onDelete={() => undefined}
      />,
    ));

    fireEvent.click(screen.getByRole('button', { name: 'View reference image 1 of 1' }));
    expect(screen.getByRole('button', { name: 'View reference image 1 of 1' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));

    expect(screen.getByRole('img', { name: new RegExp(`Expanded generated image, prompt: ${doneBatch.prompt}`) }).getAttribute('src')).toBe(secondTile.status === 'done' ? secondTile.url : '');
  });

  test('Lightbox swipe gestures navigate horizontally and close vertically', async () => {
    HTMLElement.prototype.setPointerCapture = mock(() => undefined);
    const onClose = mock();
    const doneBatch = requireValue(fixtureBatches[0], 'done batch');
    const firstTile = requireValue(doneBatch.tiles[0], 'first done tile');
    useAtelierStore.getState().openLightbox(doneBatch.id, firstTile.id);
    render(withQueryClient(
      <Lightbox
        batch={doneBatch}
        modelById={fixtureModelById}
        triggerKey={firstTile.id}
        deleteVariant="archive"
        onClose={onClose}
        onDownload={() => undefined}
        onDelete={() => undefined}
      />,
    ));

    const image = screen.getByRole('img', { name: new RegExp(`Expanded generated image, prompt: ${doneBatch.prompt}`) });
    fireEvent.pointerDown(image, { clientX: 220, clientY: 120, pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerMove(image, { clientX: 90, clientY: 126, pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerUp(image, { clientX: 90, clientY: 126, pointerId: 1, pointerType: 'touch' });
    expect(screen.getByText(/02\/04/)).toBeTruthy();

    const secondImage = screen.getByRole('img', { name: new RegExp(`Expanded generated image, prompt: ${doneBatch.prompt}`) });
    fireEvent.pointerDown(secondImage, { clientX: 120, clientY: 100, pointerId: 2, pointerType: 'touch' });
    fireEvent.pointerMove(secondImage, { clientX: 120, clientY: 210, pointerId: 2, pointerType: 'touch' });
    fireEvent.pointerUp(secondImage, { clientX: 120, clientY: 210, pointerId: 2, pointerType: 'touch' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(onClose).toHaveBeenCalled();
  });

  test('archiving the final tile closes the lightbox before the batch disappears', async () => {
    installMatchMedia(false);
    const sourceBatch = requireValue(fixtureBatches[0], 'done batch');
    const onlyTile = requireValue(sourceBatch.tiles.find((tile) => tile.status === 'done'), 'done tile');
    const singleBatch = { ...sourceBatch, tiles: [onlyTile] };
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/models')) return Response.json(fixtureModels);
      if (url.endsWith('/collections')) return Response.json({ items: [], summary: { totalCount: 1, pinnedCount: 0, unsortedCount: 1, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } });
      if (url.includes('/history')) return Response.json({ items: [singleBatch], nextCursor: null });
      if (url.includes('/archive')) return Response.json({ items: [], nextCursor: null, total: 0 });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({});
    }) as unknown as typeof fetch;

    render(withQueryClient(<App />));
    const tileButton = await screen.findByRole('button', { name: /^Open image 1\b/ });
    fireEvent.click(tileButton);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Archive expanded image' }));

    await waitFor(() => {
      expect(useAtelierStore.getState().lightbox).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  test('Toast queue renders visible messages', () => {
    useAtelierStore.setState({ toasts: [{ id: 'toast-1', text: 'Downloaded' }] });
    render(<Toast />);
    expect(screen.getAllByText('Downloaded').length).toBeGreaterThan(0);
  });

  test('Toast separates error and status into two live regions so success messages are never announced as assertive', () => {
    // Codex Tier-2 review caught that a single escalated region with
    // aria-atomic=true would announce mixed success+error toasts as urgent
    // on screen readers. Two regions: errors are assertive, success/soft
    // stay polite. No nested role="alert" on individual messages.
    useAtelierStore.setState({
      toasts: [
        { id: 'success', text: 'Saved' },
        { id: 'error', text: 'Generation failed', tone: 'error' },
        { id: 'soft', text: 'At capacity', tone: 'soft' },
      ],
    });
    render(<Toast />);
    const errorRegion = screen.getByRole('alert');
    expect(errorRegion.getAttribute('role')).toBe('alert');
    expect(errorRegion.getAttribute('aria-live')).toBe('assertive');
    expect(errorRegion.textContent).toBe('Generation failed');

    const statusRegion = screen.getByRole('status');
    expect(statusRegion.getAttribute('role')).toBe('status');
    expect(statusRegion.getAttribute('aria-live')).toBe('polite');
    expect(statusRegion.textContent).toBe('SavedAt capacity');

    // Success/soft are siblings of the error region, NOT descendants.
    expect(errorRegion.textContent).not.toContain('Saved');
    expect(errorRegion.textContent).not.toContain('At capacity');
    expect(screen.getAllByText('Generation failed').some((node) => node.getAttribute('role') === 'alert')).toBe(false);
  });

  test('Empty archive confirmation names the GLOBAL archived count, not the scoped archiveQuery.total', async () => {
    // The Empty-Archive purge calls an UNSCOPED DELETE /archive — it wipes
    // every row, regardless of which scope (collection / unsorted / pinned)
    // the user is viewing. The confirmation count must therefore mirror the
    // global total (collections.summary.archivedTotalCount), never the
    // scope-filtered archiveQuery.total — otherwise the user reads "deletes 3"
    // but the server deletes 100.
    installMatchMedia(false);
    // Scope shows 3 items, global has 100 — destructive blast radius is 100.
    mockAppFetch(3, 100);
    await act(async () => {
      render(withQueryClient(<App />, 100));
      await Promise.resolve();
    });

    const archiveButton = await screen.findByRole('button', { name: 'Archive' });
    await act(async () => {
      fireEvent.click(archiveButton);
      await Promise.resolve();
    });
    const emptyArchiveButton = await screen.findByRole<HTMLButtonElement>('button', { name: 'Empty Archive' });
    // The lazy view can commit its header before the scoped archive GET
    // resolves. Wait until its destructive action is actually available.
    await waitFor(() => { expect(emptyArchiveButton.disabled).toBe(false); });
    await act(async () => {
      fireEvent.click(emptyArchiveButton);
      await Promise.resolve();
    });

    expect(await screen.findByText('This permanently deletes 100 images from disk. This cannot be undone.')).toBeTruthy();
  });

  test('Drawer hamburger toggles the phone drawer', async () => {
    await renderAppForDrawer(true);

    const hamburger = screen.getByRole('button', { name: 'Open menu' });
    fireEvent.click(hamburger);

    await waitFor(() => {
      expect(useAtelierStore.getState().sidebarOpen).toBe(true);
      expect(hamburger.getAttribute('aria-expanded')).toBe('true');
    });
  });

  test('Drawer backdrop click closes the phone drawer', async () => {
    const { container } = await renderAppForDrawer(true);
    act(() => { useAtelierStore.getState().setSidebarOpen(true); });
    const backdrop = requireValue(container.querySelector<HTMLButtonElement>('button[aria-hidden]'), 'drawer backdrop');

    await waitFor(() => { expect(backdrop.getAttribute('data-open')).toBe('true'); });
    fireEvent.click(backdrop);

    await waitFor(() => { expect(useAtelierStore.getState().sidebarOpen).toBe(false); });
  });

  test('Drawer closes on Escape when the lightbox is closed', async () => {
    await renderAppForDrawer(true);
    act(() => { useAtelierStore.getState().setSidebarOpen(true); });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => { expect(useAtelierStore.getState().sidebarOpen).toBe(false); });
  });

  test('Drawer Escape yields to lightbox Escape before closing the drawer', async () => {
    await renderAppForDrawer(true);
    const doneBatch = requireValue(fixtureBatches[0], 'done batch');
    const firstTile = requireValue(doneBatch.tiles[0], 'first done tile');
    act(() => {
      useAtelierStore.getState().setSidebarOpen(true);
      useAtelierStore.getState().openLightbox(doneBatch.id, firstTile.id);
    });

    await waitFor(() => { expect(screen.getByRole('dialog')).toBeTruthy(); });
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(useAtelierStore.getState().lightbox).toBeNull();
      expect(useAtelierStore.getState().sidebarOpen).toBe(true);
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => { expect(useAtelierStore.getState().sidebarOpen).toBe(false); });
  });

  test('Drawer open moves focus into the phone sidebar', async () => {
    const { container } = await renderAppForDrawer(true);
    const hamburger = screen.getByRole('button', { name: 'Open menu' });
    const sidebar = requireValue(container.querySelector<HTMLElement>('#atelier-sidebar'), 'sidebar');

    fireEvent.click(hamburger);

    await waitFor(() => {
      expect(sidebar.contains(document.activeElement)).toBe(true);
      expect(document.activeElement?.tagName).toBe('BUTTON');
    });
  });

  test('Drawer open removes the obscured hamburger from the tab order', async () => {
    await renderAppForDrawer(true);
    const hamburger = screen.getByRole('button', { name: 'Open menu' });

    fireEvent.click(hamburger);

    await waitFor(() => { expect(hamburger.getAttribute('tabindex')).toBe('-1'); });
  });

  test('Drawer close returns focus to the hamburger on phone', async () => {
    await renderAppForDrawer(true);
    const hamburger = screen.getByRole('button', { name: 'Open menu' });

    fireEvent.click(hamburger);
    await waitFor(() => { expect(document.activeElement).not.toBe(hamburger); });
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));

    await waitFor(() => { expect(document.activeElement).toBe(hamburger); });
  });

  test('Drawer close does not focus the hidden hamburger on desktop', async () => {
    const sentinel = document.createElement('button');
    document.body.appendChild(sentinel);
    const { container } = await renderAppForDrawer(false);
    const hamburger = requireValue(container.querySelector<HTMLButtonElement>('button[aria-controls="atelier-sidebar"]'), 'hamburger');
    sentinel.focus();

    act(() => {
      useAtelierStore.getState().setSidebarOpen(true);
      useAtelierStore.getState().setSidebarOpen(false);
    });

    await waitFor(() => { expect(document.activeElement).not.toBe(hamburger); });
    sentinel.remove();
  });

  test('Drawer auto-closes when phone viewport changes to desktop', async () => {
    const matchMedia = installMatchMedia(true);
    mockAppFetch();
    render(withQueryClient(<App />));
    await waitFor(() => { expect(screen.getAllByText(fixtureBatches[0]?.prompt ?? '').length).toBeGreaterThan(0); });
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    await waitFor(() => { expect(useAtelierStore.getState().sidebarOpen).toBe(true); });

    act(() => { matchMedia.setMatches(false); });

    await waitFor(() => { expect(useAtelierStore.getState().sidebarOpen).toBe(false); });
  });

  test('Drawer open applies inert to main on phone', async () => {
    await renderAppForDrawer(true);

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    await waitFor(() => { expect(screen.getByRole('main').hasAttribute('inert')).toBe(true); });
  });

  test('App composes server-backed shell and opens the lightbox from a tile', async () => {
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.endsWith('/models')) return Response.json(fixtureModels);
      if (url.includes('/history')) return Response.json(historyFixture);
      return Response.json({});
    }) as unknown as typeof fetch;

    render(withQueryClient(<App />));
    await waitFor(() => { expect(screen.getAllByText(fixtureBatches[0]?.prompt ?? '').length).toBeGreaterThan(0); });
    const openButtons = screen.getAllByRole('button', { name: /open image/i });
    const firstOpenButton = requireValue(openButtons[0], 'first open button');
    fireEvent.click(firstOpenButton);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('Re-roll forwards refImageIds from the source edit batch', async () => {
    const editBatch = requireValue(fixtureBatches[0], 'edit batch fixture');
    const editHistory = {
      items: [{
        ...editBatch,
        prompt: 'edit-batch-prompt',
        tiles: editBatch.tiles.map((tile) => ({ ...tile, refImageIds: ['upload-edit-1'] })),
      }],
      nextCursor: null,
    };
    let generateBody: unknown = null;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/models')) return Response.json(fixtureModels);
      if (url.includes('/history')) return Response.json(editHistory);
      if (url.endsWith('/generate')) {
        generateBody = init?.body ? JSON.parse(init.body as string) : null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: done\ndata: {"batchId":"reroll-batch"}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    render(withQueryClient(<App />));
    await waitFor(() => { expect(screen.getAllByText('edit-batch-prompt').length).toBeGreaterThan(0); });

    // Re-roll is now in the overflow menu — open More then click Re-roll
    const moreBtn = requireValue(screen.getAllByRole('button', { name: /more actions/i })[0], 'more button');
    fireEvent.click(moreBtn);
    const rerollItem = requireValue(screen.getAllByRole('menuitem', { name: /re-roll/i })[0], 'reroll menuitem');
    fireEvent.click(rerollItem);

    await waitFor(() => { expect(generateBody).not.toBeNull(); });
    expect(generateBody).toMatchObject({ refImageIds: ['upload-edit-1'] });
  });

  test('Re-roll resets the live store scope even when the App closure is stale', async () => {
    const editBatch = requireValue(fixtureBatches[0], 'edit batch fixture');
    const editHistory = { items: [{ ...editBatch, prompt: 'stale-scope-prompt' }], nextCursor: null };
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/models')) return Response.json(fixtureModels);
      if (url.includes('/history')) return Response.json(editHistory);
      if (url.endsWith('/generate')) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: done\ndata: {"batchId":"reroll-batch"}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    render(withQueryClient(<App />));
    await waitFor(() => { expect(screen.getAllByText('stale-scope-prompt').length).toBeGreaterThan(0); });

    // Open the overflow menu while the batch is visible, THEN set the stale store state
    // (the menu ref and menuitem are already in the DOM before state changes)
    const moreBtn = requireValue(screen.getAllByRole('button', { name: /more actions/i })[0], 'more button');
    fireEvent.click(moreBtn);
    const rerollItem = requireValue(screen.getAllByRole('menuitem', { name: /re-roll/i })[0], 'reroll menuitem');

    // Now change the store to the "stale" state — the menu is already open.
    // The store write deliberately bypasses act so React has not re-rendered
    // when the click runs: the handler must still see the live store, not the
    // App closure. Wrapping it in act (or turning the act environment off)
    // lets React re-render first and the test stops catching a closure-reading
    // handler, so only React's expected act warning for this write is dropped.
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
      consoleError(...args);
    };
    try {
      useAtelierStore.setState({ view: APP_VIEW_PINNED, q: 'queued search' });
    } finally {
      console.error = consoleError;
    }

    fireEvent.click(rerollItem);

    // Assert synchronously: a later async render could reset the scope and
    // mask a handler that skipped it.
    expect(useAtelierStore.getState().view).toEqual(APP_VIEW_UNSORTED);
    expect(useAtelierStore.getState().q).toBe('');
    // Then drain the re-roll's stream and query updates inside act.
    await act(async () => { await flushQueryNotifications(); });
  });

  test('Retry forwards refImageIds from the failed tile\'s batch', async () => {
    const baseBatch = requireValue(fixtureBatches[3], 'failed-only batch fixture');
    const editHistory = {
      items: [{
        ...baseBatch,
        prompt: 'retry-batch-prompt',
        tiles: baseBatch.tiles.map((tile) => ({
          ...tile,
          refImageIds: ['upload-retry-1'],
          ...(tile.status === 'failed' ? { error: 'internal error' as const } : {}),
        })),
      }],
      nextCursor: null,
    };
    let generateBody: unknown = null;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/models')) return Response.json(fixtureModels);
      if (url.includes('/history')) return Response.json(editHistory);
      if (url.endsWith('/generate')) {
        generateBody = init?.body ? JSON.parse(init.body as string) : null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: done\ndata: {"batchId":"retry-batch"}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    render(withQueryClient(<App />));
    await waitFor(() => { expect(screen.getAllByText('retry-batch-prompt').length).toBeGreaterThan(0); });

    const retryButton = requireValue(screen.getAllByRole('button', { name: 'Retry failed tile' })[0], 'retry button');
    fireEvent.click(retryButton);

    await waitFor(() => { expect(generateBody).not.toBeNull(); });
    expect(generateBody).toMatchObject({ refImageIds: ['upload-retry-1'] });
  });
});
