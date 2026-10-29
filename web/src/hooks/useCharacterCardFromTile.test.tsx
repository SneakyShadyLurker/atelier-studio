import type { Tile } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { allDoneBatch } from '../../test/fixtures/batches';
import { ephemeraKeys } from '../api/ephemera';
import { initialAtelierState, useAtelierStore } from '../store/atelier';
import { CARD_CLIENT_GRACE_MS, pendingCardRequest, useCharacterCardFromTile } from './useCharacterCardFromTile';
import { useEphemera } from './useEphemera';

const origin = 'https://ephemera.example';
const tile = allDoneBatch.tiles.find((candidate): candidate is Extract<Tile, { status: 'done' }> => candidate.status === 'done');
if (!tile) throw new Error('done tile fixture is required');
const cardPath = `/api/tiles/${tile.id}/character-card`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const originalFetch = globalThis.fetch;

function wrapper(timeoutMs = 540_000) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The hook reads the origin and timeout from the probe's cache; seed it so
  // the test exercises the gate without a probe request.
  client.setQueryData(ephemeraKeys.status(), { origin, timeoutMs });
  return function TestWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function sseResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function resultFrame(url: string): string {
  return `event: status\ndata: {"phase":"reading"}\n\nevent: result\ndata: ${JSON.stringify({ characterId: 'c-1', name: 'Mara Voss', url })}\n\n`;
}

function cardCalls(fetchMock: ReturnType<typeof mock>): number {
  return fetchMock.mock.calls.filter(([input]) => input === cardPath).length;
}

function sentBodies(fetchMock: ReturnType<typeof mock>): { characterId: unknown; direction?: unknown; kind?: unknown }[] {
  return (fetchMock.mock.calls as unknown as [string, RequestInit][])
    .filter(([input]) => input === cardPath)
    .map(([, init]) => JSON.parse(init.body as string) as { characterId: unknown; direction?: unknown; kind?: unknown });
}

function sentCharacterIds(fetchMock: ReturnType<typeof mock>): unknown[] {
  return sentBodies(fetchMock).map((body) => body.characterId);
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  mock.restore();
  useAtelierStore.setState(initialAtelierState, true);
});

describe('useCharacterCardFromTile', () => {
  test('success shows a toast whose action opens the character in Ephemera', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseResponse(resultFrame(`${origin}/characters/c-1`)))) as unknown as typeof fetch;
    const openMock = spyOn(window, 'open').mockImplementation(() => null);
    const { result } = renderHook(() => useCharacterCardFromTile(), { wrapper: wrapper() });

    let ok = false;
    await act(async () => { ok = await result.current(tile); });

    expect(ok).toBe(true);
    const toast = useAtelierStore.getState().toasts.at(-1);
    expect(toast?.text).toBe('Character card saved to Ephemera: Mara Voss.');
    expect(toast?.tone).toBe('success');
    expect(toast?.action?.label).toBe('Open in Ephemera');
    toast?.action?.onClick();
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledWith(`${origin}/characters/c-1`, '_blank', 'noopener,noreferrer');
  });

  test('a url outside the Ephemera origin is never opened', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseResponse(resultFrame('https://ephemera.example.evil.test/characters/c-1')))) as unknown as typeof fetch;
    const openMock = spyOn(window, 'open').mockImplementation(() => null);
    const { result } = renderHook(() => useCharacterCardFromTile(), { wrapper: wrapper() });

    await act(async () => { await result.current(tile); });

    useAtelierStore.getState().toasts.at(-1)?.action?.onClick();
    expect(openMock).not.toHaveBeenCalled();
  });

  test('an error frame shows its message as an error toast and resolves false', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseResponse(
      'event: error\ndata: {"message":"Ephemera is writing another card. Try again in a moment.","code":"ephemera-busy"}\n\n',
    ))) as unknown as typeof fetch;
    const { result } = renderHook(() => useCharacterCardFromTile(), { wrapper: wrapper() });

    let ok = true;
    await act(async () => { ok = await result.current(tile); });

    expect(ok).toBe(false);
    const toast = useAtelierStore.getState().toasts.at(-1);
    expect(toast?.text).toBe('Ephemera is writing another card. Try again in a moment.');
    expect(toast?.tone).toBe('error');
    expect(useAtelierStore.getState().cardPendingTileIds.has(tile.id)).toBe(false);
  });

  test('a second call for a pending tile resolves false without a request', async () => {
    let release: ((response: Response) => void) | undefined;
    const fetchMock = mock(() => new Promise<Response>((resolve) => { release = resolve; }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useCharacterCardFromTile(), { wrapper: wrapper() });

    let first: Promise<boolean> = Promise.resolve(false);
    act(() => { first = result.current(tile); });
    await waitFor(() => { expect(cardCalls(fetchMock)).toBe(1); });
    expect(useAtelierStore.getState().cardPendingTileIds.has(tile.id)).toBe(true);

    let second = true;
    await act(async () => { second = await result.current(tile); });
    expect(second).toBe(false);
    expect(cardCalls(fetchMock)).toBe(1);
    expect(useAtelierStore.getState().cardPendingTileIds.has(tile.id)).toBe(true);

    await act(async () => {
      release?.(sseResponse(resultFrame(`${origin}/characters/c-1`)));
      expect(await first).toBe(true);
    });
    expect(useAtelierStore.getState().cardPendingTileIds.has(tile.id)).toBe(false);
  });

  test('a failed attempt keeps the tile id for the retry; a result clears it', async () => {
    const answers = [
      'event: error\ndata: {"message":"Couldn\'t create the card. Please try again.","code":"card-failed"}\n\n',
      resultFrame(`${origin}/characters/c-1`),
      resultFrame(`${origin}/characters/c-1`),
    ];
    const fetchMock = mock(() => Promise.resolve(sseResponse(answers.shift() ?? '')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useCharacterCardFromTile(), { wrapper: wrapper() });

    const outcomes: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      await act(async () => { outcomes.push(await result.current(tile)); });
    }

    expect(outcomes).toEqual([false, true, true]);
    const [failed, retried, fresh] = sentCharacterIds(fetchMock);
    expect(failed).toMatch(UUID_PATTERN);
    expect(retried).toBe(failed);
    expect(fresh).toMatch(UUID_PATTERN);
    expect(fresh).not.toBe(retried);
  });

  test('a retry keeps its id only while the direction is unchanged, and the pending direction is remembered', async () => {
    const failure = 'event: error\ndata: {"message":"Couldn\'t create the card. Please try again.","code":"card-failed"}\n\n';
    const answers = [failure, failure, resultFrame(`${origin}/characters/c-1`)];
    const fetchMock = mock(() => Promise.resolve(sseResponse(answers.shift() ?? '')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useCharacterCardFromTile(), { wrapper: wrapper() });

    await act(async () => { await result.current(tile, 'a sea captain'); });
    expect(pendingCardRequest(tile.id)).toEqual({ direction: 'a sea captain', kind: 'subject' });
    await act(async () => { await result.current(tile, '  a sea captain  '); });
    await act(async () => { await result.current(tile, 'a lighthouse keeper'); });
    expect(pendingCardRequest(tile.id)).toEqual({ direction: '', kind: 'subject' });

    const [first, same, changed] = sentBodies(fetchMock);
    expect(first).toEqual({ characterId: expect.stringMatching(UUID_PATTERN), direction: 'a sea captain', kind: 'subject' });
    expect(same).toEqual({ characterId: first?.characterId, direction: 'a sea captain', kind: 'subject' });
    expect(changed?.direction).toBe('a lighthouse keeper');
    expect(changed?.characterId).not.toBe(first?.characterId);
  });

  test('a retry keeps its id only while the kind is unchanged, and the pending kind is remembered', async () => {
    const failure = 'event: error\ndata: {"message":"Couldn\'t create the card. Please try again.","code":"card-failed"}\n\n';
    const answers = [failure, failure, failure];
    const fetchMock = mock(() => Promise.resolve(sseResponse(answers.shift() ?? '')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useCharacterCardFromTile(), { wrapper: wrapper() });

    await act(async () => { await result.current(tile, 'two sisters', 'group'); });
    expect(pendingCardRequest(tile.id)).toEqual({ direction: 'two sisters', kind: 'group' });
    await act(async () => { await result.current(tile, 'two sisters', 'group'); });
    await act(async () => { await result.current(tile, 'two sisters', 'scenario'); });
    expect(pendingCardRequest(tile.id)).toEqual({ direction: 'two sisters', kind: 'scenario' });

    const [first, same, changed] = sentBodies(fetchMock);
    expect(first).toEqual({ characterId: expect.stringMatching(UUID_PATTERN), direction: 'two sisters', kind: 'group' });
    expect(same?.characterId).toBe(first?.characterId);
    expect(changed?.kind).toBe('scenario');
    expect(changed?.characterId).toMatch(UUID_PATTERN);
    expect(changed?.characterId).not.toBe(first?.characterId);
  });

  test('a stalled stream is aborted after the server timeout plus grace and clears pending', async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchMock = mock((_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      seenSignal = init?.signal ?? undefined;
      seenSignal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); });
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useCharacterCardFromTile(), { wrapper: wrapper(20 - CARD_CLIENT_GRACE_MS) });

    let ok = true;
    await act(async () => { ok = await result.current(tile); });

    expect(ok).toBe(false);
    expect(seenSignal?.aborted).toBe(true);
    expect(useAtelierStore.getState().cardPendingTileIds.has(tile.id)).toBe(false);
    const toast = useAtelierStore.getState().toasts.at(-1);
    expect(toast?.text).toBe(
      'Writing the card took too long. It may already be saved; clicking again finds it instead of making a duplicate.',
    );
    expect(toast?.tone).toBe('error');
  });

  test('a pre-stream 404 shows card copy and re-probes so the action hides', async () => {
    const fetchMock = mock((_input: string) => Promise.resolve(Response.json({ error: 'not found' }, { status: 404 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(
      () => ({ create: useCharacterCardFromTile(), ephemera: useEphemera() }),
      { wrapper: wrapper() },
    );
    expect(result.current.ephemera.enabled).toBe(true);

    let ok = true;
    await act(async () => { ok = await result.current.create(tile); });

    expect(ok).toBe(false);
    const toast = useAtelierStore.getState().toasts.at(-1);
    expect(toast?.text).toBe('Character cards are not available for this image right now.');
    expect(toast?.tone).toBe('error');
    await waitFor(() => { expect(result.current.ephemera.enabled).toBe(false); });
    expect(fetchMock.mock.calls.some(([input]) => input.endsWith('/api/ephemera'))).toBe(true);
  });
});
