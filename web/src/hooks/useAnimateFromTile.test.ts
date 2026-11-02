import { describe, expect, mock, test } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import type { Model, Tile } from '@atelier/shared';
import { toGenerateRequest, useAtelierStore } from '../store/atelier';

// Mock the network + blob deps before the hook module loads (mock.module is not
// auto-hoisted in bun).
const uploadMock = mock(() => Promise.resolve({ id: 'upload-1' }));
void mock.module('../api/uploads', () => ({ uploadRefImage: uploadMock }));

const fetchBlobMock = mock(() => Promise.resolve(new Blob(['x'], { type: 'image/png' })));
const realImages = await import('../api/images');
void mock.module('../api/images', () => ({ ...realImages, fetchImageBlob: fetchBlobMock }));

const { useAnimateFromTile } = await import('./useAnimateFromTile');
const { supersedeSourceHandoffs } = await import('../lib/composerSourceHandoff');

function deferredUpload() {
  let resolve: (value: { id: string }) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<{ id: string }>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

const doneTile = { id: 'tile-1', ext: 'png', mime: 'image/png', status: 'done' } as unknown as Extract<
  Tile,
  { status: 'done' }
>;
const videoModel = { id: 'minimax-h3-i2v' } as unknown as Model;

describe('useAnimateFromTile source-prompt plumbing', () => {
  test('captures sourcePrompt into the draft when provided', async () => {
    const { result } = renderHook(() => useAnimateFromTile());
    await act(async () => {
      await result.current(doneTile, videoModel, { sourcePrompt: 'a redhead dancer in a red dress' });
    });
    const draft = useAtelierStore.getState().draft;
    expect(draft.i2vSourcePrompt).toBe('a redhead dancer in a red dress');
    expect(draft.i2vSourceUploadId).toBe('upload-1');
    expect(draft.modelId).toBe('minimax-h3-i2v');
  });

  test('leaves i2vSourcePrompt undefined when no sourcePrompt is given (no leak from a prior animate)', async () => {
    const { result } = renderHook(() => useAnimateFromTile());
    await act(async () => {
      await result.current(doneTile, videoModel);
    });
    expect(useAtelierStore.getState().draft.i2vSourcePrompt).toBeUndefined();
  });
});

describe('useAnimateFromTile source-ratio plumbing', () => {
  test('adopts the source still\'s ratio so the composer does not fall back to 1:1', async () => {
    useAtelierStore.getState().setDraft({ ratio: null });
    const { result } = renderHook(() => useAnimateFromTile());
    await act(async () => {
      await result.current(doneTile, videoModel, { ratio: '16:9' });
    });
    expect(useAtelierStore.getState().draft.ratio).toBe('16:9');
  });

  test('keeps the current draft ratio when the caller supplies none', async () => {
    useAtelierStore.getState().setDraft({ ratio: '9:16' });
    const { result } = renderHook(() => useAnimateFromTile());
    await act(async () => {
      await result.current(doneTile, videoModel);
    });
    expect(useAtelierStore.getState().draft.ratio).toBe('9:16');
  });
});

describe('useAnimateFromTile last intent wins', () => {
  test('a slow earlier Animate cannot replace a newer source or the motion typed for it', async () => {
    useAtelierStore.setState({ toasts: [] });
    const slow = deferredUpload();
    const fast = deferredUpload();
    uploadMock.mockImplementationOnce(() => slow.promise).mockImplementationOnce(() => fast.promise);
    const { result } = renderHook(() => useAnimateFromTile());

    let first: Promise<boolean> = Promise.resolve(true);
    let second: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      first = result.current(doneTile, videoModel, { sourcePrompt: 'tile A' });
      second = result.current(doneTile, videoModel, { sourcePrompt: 'tile B' });
      fast.resolve({ id: 'upload-b' });
      expect(await second).toBe(true);
    });
    useAtelierStore.getState().setDraft({ motionPrompt: 'B turns to camera' });

    await act(async () => {
      slow.resolve({ id: 'upload-a' });
      expect(await first).toBe(false);
    });
    const draft = useAtelierStore.getState().draft;
    expect(draft.i2vSourceUploadId).toBe('upload-b');
    expect(draft.i2vSourcePrompt).toBe('tile B');
    expect(draft.motionPrompt).toBe('B turns to camera');
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });

  test('a composer source change supersedes a pending Animate, including its failure toast', async () => {
    useAtelierStore.setState({ toasts: [] });
    useAtelierStore.getState().setDraft({ i2vSourceUploadId: 'manual-source', motionPrompt: undefined });
    const pending = deferredUpload();
    uploadMock.mockImplementationOnce(() => pending.promise);
    const { result } = renderHook(() => useAnimateFromTile());

    let animate: Promise<boolean> = Promise.resolve(true);
    act(() => { animate = result.current(doneTile, videoModel); });
    supersedeSourceHandoffs();
    await act(async () => {
      pending.reject(new Error('upload failed'));
      expect(await animate).toBe(false);
    });
    expect(useAtelierStore.getState().draft.i2vSourceUploadId).toBe('manual-source');
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });

  test('motion text typed while the only Animate is pending survives the handoff', async () => {
    useAtelierStore.getState().setDraft({ motionPrompt: 'old motion' });
    const pending = deferredUpload();
    uploadMock.mockImplementationOnce(() => pending.promise);
    const { result } = renderHook(() => useAnimateFromTile());

    let animate: Promise<boolean> = Promise.resolve(false);
    act(() => { animate = result.current(doneTile, videoModel); });
    useAtelierStore.getState().setDraft({ motionPrompt: 'typed while uploading' });
    await act(async () => {
      pending.resolve({ id: 'upload-typed' });
      expect(await animate).toBe(true);
    });
    expect(useAtelierStore.getState().draft).toMatchObject({
      i2vSourceUploadId: 'upload-typed',
      motionPrompt: 'typed while uploading',
    });
  });
});

describe('useAnimateFromTile after an Extend', () => {
  const extendDraft = {
    modelId: 'minimax-h3-i2v',
    i2vSourceUploadId: 'handoff-1',
    i2vSourcePrompt: undefined,
    motionPrompt: 'she keeps walking',
    extendsTileId: 'prev-video-tile',
    extendPrevPrompt: 'she walks toward the camera',
  };

  test('a fresh Animate drops the prior Extend link, previous prompt and motion text', async () => {
    useAtelierStore.getState().setDraft(extendDraft);
    const { result } = renderHook(() => useAnimateFromTile());
    await act(async () => {
      await result.current(doneTile, videoModel, { sourcePrompt: 'a still of a dancer', ratio: '16:9' });
    });
    const draft = useAtelierStore.getState().draft;
    expect(draft.extendsTileId).toBeUndefined();
    expect(draft.extendPrevPrompt).toBeUndefined();
    expect(draft.motionPrompt).toBeUndefined();
    expect(draft.i2vSourceUploadId).toBe('upload-1');
    expect(draft.i2vSourcePrompt).toBe('a still of a dancer');
    expect(draft.ratio).toBe('16:9');

    // The outgoing request is a plain I2V render, not a continuation.
    useAtelierStore.getState().setDraft({ motionPrompt: 'she spins' });
    const i2vModel = { id: 'minimax-h3-i2v', supportsI2V: true } as unknown as Model;
    const request = toGenerateRequest(useAtelierStore.getState().draft, i2vModel.id, '16:9', i2vModel);
    expect(request.extendsTileId).toBeUndefined();
    expect(request.i2vSourceUploadId).toBe('upload-1');
    expect(request.motionPrompt).toBe('she spins');
    expect(request.prompt).toBe('she spins');
  });

  test('a failed upload leaves the Extend draft untouched and toasts', async () => {
    useAtelierStore.setState({ toasts: [] });
    useAtelierStore.getState().setDraft(extendDraft);
    uploadMock.mockImplementationOnce(() => Promise.reject(new Error('upload failed')));
    const { result } = renderHook(() => useAnimateFromTile());
    let ok = true;
    await act(async () => {
      ok = await result.current(doneTile, videoModel);
    });
    expect(ok).toBe(false);
    const draft = useAtelierStore.getState().draft;
    expect(draft.extendsTileId).toBe('prev-video-tile');
    expect(draft.extendPrevPrompt).toBe('she walks toward the camera');
    expect(draft.motionPrompt).toBe('she keeps walking');
    expect(draft.i2vSourceUploadId).toBe('handoff-1');
    expect(useAtelierStore.getState().toasts).toHaveLength(1);
  });
});
