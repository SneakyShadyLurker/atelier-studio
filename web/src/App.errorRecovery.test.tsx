import type { Batch, Model, PromptLibraryResponse } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { historyKeys } from './api/history';
import { fixtureModels } from '../test/fixtures/models';
import { APP_VIEW_UNSORTED, useAtelierStore } from './store/atelier';

void mock.module('./components/Canvas', () => ({
  default: ({ batches }: { batches: readonly Batch[]; modelById: ReadonlyMap<string, Model> }) => {
    if (batches.some((batch) => batch.id === 'corrupt-history')) {
      throw new Error('corrupt history data');
    }
    return <div data-testid="canvas-recovered">{batches[0]?.id ?? 'empty'}</div>;
  },
}));

const { default: App } = await import('./App');

const originalMatchMedia = window.matchMedia.bind(window);
const originalConsoleError = console.error;

const promptLibrary: PromptLibraryResponse = {
  templates: [],
  variableLists: [],
  dimensions: [],
};

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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function makeBatch(id: string): Batch {
  return {
    id,
    prompt: 'test',
    ratio: '1:1',
    modelId: 'gpt-image-2.5-sunburst',
    modelLabel: 'GPT Image 2.5 Sunburst',
    createdAt: 1,
    collectionId: null,
    pinned: false,
    status: 'done',
    tiles: [{
      id: `${id}-tile`,
      seed: 1,
      status: 'done',
      url: `/img/${id}.png`,
      ext: 'png',
      mime: 'image/png',
      completedAt: 1,
    }],
  };
}

function collectionResponse() {
  return {
    items: [],
    summary: {
      totalCount: 1,
      pinnedCount: 0,
      unsortedCount: 1,
      archivedTotalCount: 0,
      archivedPinnedCount: 0,
      archivedUnsortedCount: 0,
    },
  };
}

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  cleanup();
  mock.restore();
  window.matchMedia = originalMatchMedia;
  console.error = originalConsoleError;
  if (window.location.origin !== 'null') window.history.replaceState({}, '', 'http://localhost/');
  useAtelierStore.setState({
    view: APP_VIEW_UNSORTED,
    q: '',
    draft: { prompt: '', modelId: '', ratio: '1:1', durationFrames: null, count: 2, refImages: [], rollQueue: [] },
    sidebarOpen: false,
    lightbox: null,
    toasts: [],
  });
});

describe('App canvas error recovery', () => {
  test('reload feed resets the active history query before clearing the Canvas boundary', async () => {
    installMatchMedia();
    if (window.location.origin === 'null') window.location.href = 'http://localhost/';
    let historyCalls = 0;
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith('/models')) return Response.json(fixtureModels);
      if (url.endsWith('/collections')) return Response.json(collectionResponse());
      if (url.includes('/archive')) return Response.json({ items: [], nextCursor: null, total: 0 });
      if (url.endsWith('/prompts')) return Response.json(promptLibrary);
      if (url.includes('/history')) {
        historyCalls += 1;
        return Response.json({
          items: [makeBatch(historyCalls === 1 ? 'corrupt-history' : 'clean-history')],
          nextCursor: null,
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    console.error = mock(() => undefined);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, retryDelay: 0 },
        mutations: { retry: false },
      },
    });
    const resetQueries = spyOn(client, 'resetQueries');

    render(<App />, { wrapper: wrapper(client) });

    fireEvent.click(await screen.findByRole('button', { name: 'Reload feed' }));

    expect(resetQueries).toHaveBeenCalledWith({ queryKey: historyKeys.scoped(APP_VIEW_UNSORTED, '') });
    await waitFor(() => { expect(screen.getByTestId('canvas-recovered').textContent).toBe('clean-history'); });
  });
});
