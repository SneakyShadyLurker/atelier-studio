import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import App from './App';
import { promptKeys } from './api/prompts';
import { fixtureModels } from '../test/fixtures/models';
import { historyFixture } from '../test/fixtures/batches';
import { useAtelierStore } from './store/atelier';

const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia.bind(window);

afterEach(() => {
  cleanup();
  useAtelierStore.setState({ saveTemplatePrompt: null });
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
});

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

function wrapper(client: QueryClient) {
  return function W({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('App save-to-templates wiring', () => {
  test('clicking the batch button opens SaveTemplateDialog with the prompt', async () => {
    installMatchMedia();
    window.history.replaceState({}, '', '/');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), { templates: [], variableLists: [], dimensions: [] });
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/models')) return Response.json(fixtureModels);
      if (url.includes('/history')) return Response.json(historyFixture);
      if (url.includes('/collections')) {
        return Response.json({ items: [], summary: { totalCount: historyFixture.items.length, pinnedCount: 0, unsortedCount: historyFixture.items.length, archivedTotalCount: 0, archivedPinnedCount: 0, archivedUnsortedCount: 0 } });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    render(<App />, { wrapper: wrapper(client) });

    // Save to templates is now in the overflow menu — open More then click the menuitem
    const moreBtns = await screen.findAllByRole('button', { name: /more actions/i });
    const firstMoreBtn = moreBtns[0];
    if (!firstMoreBtn) throw new Error('no More actions button rendered');
    fireEvent.click(firstMoreBtn);
    const saveItem = screen.getByRole('menuitem', { name: /save to templates/i });
    fireEvent.click(saveItem);

    // The fixture is in WIRE order (newest first); the feed renders oldest
    // first, so the first "More actions" button belongs to the LAST fixture item.
    const firstRendered = historyFixture.items.at(-1);
    if (!firstRendered) throw new Error('history fixture has no batches');
    await waitFor(() => {
      expect(useAtelierStore.getState().saveTemplatePrompt).toBe(firstRendered.prompt);
    });
    expect(await screen.findByRole('dialog', { name: 'Save prompt as template' })).toBeTruthy();
    expect(screen.getByText('Save prompt as template')).toBeTruthy();
  });
});
