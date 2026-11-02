import type { LibraryCoverageResponse, PromptLibraryResponse } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { libraryCoverageKeys } from '../../api/libraryCoverage';
import { promptKeys } from '../../api/prompts';
import { useAtelierStore } from '../../store/atelier';
import PromptManager from './index';

const library: PromptLibraryResponse = { templates: [], variableLists: [], dimensions: [] };

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderWithCoverage(report: LibraryCoverageResponse) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(promptKeys.library(), library);
  client.setQueryData(libraryCoverageKeys.current(), report);
  globalThis.fetch = mock(() => Response.json(library)) as unknown as typeof fetch;
  useAtelierStore.setState({ promptManagerTab: 'dimensions' });
  return render(<PromptManager onBack={() => undefined} />, { wrapper: wrapper(client) });
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ promptManagerTab: 'templates', toasts: [] });
});

describe('PromptManager coverage surfacing', () => {
  test('pending badge shows the untagged count and opens the card', async () => {
    renderWithCoverage({
      untaggedByList: [{ listId: 'L1', listName: 'fantasy_role', dim: 'Genre', untaggedCount: 4 }],
      lowCoverageLists: [], orphanTags: [], missingDimensions: [],
      librarySnapshotHash: 'h', templatesDigest: 'd',
    });
    const badge = await screen.findByRole('button', { name: /coverage/i });
    expect(badge.textContent).toContain('4');
    expect(badge.className).not.toContain('Danger');
    fireEvent.click(badge);
    await waitFor(() => { expect(screen.getByText(/fantasy_role/)).toBeTruthy(); });
  });

  test('healthy badge reads ✓ Coverage and is calm (--ink-3)', async () => {
    renderWithCoverage({
      untaggedByList: [], lowCoverageLists: [], orphanTags: [], missingDimensions: [],
      librarySnapshotHash: 'h', templatesDigest: 'd',
    });
    const badge = await screen.findByRole('button', { name: /coverage/i });
    expect(badge.textContent).toMatch(/Coverage/);
    expect(badge.getAttribute('data-coverage')).toBe('healthy');
  });

  test('dimension-row roving (Arrow keys) still works with the badge present', async () => {
    // The badge sits OUTSIDE the roving <aside>; arrow navigation across
    // dimension rows must be unaffected. Seed two dimensions in the library.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const libWithDims: PromptLibraryResponse = {
      templates: [],
      variableLists: [],
      dimensions: [
        { id: 'd1', name: 'Alpha', tags: [] },
        { id: 'd2', name: 'Beta', tags: [] },
      ],
    };
    client.setQueryData(promptKeys.library(), libWithDims);
    client.setQueryData(libraryCoverageKeys.current(), {
      untaggedByList: [], lowCoverageLists: [], orphanTags: [], missingDimensions: [],
      librarySnapshotHash: 'h', templatesDigest: 'd',
    });
    globalThis.fetch = mock(() => Response.json(libWithDims)) as unknown as typeof fetch;
    useAtelierStore.setState({ promptManagerTab: 'dimensions' });
    render(<PromptManager onBack={() => undefined} />, { wrapper: wrapper(client) });

    const alpha = await screen.findByRole('button', { name: /Edit dimension Alpha/i });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowDown' });
    // Roving focus is deferred via queueMicrotask (runWhenReachable); flush it.
    await Promise.resolve();
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const beta = screen.getByRole('button', { name: /Edit dimension Beta/i });
    expect(document.activeElement).toBe(beta);
  });
});
