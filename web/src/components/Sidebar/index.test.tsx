import type { Batch, HistoryPage, Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useAtelierStore } from '../../store/atelier';
import Sidebar from './index';

const originalMatchMedia = window.matchMedia.bind(window);
const history: HistoryPage<Batch> = { items: [], nextCursor: null };
const models: readonly Model[] = [{
  id: 'gpt-image-2.5-sunburst-cloud',
  name: 'GPT Image 2.5 Sunburst',
  backend: 'cloud',
  tag: 'cloud',
  latency: 'fast',
  supportedRatios: ['1:1'],
  pool: 'shared',
    concurrencyCapPerUser: 4,
    maxCountPerBatch: 4,
}];

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function TestWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderSidebar(historyPage: HistoryPage<Batch> = history, hasNextPage = false, options: {
  error?: string;
  isFetchNextPageError?: boolean;
  onLoadMore?: () => void;
} = {}) {
  useAtelierStore.setState({ q: 'portrait', view: { kind: 'unsorted' } });
  globalThis.fetch = mock(() => Response.json({
    items: [{ id: 'collection-1', name: 'Portraits', count: 1, archivedCount: 0, createdAt: 1 }],
    summary: {
      totalCount: 1,
      pinnedCount: 0,
      unsortedCount: 0,
      archivedTotalCount: 0,
      archivedPinnedCount: 0,
      archivedUnsortedCount: 0,
    },
  })) as unknown as typeof fetch;
  return render(
    <Sidebar
      history={historyPage}
      models={models}
      activeBatchId={null}
      historyQ="portrait"
      archivedCount={0}
      hasNextPage={hasNextPage}
      promptsEnabled
      onSelect={mock()}
      onSelectView={mock()}
      onClear={mock()}
      {...options}
    />,
    { wrapper: wrapper() },
  );
}

afterEach(() => {
  cleanup();
  mock.restore();
  window.matchMedia = originalMatchMedia;
  useAtelierStore.setState({ q: '', byokOpen: false });
});

describe('Sidebar landmarks and scroll zones', () => {
  test('keeps loaded rows and the pagination retry when loading an older page fails', () => {
    const onLoadMore = mock();
    renderSidebar({
      items: [{ id: 'batch-1', prompt: 'loaded batch', ratio: '1:1', modelId: 'm', modelLabel: 'M', createdAt: 1, collectionId: null, pinned: false, status: 'done', tiles: [] }],
      nextCursor: 'older',
    }, true, { error: 'History unavailable', isFetchNextPageError: true, onLoadMore });
    expect(screen.getByTestId('sidebar-virtual-list')).toBeTruthy();
    expect(screen.queryByText('History unavailable')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  test('places older-history pagination above the oldest-first virtual list', () => {
    renderSidebar({
      items: [{ id: 'batch-1', prompt: 'oldest', ratio: '1:1', modelId: 'm', modelLabel: 'M', createdAt: 1, collectionId: null, pinned: false, status: 'done', tiles: [] }],
      nextCursor: 'older',
    }, true);
    const list = screen.getByTestId('sidebar-virtual-list');
    const loadMore = screen.getByRole('button', { name: 'Load more' });
    expect(loadMore.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  test('renders scoped header/footer landmarks inside the aside', () => {
    renderSidebar();
    const aside = screen.getByRole('complementary');

    expect(aside.querySelector(':scope > header')).toBeTruthy();
    expect(aside.querySelector(':scope > footer')).toBeTruthy();
  });

  test('tags library and feed scroll zones', () => {
    renderSidebar();
    const aside = screen.getByRole('complementary');

    expect(aside.querySelectorAll('[data-zone="head"]').length).toBeGreaterThanOrEqual(2);
    expect(aside.querySelectorAll('[data-zone="body"]').length).toBeGreaterThanOrEqual(2);
    expect(aside.querySelector('[data-zone="entry"]')).toBeTruthy();
    expect(aside.querySelector('[data-zone="foot"]')).toBeTruthy();
  });

  test('virtualizes long history rails instead of mounting every batch', () => {
    const items = Array.from({ length: 100 }, (_, index): Batch => ({
      id: `batch-${index}`,
      prompt: `Prompt ${index}`,
      ratio: '1:1',
      modelId: 'gpt-image-2.5-sunburst-cloud',
      modelLabel: 'GPT Image 2.5 Sunburst',
      createdAt: index,
      collectionId: null,
      pinned: false,
      status: 'done',
      tiles: [{
        id: `tile-${index}`,
        seed: index,
        status: 'done',
        url: `/img/${index}.png`,
        ext: 'png',
        mime: 'image/png',
        completedAt: index,
      }],
    }));

    renderSidebar({ items, nextCursor: null });

    expect(screen.getAllByRole('button', { name: /Open batch:/ }).length).toBeLessThan(items.length);
    expect(screen.getByTestId('sidebar-virtual-list').style.height).toBe('6200px');
  });

  test('library search input exposes native search ergonomics', () => {
    const { container } = renderSidebar();

    const input = container.querySelector('input[aria-label="Search prompts"]');
    if (!input) throw new Error('Search input missing');
    expect(input.getAttribute('type')).toBe('search');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('enterkeyhint')).toBe('search');
    expect(input.getAttribute('spellcheck')).toBe('false');
  });
});

describe('Sidebar inline edit cancellation', () => {
  test('blurring collection create into Cancel cancels instead of committing', async () => {
    window.matchMedia = mock((query: string) => ({
      matches: query.includes('width < 768px'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }));
    const fetchMock = mock((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/collections')) {
        return Response.json({
          items: [{ id: 'collection-1', name: 'Portraits', count: 1, archivedCount: 0, createdAt: 1 }],
          summary: {
            totalCount: 1,
            pinnedCount: 0,
            unsortedCount: 0,
            archivedTotalCount: 0,
            archivedPinnedCount: 0,
            archivedUnsortedCount: 0,
          },
        });
      }
      throw new Error(`Unexpected ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(
      <Sidebar
        history={history}
        models={models}
        activeBatchId={null}
        historyQ=""
        archivedCount={0}
        promptsEnabled
        onSelect={mock()}
        onSelectView={mock()}
      onClear={mock()}
      />,
      { wrapper: wrapper() },
    );

    fireEvent.click(await screen.findByRole('button', { name: '+ New collection' }));
    const input = screen.getByLabelText('Collection name');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Draft collection' } });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel.getAttribute('data-cancel-inline')).toBe('true');

    fireEvent.focusOut(input, { relatedTarget: cancel });
    fireEvent.click(cancel);

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(postCalls).toHaveLength(0);
    });
  });
});
