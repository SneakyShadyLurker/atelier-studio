import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import type { Batch, Model, Tile } from '@atelier/shared';
import { initialAtelierState, useAtelierStore } from '../store/atelier';

let resolveHandoff: ((value: { uploadId: string }) => void) | undefined;
let rejectHandoff: ((reason: unknown) => void) | undefined;
let capturedSignal: AbortSignal | undefined;
let handoffCalls: { tileId: string; resolve: (value: { uploadId: string }) => void; reject: (reason: unknown) => void }[] = [];
const handoffMock = mock((tileId: string, signal?: AbortSignal) => new Promise<{ uploadId: string }>((resolve, reject) => {
  capturedSignal = signal;
  resolveHandoff = resolve;
  rejectHandoff = reject;
  handoffCalls.push({ tileId, resolve, reject });
  signal?.addEventListener('abort', () => {
    reject(signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError'));
  }, { once: true });
}));
void mock.module('../api/sequences', () => ({ createHandoffFrame: handoffMock }));

const { useExtendFromTile } = await import('./useExtendFromTile');
const { supersedeSourceHandoffs } = await import('../lib/composerSourceHandoff');

const tile = {
  id: 'video-1', seed: 1, status: 'done', url: '/api/img/video-1', ext: 'mp4', mime: 'video/mp4', completedAt: 1,
} satisfies Extract<Tile, { status: 'done' }>;
const batch = {
  id: 'batch-1', prompt: 'slow orbit around the dancer', ratio: '16:9', modelId: 'minimax-h3-i2v', modelLabel: 'MiniMax H3 I2V',
  createdAt: 1, collectionId: null, pinned: false, status: 'done', tiles: [tile],
} satisfies Batch;
const model = { id: 'minimax-h3-i2v', supportsI2V: true } as Model;

beforeEach(() => {
  useAtelierStore.setState(initialAtelierState, true);
  handoffMock.mockClear();
  capturedSignal = undefined;
  resolveHandoff = undefined;
  rejectHandoff = undefined;
  handoffCalls = [];
});

afterEach(() => {
  mock.restore();
});

describe('useExtendFromTile lifecycle', () => {
  test('owns pending state, ignores duplicate clicks, then opens the extend draft', async () => {
    const { result } = renderHook(() => useExtendFromTile());
    let first: Promise<boolean> | undefined;
    await act(async () => {
      first = result.current.extendFromTile(batch, tile, model);
      expect(result.current.pendingTileId).toBe(null);
      await Promise.resolve();
    });
    expect(result.current.pendingTileId).toBe(tile.id);
    await act(async () => {
      expect(await result.current.extendFromTile(batch, tile, model)).toBe(false);
    });
    expect(handoffMock).toHaveBeenCalledTimes(1);
    await act(async () => { resolveHandoff?.({ uploadId: 'handoff-1' }); await first; });
    expect(result.current.pendingTileId).toBe(null);
    expect(useAtelierStore.getState().draft).toMatchObject({
      modelId: model.id,
      ratio: '16:9',
      i2vSourceUploadId: 'handoff-1',
      extendsTileId: tile.id,
      extendPrevPrompt: batch.prompt,
    });
  });

  test('aborts the handoff request on unmount without a toast', async () => {
    const { result, unmount } = renderHook(() => useExtendFromTile());
    await act(async () => {
      void result.current.extendFromTile(batch, tile, model);
      await Promise.resolve();
    });
    unmount();
    expect(capturedSignal?.aborted).toBe(true);
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });

  test('an Extend in another batch view supersedes a slower one in flight', async () => {
    const otherTile = { ...tile, id: 'video-2' };
    const otherBatch = { ...batch, id: 'batch-2', prompt: 'the dancer bows', tiles: [otherTile] };
    const { result } = renderHook(() => [useExtendFromTile(), useExtendFromTile()] as const);
    let slow: Promise<boolean> = Promise.resolve(true);
    let fast: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      slow = result.current[0].extendFromTile(batch, tile, model);
      fast = result.current[1].extendFromTile(otherBatch, otherTile, model);
      await Promise.resolve();
    });
    expect(handoffCalls.map((call) => call.tileId)).toEqual(['video-1', 'video-2']);
    await act(async () => {
      handoffCalls[1]?.resolve({ uploadId: 'handoff-2' });
      expect(await fast).toBe(true);
    });
    useAtelierStore.getState().setDraft({ motionPrompt: 'she rises' });
    await act(async () => {
      handoffCalls[0]?.resolve({ uploadId: 'handoff-1' });
      expect(await slow).toBe(false);
    });
    expect(result.current[0].pendingTileId).toBe(null);
    expect(useAtelierStore.getState().draft).toMatchObject({
      i2vSourceUploadId: 'handoff-2',
      extendsTileId: 'video-2',
      extendPrevPrompt: 'the dancer bows',
      motionPrompt: 'she rises',
    });
  });

  test('a superseded Extend that fails stays silent', async () => {
    const { result } = renderHook(() => useExtendFromTile());
    let pending: Promise<boolean> = Promise.resolve(true);
    await act(async () => { pending = result.current.extendFromTile(batch, tile, model); await Promise.resolve(); });
    supersedeSourceHandoffs();
    await act(async () => { rejectHandoff?.(new Error('ffmpeg')); expect(await pending).toBe(false); });
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });

  test('returns to rest and shows the existing error toast on failure', async () => {
    const { result } = renderHook(() => useExtendFromTile());
    let pending: Promise<boolean> | undefined;
    await act(async () => { pending = result.current.extendFromTile(batch, tile, model); await Promise.resolve(); });
    await act(async () => { rejectHandoff?.(new Error('ffmpeg')); await pending; });
    expect(result.current.pendingTileId).toBe(null);
    expect(useAtelierStore.getState().toasts.at(-1)?.text).toBe('Extend failed.');
  });
});
