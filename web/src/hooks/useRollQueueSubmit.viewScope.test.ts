import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import type { AiFillBatchRequest, AiFillRequest, GenerateRequest, Model, TagDimension, VariableList } from '@atelier/shared';
import { APP_VIEW_PROMPTS, APP_VIEW_UNSORTED, collectionView, initialAtelierState, useAtelierStore } from '../store/atelier';

// Hand-resolved ai-fill so a submit can be parked mid-flight while the test
// navigates the user somewhere else — the exact window in which a burst of
// queued rolls used to yank the view back to the feed.
let releaseFill: (() => void) | null = null;
const resolveAiFillMock = mock((req: AiFillRequest) => new Promise<{ prompt: string; fills: string[] }>((resolve) => {
  releaseFill = () => { resolve({ prompt: req.staticSegments.join('FILLED'), fills: req.instructions.map(() => 'FILLED') }); };
}));
const resolveAiFillBatchMock = mock((req: AiFillBatchRequest) => new Promise<{
  items: { ok: true; prompt: string; fills: string[] }[];
}>((resolve) => {
  releaseFill = () => {
    resolve({
      items: req.items.map((item) => ({
        ok: true,
        prompt: item.staticSegments.join('FILLED'),
        fills: item.instructions.map(() => 'FILLED'),
      })),
    });
  };
}));
void mock.module('../api/aiFill', () => ({
  resolveAiFill: resolveAiFillMock,
  resolveAiFillBatch: resolveAiFillBatchMock,
}));

const { useRollQueueSubmit } = await import('./useRollQueueSubmit');

const model = { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', pool: 'shared', backend: 'cloud', supportsReferenceImages: false } as unknown as Model;
const emptyLib: { variableLists: readonly VariableList[]; dimensions: readonly TagDimension[] } = { variableLists: [], dimensions: [] };

function setup(opts: { prompt?: string; rollQueue?: { id: string; text: string; seed: number; source: 'template' }[] }) {
  const generate = mock((_req: GenerateRequest) => Promise.resolve());
  useAtelierStore.getState().setDraft({ prompt: opts.prompt ?? '' });
  for (const r of opts.rollQueue ?? []) useAtelierStore.getState().stashRoll(r);
  const { result } = renderHook(() => useRollQueueSubmit({
    draft: useAtelierStore.getState().draft,
    effectiveModel: model, effectiveRatio: '1:1', effectiveDuration: undefined,
    generate, fireGenerate: () => undefined,
    addToast: () => '',
    setComposerExpanded: () => undefined,
    library: emptyLib, libraryPending: false,
  }));
  return { generate, submitDraft: result.current.submitDraft };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40 && useAtelierStore.getState().draining; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 0));
}

describe('useRollQueueSubmit — feed scope pinning follows the user, not the fire', () => {
  beforeEach(() => {
    useAtelierStore.setState(initialAtelierState, true);
    releaseFill = null;
    resolveAiFillMock.mockClear();
    resolveAiFillBatchMock.mockClear();
  });

  test('a fire from the view the user pressed Generate in still pins the feed to Unsorted', async () => {
    useAtelierStore.getState().setView(collectionView('col-1'));
    const h = setup({ prompt: 'a {{ai-fill: x}} b' });
    await act(async () => {
      h.submitDraft();
      await new Promise((r) => setTimeout(r, 310));
      releaseFill?.();
      await settle();
    });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(useAtelierStore.getState().view).toEqual(APP_VIEW_UNSORTED);
  });

  test('a fire that lands after the user opened the Prompt Library leaves them there', async () => {
    const h = setup({ prompt: 'a {{ai-fill: x}} b' });
    await act(async () => {
      h.submitDraft();
      await new Promise((r) => setTimeout(r, 310));
      // User walks away from the feed while the prompt is still resolving.
      useAtelierStore.getState().setView(APP_VIEW_PROMPTS);
      releaseFill?.();
      await settle();
    });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(useAtelierStore.getState().view).toEqual(APP_VIEW_PROMPTS);
  });

  test('a queued-roll drain that fires after navigation leaves the user where they are', async () => {
    const h = setup({ rollQueue: [{ id: 'q1', text: 'a {{ai-fill: x}} b', seed: 1, source: 'template' }] });
    await act(async () => {
      h.submitDraft();
      await new Promise((r) => setTimeout(r, 310));
      useAtelierStore.getState().setView(APP_VIEW_PROMPTS);
      releaseFill?.();
      await settle();
    });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(useAtelierStore.getState().view).toEqual(APP_VIEW_PROMPTS);
  });

  test('a search term the user typed after pressing Generate is not cleared', async () => {
    useAtelierStore.getState().setQ('sunset');
    const h = setup({ prompt: 'a {{ai-fill: x}} b' });
    await act(async () => {
      h.submitDraft();
      await new Promise((r) => setTimeout(r, 310));
      useAtelierStore.getState().setQ('mountains');
      releaseFill?.();
      await settle();
    });
    expect(useAtelierStore.getState().q).toBe('mountains');
  });
});
