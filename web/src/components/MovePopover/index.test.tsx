import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { allDoneBatch } from '../../../test/fixtures/batches';
import MovePopover from './index';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  mock.restore();
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
    fireEvent.click(screen.getByRole('button', { name: '+ New collection' }));

    expect(screen.queryByRole('textbox', { name: 'Collection name' })).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
  });
});
