import type { Model, PromptLibraryResponse } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import App from './App';
import { promptKeys } from './api/prompts';
import { fixtureModels } from '../test/fixtures/models';
import { historyFixture } from '../test/fixtures/batches';
import { APP_VIEW_PROMPTS, APP_VIEW_UNSORTED, useAtelierStore } from './store/atelier';

const originalMatchMedia = window.matchMedia.bind(window);

const promptLibrary: PromptLibraryResponse = {
  templates: [{
    id: '019e42fd-2222-7000-8000-000000000001',
    name: 'Still life',
    body: 'photorealistic {{var::subject}}',
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  }],
  variableLists: [],
  dimensions: [],
};

function collectionResponse() {
  return {
    items: [],
    summary: {
      totalCount: historyFixture.items.length,
      pinnedCount: 0,
      unsortedCount: historyFixture.items.length,
      archivedTotalCount: 0,
      archivedPinnedCount: 0,
      archivedUnsortedCount: 0,
    },
  };
}

function installMatchMedia(): void {
  window.matchMedia = mock((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: mock(() => undefined),
    removeEventListener: mock(() => undefined),
    addListener: mock(() => undefined),
    removeListener: mock(() => undefined),
    dispatchEvent: mock(() => true),
  }));
}

function installUrl(search = ''): void {
  if (window.location.origin === 'null') window.location.href = 'http://localhost/';
  window.history.replaceState({}, '', `http://localhost/${search}`);
}

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function renderApp({
  promptResponse,
  seedLibrary = false,
  search = '',
  models = fixtureModels,
  history = historyFixture,
}: {
  promptResponse: Response | PromptLibraryResponse;
  seedLibrary?: boolean;
  search?: string;
  models?: readonly Model[];
  history?: typeof historyFixture;
}) {
  installMatchMedia();
  installUrl(search);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
  if (seedLibrary) client.setQueryData(promptKeys.library(), promptLibrary);
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.endsWith('/models')) return Response.json(models);
    if (url.endsWith('/collections')) return Response.json(collectionResponse());
    if (url.includes('/history')) return Response.json(history);
    if (url.includes('/archive')) return Response.json({ items: [], nextCursor: null, total: 0 });
    if (url.endsWith('/prompts')) {
      if (promptResponse instanceof Response) return promptResponse.clone();
      return Response.json(promptResponse);
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  return render(<App />, { wrapper: wrapper(client) });
}

afterEach(() => {
  cleanup();
  mock.restore();
  window.matchMedia = originalMatchMedia;
  installUrl();
  useAtelierStore.setState({
    view: APP_VIEW_UNSORTED,
    q: '',
    draft: { prompt: '', modelId: '', ratio: '1:1', durationFrames: null, count: 2, refImages: [], rollQueue: [] },
    sidebarOpen: false,
    lightbox: null,
    toasts: [],
  });
});

describe('App prompt-library gate', () => {
  test('gated user: no rail entry, no Composer chip, Manager never renders, ?view=prompts falls back', async () => {
    renderApp({
      search: '?view=prompts',
      promptResponse: new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
    });

    await waitFor(() => { expect(useAtelierStore.getState().view.kind).toBe('unsorted'); });

    expect(screen.queryByRole('heading', { name: 'Prompt Library' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prompt Library' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Templates' })).toBeNull();
    expect(window.location.search).not.toContain('view=prompts');
    expect(screen.getByText('Atelier', { selector: 'div' })).toBeTruthy();
  });

  test('eligible user can render the Manager without a gated flash', async () => {
    renderApp({ promptResponse: promptLibrary, seedLibrary: true });

    // With `refetchOnMount: 'always'` removed from promptLibraryOpts, the
    // pre-seeded cache satisfies the mount without any /api/prompts roundtrip.
    // Revalidation only happens on TanStack's default triggers (staleTime
    // expiry, focus, reconnect) plus the cheap ETag/304 conditional GET.
    await waitFor(() => {
      expect(useAtelierStore.getState().view.kind).toBe('unsorted');
    });

    await act(async () => {
      useAtelierStore.getState().setView(APP_VIEW_PROMPTS);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(await screen.findByRole('heading', { name: 'Prompt Library' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prompt Library' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Templates' })).toBeTruthy();
  });

  test('Reopen in video mode keeps the video draft and does not arm a hidden picker', async () => {
    const i2vModel: Model = {
      id: 'minimax-h3-i2v',
      name: 'MiniMax H3',
      backend: 'local',
      tag: 'comfyui',
      latency: 'slow',
      supportedRatios: ['16:9', '9:16'],
      supportsI2V: true,
      outputsVideo: true,
      pool: 'local',
      concurrencyCapPerUser: 1,
      maxCountPerBatch: 1,
    };
    const [first, ...rest] = historyFixture.items;
    if (!first) throw new Error('history fixture is empty');
    const history = {
      ...historyFixture,
      items: [{ ...first, provenance: { templateId: promptLibrary.templates[0]?.id ?? 't1', templateName: 'Still life', rollSeed: 1, pins: {} } }, ...rest],
    };
    useAtelierStore.getState().setDraft({ modelId: i2vModel.id, i2vSourceUploadId: 'source-1', motionPrompt: 'slow push-in' });
    renderApp({ promptResponse: promptLibrary, seedLibrary: true, models: [...fixtureModels, i2vModel], history });

    // Only the first fixture batch carries provenance; target its own overflow
    // trigger rather than whichever batch's trigger comes first in the DOM.
    const provenanceBatch = await waitFor(() => {
      const section = document.querySelector<HTMLElement>(`section[data-batch-id="${first.id}"]`);
      if (!section) throw new Error('provenance batch is not rendered');
      return section;
    });
    fireEvent.click(within(provenanceBatch).getByRole('button', { name: 'More actions' }));
    // Reopen is gated on the prompt library; waiting for it waits for the gate.
    const menu = await screen.findByRole('menu', { name: 'Batch actions' });
    fireEvent.click(await within(menu).findByRole('menuitem', { name: 'Reopen in picker' }));

    const state = useAtelierStore.getState();
    expect(state.toasts.some((toast) => toast.text === 'Switch to an image model to reopen templates')).toBe(true);
    expect(state.toasts.some((toast) => toast.text === 'Reopened in picker')).toBe(false);
    expect(state.pickerOpen).toBe(false);
    expect(state.draft).toMatchObject({ modelId: i2vModel.id, i2vSourceUploadId: 'source-1', motionPrompt: 'slow push-in' });
  });

  test('eligible prompt-library route keeps the managed header around a 500 error', async () => {
    renderApp({
      search: '?view=prompts',
      promptResponse: Response.json({ error: 'upstream unavailable' }, { status: 500 }),
    });

    expect(await screen.findByRole('heading', { name: 'Prompt Library' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to feed' })).toBeTruthy();
    expect(await screen.findByText('Couldn’t load the prompt library.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
