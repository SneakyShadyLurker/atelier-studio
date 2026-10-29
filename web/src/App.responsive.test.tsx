import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import App from './App';
import { fixtureModels } from '../test/fixtures/models';
import { historyFixture } from '../test/fixtures/batches';
import { APP_VIEW_UNSORTED, useAtelierStore } from './store/atelier';

const originalMatchMedia = window.matchMedia.bind(window);
const originalRequestAnimationFrame = window.requestAnimationFrame.bind(window);
const scrollToDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo');

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

function installMatchMedia(phone: boolean, reducedMotion = false): void {
  window.matchMedia = mock((query: string) => ({
    matches: (phone && query.includes('width < 768px')) || (reducedMotion && query.includes('prefers-reduced-motion')),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  }));
}

function installUrl(): void {
  if (window.location.origin === 'null') window.location.href = 'http://localhost/';
  window.history.replaceState({}, '', 'http://localhost/');
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderApp({ phone = false, reducedMotion = false }: { phone?: boolean; reducedMotion?: boolean } = {}) {
  installMatchMedia(phone, reducedMotion);
  installUrl();
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.endsWith('/models')) return Response.json(fixtureModels);
    if (url.endsWith('/collections')) return Response.json(collectionResponse());
    if (url.includes('/history')) return Response.json(historyFixture);
    if (url.includes('/archive')) return Response.json({ items: [], nextCursor: null, total: 0 });
    if (url.endsWith('/prompts')) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    return Response.json({});
  }) as unknown as typeof fetch;
  return render(<App />, { wrapper: wrapper(client) });
}

afterEach(() => {
  cleanup();
  mock.restore();
  window.localStorage.removeItem('atelier.sidebarCollapsed');
  window.matchMedia = originalMatchMedia;
  window.requestAnimationFrame = originalRequestAnimationFrame;
  if (scrollToDescriptor) Object.defineProperty(Element.prototype, 'scrollTo', scrollToDescriptor);
  installUrl();
  useAtelierStore.setState({
    view: APP_VIEW_UNSORTED,
    q: '',
    draft: { prompt: '', modelId: '', ratio: '1:1', durationFrames: null, count: 2, refImages: [], rollQueue: [] },
    sidebarOpen: false,
    composerExpanded: false,
    lightbox: null,
    toasts: [],
  });
});

describe('App phone composer scrim', () => {
  test('expanding the phone composer renders a scrim and inerts the feed', async () => {
    renderApp({ phone: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Expand composer' }));
    expect(screen.getByTestId('composer-scrim')).toBeDefined();
    expect(screen.getByTestId('feed').hasAttribute('inert')).toBe(true);
    const scrim = screen.getByTestId('composer-scrim');
    expect(scrim.getAttribute('aria-hidden')).toBe('true');
    expect(scrim.getAttribute('tabindex')).toBe('-1');
    expect(screen.getAllByRole('button', { name: 'Collapse composer' })).toHaveLength(1);
  });

  test('tapping the scrim collapses the composer', async () => {
    renderApp({ phone: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Expand composer' }));
    fireEvent.click(screen.getByTestId('composer-scrim'));
    await waitFor(() => {
      expect(useAtelierStore.getState().composerExpanded).toBe(false);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Expand composer' }));
    });
  });
});

describe('App phone drawer focus', () => {
  test('opening the drawer focuses the visible close control', async () => {
    renderApp({ phone: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close menu' }));
    });
  });
});

describe('App collapsible sidebar', () => {
  test('the collapse chevron collapses the layout', async () => {
    renderApp();
    await screen.findByText('Atelier', { selector: 'div' });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    await waitFor(() => {
      expect(document.querySelector('[data-sidebar-collapsed="true"]')).not.toBeNull();
    });
  });

  test('the hamburger re-expands a collapsed sidebar on desktop', async () => {
    renderApp();
    await screen.findByText('Atelier', { selector: 'div' });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    await waitFor(() => {
      expect(document.querySelector('[data-sidebar-collapsed="true"]')).not.toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    await waitFor(() => {
      expect(document.querySelector('[data-sidebar-collapsed="true"]')).toBeNull();
    });
  });

  test('collapsing the sidebar moves focus to the hamburger', async () => {
    renderApp();
    await screen.findByText('Atelier', { selector: 'div' });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Expand sidebar' }));
    });
  });
});

describe('App batch navigation motion', () => {
  test('uses auto scroll behavior when reduced motion is preferred', async () => {
    window.requestAnimationFrame = mock((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    renderApp({ reducedMotion: true });
    await screen.findByText('Atelier', { selector: 'div' });

    const target = (await screen.findAllByRole('button', { name: /Open batch:/ }))[0];
    if (!target) throw new Error('expected a batch trigger');
    // The feed virtualizer owns the scroll: it drives the scroller directly.
    const scrollTo = mock(() => undefined);
    Element.prototype.scrollTo = scrollTo;

    fireEvent.click(target);

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
    });
    expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
  });
});
