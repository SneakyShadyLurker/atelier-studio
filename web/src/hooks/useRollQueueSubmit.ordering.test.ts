import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import type {
  AiFillBatchRequest,
  AiFillRequest,
  GenerateRequest,
  Model,
  Ratio,
  TagDimension,
  VariableList,
} from '@atelier/shared';
import type { AiFillModel } from '../api/aiFill';
import { ApiError } from '../api/client';
import {
  APP_VIEW_PROMPTS,
  APP_VIEW_UNSORTED,
  collectionView,
  heldUploadIds,
  initialAtelierState,
  useAtelierStore,
  type ComposerDraft,
  type RefImageDraft,
  type QueuedRoll,
  type ToastAction,
} from '../store/atelier';
import { loadRollQueue, rollQueueStorageKey, setRollQueueScope } from '../lib/rollQueuePersist';

// Mock the ai-fill SSE client before the hook module is loaded (mock.module is
// not auto-hoisted in bun, so the hook is dynamic-imported below).
interface FillResult { prompt: string; fills: string[] }
interface BatchMockResult { items: ({ ok: true; prompt: string; fills: string[] } | { ok: false })[] }
const filled = (req: Pick<AiFillRequest, 'staticSegments' | 'instructions'>): FillResult => ({
  prompt: req.staticSegments.join('FILLED'),
  fills: req.instructions.map(() => 'FILLED'),
});
const resolveAiFillMock = mock((
  req: AiFillRequest,
  _signal?: AbortSignal,
  _onBackend?: (model: AiFillModel) => void,
): Promise<FillResult> => Promise.resolve(filled(req)));
const resolveAiFillBatchMock = mock((
  req: AiFillBatchRequest,
  _signal?: AbortSignal,
  _onBackend?: (model: AiFillModel) => void,
): Promise<BatchMockResult> => Promise.resolve({ items: req.items.map((item) => ({ ok: true as const, ...filled(item) })) }));
void mock.module('../api/aiFill', () => ({
  resolveAiFill: resolveAiFillMock,
  resolveAiFillBatch: resolveAiFillBatchMock,
}));

const { useRollQueueSubmit } = await import('./useRollQueueSubmit');

const modelA = {
  id: 'model-a', name: 'Model A', pool: 'shared', backend: 'cloud', supportsReferenceImages: true, maxCountPerBatch: 4,
} as unknown as Model;
const modelB = {
  id: 'model-b', name: 'Model B', pool: 'shared', backend: 'cloud', supportsReferenceImages: false, maxCountPerBatch: 2,
} as unknown as Model;
const emptyLib: { variableLists: readonly VariableList[]; dimensions: readonly TagDimension[] } = { variableLists: [], dimensions: [] };
const readyRef: RefImageDraft = {
  clientId: 'chip-1', serverId: 'ref-1', status: 'ready', mime: 'image/png', sizeBytes: 1, previewUrl: '',
};
const CAPACITY_TOAST = 'At capacity — queued, will generate automatically.';

const queueFull429 = () => new ApiError(429, 'queue full', { code: 'QUEUE_FULL', retry_after_seconds: 0 }, undefined);
const pausedBoundRoll = (): QueuedRoll => ({
  id: 'paused-bound', text: 'paused {{ai-fill: action}}', seed: 5, source: 'composer',
  submission: {
    request: { modelId: 'model-motion', ratio: '16:9', count: 1 }, lockedSeed: 5,
    wantsMotion: true, motionFields: {},
  },
});
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const store = () => useAtelierStore.getState();

async function waitUntil(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await tick(5);
}

interface Post {
  readonly request: GenerateRequest;
  readonly accept: () => void;
  readonly finish: () => void;
  readonly refuse: (error: unknown) => void;
}

/** A generate whose every POST the test answers and finishes. */
function controlledGenerate() {
  const posts: Post[] = [];
  const generate = mock((request: GenerateRequest, options?: { onAccepted?: (batchId: string) => void }) => {
    const stream = Promise.withResolvers<undefined>();
    const batchId = `batch-${String(posts.length + 1)}`;
    posts.push({
      request,
      accept: () => { options?.onAccepted?.(batchId); },
      finish: () => { stream.resolve(undefined); },
      refuse: (error) => { stream.reject(error); },
    });
    return stream.promise;
  });
  const prompts = () => posts.map((post) => post.request.prompt);
  return { posts, generate, prompts };
}

interface Props {
  readonly model: Model | undefined;
  readonly ratio: Ratio;
}

function setup(
  generate: (request: GenerateRequest, options?: { onAccepted?: (batchId: string) => void }) => Promise<unknown>,
  initial: Props,
) {
  const toasts: string[] = [];
  const actions: ToastAction[] = [];
  const byokFires: GenerateRequest[] = [];
  const hook = renderHook((props: Props) => useRollQueueSubmit({
    draft: store().draft,
    effectiveModel: props.model,
    effectiveRatio: props.ratio,
    effectiveDuration: undefined,
    generate,
    fireGenerate: (request) => { byokFires.push(request); },
    addToast: (text, _tone, _duration, action) => {
      toasts.push(text);
      if (action) actions.push(action);
      return '';
    },
    setComposerExpanded: () => undefined,
    library: emptyLib,
    libraryPending: false,
  }), { initialProps: initial });
  return {
    toasts,
    actions,
    byokFires,
    press: () => { hook.result.current.submitDraft(); },
    replay: (request: GenerateRequest) => { hook.result.current.submitPrepared(request); },
    preparedHandler: () => hook.result.current.submitPrepared,
    stop: () => { hook.result.current.stopDraining(); },
    unmount: () => { hook.unmount(); },
    /** What the user changes between two presses: the composer, the model and the ratio. */
    switchTo: (props: Props, patch: Partial<ComposerDraft> = {}) => {
      store().setDraft(patch);
      hook.rerender(props);
    },
  };
}

/** Stops whatever still runs and ends every stream, so no test leaks work into the next. */
async function settle(h: { stop: () => void }, posts: readonly Post[]): Promise<void> {
  await act(async () => {
    h.stop();
    for (const post of posts) post.finish();
    await tick(5);
  });
}

function resetState(): void {
  setRollQueueScope('ordering-test');
  sessionStorage.removeItem(rollQueueStorageKey('ordering-test'));
  useAtelierStore.setState(initialAtelierState, true);
  resolveAiFillMock.mockClear();
  resolveAiFillMock.mockImplementation((req: AiFillRequest) => Promise.resolve(filled(req)));
  resolveAiFillBatchMock.mockClear();
  resolveAiFillBatchMock.mockImplementation((req: AiFillBatchRequest) => Promise.resolve({
    items: req.items.map((item) => ({ ok: true as const, ...filled(item) })),
  }));
}

describe('useRollQueueSubmit — POSTs follow press order', () => {
  beforeEach(resetState);

  test('history admission handler stays stable across composer changes', () => {
    const { generate } = controlledGenerate();
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    const handler = h.preparedHandler();
    h.switchTo({ model: modelB, ratio: '16:9' }, { prompt: 'typing another prompt' });
    expect(h.preparedHandler()).toBe(handler);
    h.unmount();
  });

  test('a late capacity refusal after Stop visibly saves the replay without retrying it', async () => {
    const { posts, generate } = controlledGenerate();
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.replay({ prompt: 'historical', modelId: 'model-b', ratio: '1:1', count: 1, seed: 77 });
    await act(async () => { await waitUntil(() => posts.length === 1); });
    h.stop();
    await act(async () => { posts[0]?.refuse(queueFull429()); await tick(); });
    expect(posts).toHaveLength(1);
    const key = posts[0]?.request.idempotencyKey;
    if (!key) throw new Error('missing replay key');
    expect(store().draft.rollQueue.map((roll) => roll.id)).toEqual([key]);
    expect(h.toasts).toContain('Replay stopped — saved in your queue. Generate or Resume will retry it.');
    expect(h.actions.some((action) => action.label === 'Resume')).toBe(true);
    await settle(h, posts);
  });

  test('a later history click announces its wait and Stop cancels it', async () => {
    const { posts, generate } = controlledGenerate();
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    const historical: GenerateRequest = { prompt: 'first replay', modelId: 'model-b', ratio: '1:1', count: 1, seed: 77 };
    h.replay(historical);
    await act(async () => { await waitUntil(() => posts.length === 1); });
    h.replay({ ...historical, prompt: 'waiting replay' });
    await act(async () => { await tick(); });
    expect(h.toasts).toContain('Replay is waiting for an earlier request. Stop cancels waiting replays.');
    await act(async () => { h.stop(); posts[0]?.accept(); await tick(); });
    expect(posts).toHaveLength(1);
    await settle(h, posts);
  });

  test('historical replay waits for earlier preparation and keeps its turn ahead of later presses', async () => {
    const fill = Promise.withResolvers<FillResult>();
    resolveAiFillMock.mockImplementation(() => fill.promise);
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first {{ai-fill: subject}}' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    const historical: GenerateRequest = {
      prompt: 'literal {{ai-fill: historical text}}', modelId: 'model-b', ratio: '16:9', count: 2,
      refImageIds: ['ref-1'], provenance: { templateId: 'old-template', rollSeed: 7, pins: {} },
    };
    h.press();
    h.replay(historical);
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'third plain' });
    h.press();
    await act(async () => { await tick(); });
    expect(prompts()).toEqual([]);
    expect(heldUploadIds()).toContain('ref-1');
    await act(async () => {
      fill.resolve({ prompt: 'first FILLED', fills: ['FILLED'] });
      await waitUntil(() => posts.length === 1);
    });
    expect(prompts()).toEqual(['first FILLED']);
    await act(async () => { posts[0]?.accept(); await tick(); });
    const key = posts[1]?.request.idempotencyKey;
    if (!key) throw new Error('missing replay key');
    expect(posts[1]?.request).toEqual({ ...historical, idempotencyKey: key });
    expect(typeof posts[1]?.request.idempotencyKey).toBe('string');
    await act(async () => { posts[1]?.accept(); await tick(); });
    expect(prompts()).toEqual(['first FILLED', historical.prompt, 'third plain']);
    expect(resolveAiFillMock).toHaveBeenCalledTimes(1);
    expect(resolveAiFillBatchMock).not.toHaveBeenCalled();
    await settle(h, posts);
  });

  test('historical replay joins an active drain before a later composer press', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().stashRoll({ id: 'first-roll', text: 'first queued', seed: 1, source: 'template' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await waitUntil(() => posts.length === 1); });
    const historical: GenerateRequest = { prompt: 'historical', modelId: 'model-b', ratio: '16:9', count: 1, seed: 99 };
    h.replay(historical);
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'third plain' });
    h.press();
    await act(async () => { await tick(); });
    expect(prompts()).toEqual(['first queued']);
    await act(async () => { posts[0]?.accept(); await waitUntil(() => posts.length === 2); });
    const key = posts[1]?.request.idempotencyKey;
    if (!key) throw new Error('missing replay key');
    expect(posts[1]?.request).toEqual({ ...historical, idempotencyKey: key });
    await act(async () => { posts[1]?.accept(); await waitUntil(() => posts.length === 3); });
    expect(prompts()).toEqual(['first queued', 'historical', 'third plain']);
    await settle(h, posts);
  });

  test('Stop then historical replay leaves idle bound work untouched and does not prepare it', async () => {
    const originalFetch = globalThis.fetch;
    const network = mock(() => Promise.reject(new Error('paused enhancement must not run')));
    globalThis.fetch = network as unknown as typeof fetch;
    const { posts, generate, prompts } = controlledGenerate();
    const paused = pausedBoundRoll();
    store().stashRoll(paused);
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    try {
      h.stop();
      h.replay({ prompt: 'historical only', modelId: 'model-b', ratio: '1:1', count: 1, seed: 77 });
      await act(async () => { await waitUntil(() => posts.length === 1); });
      expect(prompts()).toEqual(['historical only']);
      expect(store().draft.rollQueue).toEqual([paused]);
      expect(resolveAiFillMock).not.toHaveBeenCalled();
      expect(resolveAiFillBatchMock).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      await act(async () => { posts[0]?.accept(); await tick(); });
      expect(store().draft.rollQueue).toEqual([paused]);
      expect(store().draining).toBe(false);
    } finally {
      await settle(h, posts);
      globalThis.fetch = originalFetch;
    }
  });

  test('historical replay waits for a stopped unanswered POST without resuming its restored rows', async () => {
    const originalFetch = globalThis.fetch;
    const network = mock(() => Promise.reject(new Error('paused enhancement must not run')));
    globalThis.fetch = network as unknown as typeof fetch;
    const { posts, generate, prompts } = controlledGenerate();
    store().stashRoll({ id: 'old-first', text: 'first queued', seed: 1, source: 'template' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    try {
      h.press();
      await act(async () => { await waitUntil(() => posts.length === 1); h.stop(); await tick(); });
      store().stashRoll(pausedBoundRoll());
      const paused = store().draft.rollQueue;
      h.replay({ prompt: 'historical only', modelId: 'model-b', ratio: '1:1', count: 1, seed: 77 });
      await act(async () => { await tick(); });
      expect(prompts()).toEqual(['first queued']);
      await act(async () => {
        posts[0]?.refuse(new ApiError(503, 'offline', { code: 'MODEL_OFFLINE' }, undefined));
        await waitUntil(() => posts.length === 2);
      });
      expect(prompts()).toEqual(['first queued', 'historical only']);
      expect(store().draft.rollQueue).toEqual(paused);
      expect(resolveAiFillMock).not.toHaveBeenCalled();
      expect(resolveAiFillBatchMock).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    } finally {
      await settle(h, posts);
      globalThis.fetch = originalFetch;
    }
  });

  test('a later explicit Generate resumes paused work only after historical acceptance', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    const paused: QueuedRoll = {
      id: 'paused-plain', text: 'paused plain', seed: 5, source: 'composer',
      submission: { request: { modelId: 'model-a', ratio: '1:1', count: 1 }, lockedSeed: 5, wantsMotion: false, motionFields: {} },
    };
    store().stashRoll(paused);
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.replay({ prompt: 'historical first', modelId: 'model-b', ratio: '1:1', count: 1, seed: 77 });
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'explicit composer' });
    h.press();
    await act(async () => { await waitUntil(() => posts.length === 1); });
    expect(prompts()).toEqual(['historical first']);
    expect(store().draft.rollQueue).toEqual([paused]);
    await act(async () => { posts[0]?.accept(); await waitUntil(() => posts.length === 2); });
    expect(prompts()).toEqual(['historical first', 'paused plain']);
    await act(async () => { posts[1]?.accept(); await waitUntil(() => posts.length === 3); });
    expect(prompts()).toEqual(['historical first', 'paused plain', 'explicit composer']);
    await settle(h, posts);
  });

  test('capacity requeue and reload keep a historical click’s logical key and prepared inputs', async () => {
    const { posts, generate } = controlledGenerate();
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    const historical: GenerateRequest = { prompt: 'already resolved', modelId: 'model-b', ratio: '16:9', count: 1, seed: 99 };
    h.replay(historical);
    await act(async () => { await waitUntil(() => posts.length === 1); });
    const key = posts[0]?.request.idempotencyKey;
    expect(typeof key).toBe('string');
    if (!key) throw new Error('missing replay key');
    await act(async () => { posts[0]?.refuse(queueFull429()); await waitUntil(() => posts.length === 2, 2_000); });
    expect(posts[1]?.request).toEqual({ ...historical, idempotencyKey: key });
    const restored = loadRollQueue();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.id).toBe(key);
    expect(restored[0]?.submission).toMatchObject({ prepared: true, lockedSeed: 99 });
    await act(async () => {
      posts[1]?.refuse(new ApiError(503, 'offline', { code: 'MODEL_OFFLINE' }, undefined));
      await tick();
    });
    expect(store().draft.rollQueue.map((roll) => roll.id)).toEqual([key]);
    await settle(h, posts);
  });

  test('late acceptance after Stop retires only the historical retry before another click posts', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    const paused = pausedBoundRoll();
    store().stashRoll(paused);
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    const historical: GenerateRequest = { prompt: 'historical retry', modelId: 'model-b', ratio: '1:1', count: 1, seed: 99 };
    h.replay(historical);
    await act(async () => { await waitUntil(() => posts.length === 1); });
    const key = posts[0]?.request.idempotencyKey;
    if (!key) throw new Error('missing replay key');
    await act(async () => { posts[0]?.refuse(queueFull429()); await waitUntil(() => posts.length === 2, 2_000); });
    expect(posts[1]?.request).toEqual({ ...historical, idempotencyKey: key });
    await act(async () => {
      h.stop();
      h.replay({ ...historical, prompt: 'next historical click' });
      await tick();
    });
    expect(posts).toHaveLength(2);
    expect(store().draft.rollQueue.map((roll) => roll.id)).toEqual([paused.id, key]);
    await act(async () => { posts[1]?.accept(); await waitUntil(() => posts.length === 3); });
    expect(prompts()).toEqual(['historical retry', 'historical retry', 'next historical click']);
    expect(store().draft.rollQueue).toEqual([paused]);
    expect(store().retiredRollIds.has(key)).toBe(true);
    expect(resolveAiFillBatchMock).not.toHaveBeenCalled();
    await settle(h, posts);
  });

  test('removing a saved replay during backoff promptly releases its turn without restarting it', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    const paused = pausedBoundRoll();
    store().stashRoll(paused);
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.replay({ prompt: 'remove this replay', modelId: 'model-b', ratio: '1:1', count: 1, seed: 99 });
    await act(async () => { await waitUntil(() => posts.length === 1); });
    const key = posts[0]?.request.idempotencyKey;
    if (!key) throw new Error('missing replay key');
    await act(async () => { posts[0]?.refuse(queueFull429()); await tick(); });
    expect(store().draft.rollQueue.map((roll) => roll.id)).toEqual([paused.id, key]);
    await act(async () => {
      store().removeQueuedRoll(key);
      h.replay({ prompt: 'next click', modelId: 'model-b', ratio: '1:1', count: 1, seed: 77 });
      await tick();
    });
    // Backoff was canceled; no timer wait or retry of the removed row.
    expect(prompts()).toEqual(['remove this replay', 'next click']);
    expect(store().draft.rollQueue).toEqual([paused]);
    expect(resolveAiFillBatchMock).not.toHaveBeenCalled();
    await settle(h, posts);
  });

  test('removing an unanswered retry keeps its POST fence and a late QUEUE_FULL never restores it', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    const paused = pausedBoundRoll();
    store().stashRoll(paused);
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    const historical: GenerateRequest = { prompt: 'removed pending retry', modelId: 'model-b', ratio: '1:1', count: 1, seed: 99 };
    h.replay(historical);
    await act(async () => { await waitUntil(() => posts.length === 1); });
    const key = posts[0]?.request.idempotencyKey;
    if (!key) throw new Error('missing replay key');
    await act(async () => { posts[0]?.refuse(queueFull429()); await waitUntil(() => posts.length === 2, 2_000); });
    await act(async () => {
      store().removeQueuedRoll(key);
      h.replay({ ...historical, prompt: 'next click' });
      await tick();
    });
    expect(posts).toHaveLength(2);
    await act(async () => { posts[1]?.refuse(queueFull429()); await waitUntil(() => posts.length === 3); });
    expect(prompts()).toEqual(['removed pending retry', 'removed pending retry', 'next click']);
    expect(store().draft.rollQueue).toEqual([paused]);
    expect(loadRollQueue()).toEqual([paused]);
    expect(resolveAiFillBatchMock).not.toHaveBeenCalled();
    await settle(h, posts);
  });

  for (const currentComposer of ['keyed', 'incomplete I2V'] as const) {
    test(`idle replay Resume works independently of a ${currentComposer} composer and retires after Clear`, async () => {
      const originalDateNow = Date.now;
      let now = 0;
      Date.now = () => now;
      const { posts, generate } = controlledGenerate();
      const h = setup(generate, { model: modelA, ratio: '1:1' });
      const historical: GenerateRequest = { prompt: 'saved replay', modelId: 'model-b', ratio: '1:1', count: 1, seed: 99 };
      try {
        await act(async () => { h.replay(historical); await tick(); });
        const key = posts[0]?.request.idempotencyKey;
        if (!key) throw new Error('missing replay key');
        now = 8 * 60 * 1000 + 1;
        await act(async () => { posts[0]?.refuse(queueFull429()); await tick(); });
        const resume = h.actions.find((action) => action.label === 'Resume');
        expect(resume).toBeDefined();
        Date.now = originalDateNow;
        const selectedModel: Model = currentComposer === 'keyed'
          ? { ...modelA, requiresKey: { provider: 'google' } }
          : { ...modelA, supportsI2V: true, promptFormat: 'h3-motion' };
        h.switchTo({ model: selectedModel, ratio: '1:1' }, { prompt: '', i2vSourceUploadId: undefined, motionPrompt: '' });
        await act(async () => { resume?.onClick(); await waitUntil(() => posts.length === 2); });
        expect(posts[1]?.request).toEqual({ ...historical, idempotencyKey: key });
        expect(h.byokFires).toEqual([]);
        await act(async () => { posts[1]?.accept(); posts[1]?.finish(); await tick(); });
        store().clearRollQueue();
        const unrelated = pausedBoundRoll();
        store().stashRoll(unrelated);
        await act(async () => { resume?.onClick(); await tick(); });
        expect(posts).toHaveLength(2);
        expect(store().draft.rollQueue).toEqual([unrelated]);
      } finally {
        Date.now = originalDateNow;
        await settle(h, posts);
      }
    });
  }

  test('a later press waits for the earlier POST to be accepted, never for its stream', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'second plain' });
    h.press();
    await act(async () => { await tick(); });
    expect(prompts()).toEqual(['first plain']);

    await act(async () => {
      posts[0]?.accept();
      await tick();
    });
    // Released by acceptance while the first stream still runs.
    expect(prompts()).toEqual(['first plain', 'second plain']);
    expect(store().draining).toBe(false);
    await settle(h, posts);
  });

  test('reversed preparation completion still POSTs in press order', async () => {
    const fills = new Map<string, (prompt: string) => void>();
    resolveAiFillMock.mockImplementation((req: AiFillRequest) => new Promise<FillResult>((resolve) => {
      fills.set(req.instructions[0] ?? '', (prompt) => { resolve({ prompt, fills: ['FILLED'] }); });
    }));
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'one {{ai-fill: ONE}}' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(330); });
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'two {{ai-fill: TWO}}' });
    h.press();
    await act(async () => { await tick(330); });
    expect([...fills.keys()]).toEqual(['ONE', 'TWO']);

    await act(async () => {
      fills.get('TWO')?.('two filled');
      await tick();
    });
    expect(prompts()).toEqual([]);

    await act(async () => {
      fills.get('ONE')?.('one filled');
      await tick();
    });
    expect(prompts()).toEqual(['one filled']);

    await act(async () => {
      posts[0]?.accept();
      await tick();
    });
    expect(prompts()).toEqual(['one filled', 'two filled']);
    expect(store().preparing).toBe(0);
    await settle(h, posts);
  });

  test('A/B/A switches inside the debounce keep each press its model, ratio, count, refs and seed', async () => {
    const generate = mock((_request: GenerateRequest, _options?: { onAccepted?: (batchId: string) => void }) => Promise.resolve());
    store().setDraft({ prompt: 'a {{ai-fill: ONE}}', count: 3, refImages: [readyRef] });
    store().setPickerSeed(111);
    store().setPickerLockSeed(true);
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    store().setPickerLockSeed(false);
    h.switchTo({ model: modelB, ratio: '16:9' }, { prompt: 'b {{ai-fill: TWO}}', count: 4, refImages: [] });
    h.press();
    store().setPickerSeed(222);
    store().setPickerLockSeed(true);
    h.switchTo({ model: modelA, ratio: '4:5' }, { prompt: 'c {{ai-fill: THREE}}', count: 1 });
    h.press();
    await act(async () => { await tick(330); });

    // One fill request per model; the groups complete out of press order.
    expect(resolveAiFillBatchMock.mock.calls.map(([request]) => [
      request.modelId,
      request.items.map((item) => item.instructions[0]),
    ])).toEqual([['model-a', ['ONE', 'THREE']], ['model-b', ['TWO']]]);
    const requests = generate.mock.calls.map(([request]) => request);
    expect(requests.map((request) => [request.prompt, request.modelId, request.ratio, request.count])).toEqual([
      ['a FILLED', 'model-a', '1:1', 3],
      // Clamped to model B's per-batch cap at press time.
      ['b FILLED', 'model-b', '16:9', 2],
      ['c FILLED', 'model-a', '4:5', 1],
    ]);
    expect(requests[0]?.refImageIds).toEqual(['ref-1']);
    expect(requests[0]?.seed).toBe(111);
    expect(requests[1] && 'refImageIds' in requests[1]).toBe(false);
    expect(requests[1]?.seed).not.toBe(111);
    expect(requests[2]?.seed).toBe(222);
    expect(new Set(requests.map((request) => request.idempotencyKey)).size).toBe(3);
  });

  test('A/B/A presses joining a running drain keep their own settings, saved for reload', async () => {
    const { posts, generate } = controlledGenerate();
    store().stashRoll({ id: 'lib', text: 'library roll', seed: 1, source: 'template' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(); });
    expect(posts[0]?.request).toMatchObject({ prompt: 'library roll', modelId: 'model-a' });

    h.switchTo({ model: modelB, ratio: '9:16' }, { prompt: 'b press' });
    h.press();
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'a press', count: 1 });
    h.press();
    const joined = store().draft.rollQueue.map((roll) => [
      roll.text,
      roll.submission?.request.modelId,
      roll.submission?.request.ratio,
    ]);
    expect(joined).toEqual([['b press', 'model-b', '9:16'], ['a press', 'model-a', '1:1']]);
    expect(loadRollQueue().filter((roll) => roll.source === 'composer').map((roll) => roll.submission?.request.modelId))
      .toEqual(['model-b', 'model-a']);

    await act(async () => {
      posts[0]?.accept();
      await tick();
    });
    expect(posts[1]?.request).toMatchObject({ prompt: 'b press', modelId: 'model-b', ratio: '9:16', count: 2 });
    await act(async () => {
      posts[1]?.accept();
      await tick();
    });
    expect(posts[2]?.request).toMatchObject({ prompt: 'a press', modelId: 'model-a', ratio: '1:1', count: 1 });
    await settle(h, posts);
  });

  test('a press refused at capacity is not passed by a later press for another model', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    h.switchTo({ model: modelB, ratio: '16:9' }, { prompt: 'second plain' });
    h.press();
    await act(async () => { await tick(); });
    expect(prompts()).toEqual(['first plain']);

    await act(async () => {
      posts[0]?.refuse(queueFull429());
      await tick();
    });
    // The drain retries the refused press first, under its own key and model;
    // the later press waits in the queue behind it.
    expect(prompts()).toEqual(['first plain', 'first plain']);
    expect(posts[1]?.request).toMatchObject({ modelId: 'model-a', idempotencyKey: posts[0]?.request.idempotencyKey });
    expect(store().draft.rollQueue.map((roll) => roll.text)).toEqual(['second plain']);
    expect(h.toasts).toContain(CAPACITY_TOAST);

    await act(async () => {
      posts[1]?.accept();
      await tick();
    });
    expect(prompts()).toEqual(['first plain', 'first plain', 'second plain']);
    expect(posts[2]?.request).toMatchObject({ modelId: 'model-b', ratio: '16:9' });
    await settle(h, posts);
  });

  test('a press refused for good releases its turn, so the next one still POSTs', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'second plain' });
    h.press();
    await act(async () => {
      await tick();
      posts[0]?.refuse(new ApiError(500, 'provider down', undefined, undefined));
      await tick();
    });
    expect(prompts()).toEqual(['first plain', 'second plain']);
    expect(store().draft.rollQueue).toEqual([]);
    await settle(h, posts);
  });

  test('Stop discards a buffered press, and a late acceptance never duplicates the fired one', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'one {{ai-fill: ONE}}' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(330); });
    expect(prompts()).toEqual(['one FILLED']);

    h.switchTo({ model: modelB, ratio: '1:1' }, { prompt: 'two {{ai-fill: TWO}}' });
    h.press();
    expect(store().preparing).toBe(1);
    h.stop();
    await act(async () => {
      posts[0]?.accept();
      posts[0]?.finish();
      await tick(330);
    });
    expect(prompts()).toEqual(['one FILLED']);
    expect(resolveAiFillMock.mock.calls.map(([request]) => request.instructions[0])).toEqual(['ONE']);
    expect(store().draft.rollQueue).toEqual([]);
    expect(loadRollQueue()).toEqual([]);
    expect(store().preparing).toBe(0);
  });

  test('Clear discards a press still waiting for its turn', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    store().stashRoll({ id: 'lib', text: 'library roll', seed: 1, source: 'template' });
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'second plain' });
    // A queue is waiting, so this press would start a drain once its turn comes.
    h.press();
    await act(async () => { await tick(); });
    expect(prompts()).toEqual(['first plain']);

    act(() => { store().clearRollQueue(); });
    await act(async () => {
      posts[0]?.accept();
      posts[0]?.finish();
      await tick(20);
    });
    expect(prompts()).toEqual(['first plain']);
    expect(store().draining).toBe(false);
    expect(store().draft.rollQueue).toEqual([]);
  });

  test('a capacity requeue keeps the press model, key and paid fill across a model switch and reload', async () => {
    const { posts, generate } = controlledGenerate();
    store().setDraft({ prompt: 'b {{ai-fill: ONE}}' });
    const h = setup(generate, { model: modelB, ratio: '16:9' });
    h.press();
    await act(async () => { await tick(330); });
    expect(posts[0]?.request).toMatchObject({ prompt: 'b FILLED', modelId: 'model-b' });

    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'unrelated' });
    await act(async () => {
      posts[0]?.refuse(queueFull429());
      await tick();
    });
    const key = posts[0]?.request.idempotencyKey;
    expect(posts[1]?.request).toMatchObject({ prompt: 'b FILLED', modelId: 'model-b', ratio: '16:9', count: 2, idempotencyKey: key });
    expect(resolveAiFillMock).toHaveBeenCalledTimes(1);
    // A reload before the answer resumes the same roll, settings and paid text.
    expect(loadRollQueue()).toMatchObject([{
      id: key,
      text: 'b FILLED',
      source: 'composer',
      submission: { request: { modelId: 'model-b', ratio: '16:9', count: 2 }, lockedSeed: null },
    }]);
    await settle(h, posts);
  });

  test('a head held back by capacity stays ahead of a press that joined the drain meanwhile', async () => {
    const { posts, generate } = controlledGenerate();
    store().stashRoll({ id: 'lib', text: 'library roll', seed: 1, source: 'template' });
    store().setDraft({ prompt: 'head press' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(); });
    h.switchTo({ model: modelB, ratio: '1:1' }, { prompt: 'joined press' });
    h.press();
    expect(h.toasts).toContain('Added to the queue.');

    await act(async () => {
      posts[0]?.accept();
      await tick();
    });
    expect(posts[1]?.request.prompt).toBe('head press');
    await act(async () => {
      posts[1]?.refuse(queueFull429());
      await waitUntil(() => posts.length >= 3, 4_000);
    });
    expect(posts[2]?.request).toMatchObject({ prompt: 'head press', idempotencyKey: posts[1]?.request.idempotencyKey });
    await act(async () => {
      posts[2]?.accept();
      await tick();
    });
    expect(posts[3]?.request).toMatchObject({ prompt: 'joined press', modelId: 'model-b' });
    await settle(h, posts);
  }, 10_000);

  test('a roll stashed while a drain-starting press waits for its turn stays behind that press', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(); });
    expect(prompts()).toEqual(['first plain']);

    store().stashRoll({ id: 'lib-initial', text: 'initial roll', seed: 1, source: 'template' });
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'head press' });
    // A queue is waiting, so this press starts a drain once its turn comes.
    h.press();
    store().stashRoll({ id: 'lib-later', text: 'later roll', seed: 2, source: 'template' });
    await act(async () => { await tick(); });
    expect(prompts()).toEqual(['first plain']);

    await act(async () => {
      posts[0]?.accept();
      await waitUntil(() => posts.length >= 2);
    });
    expect(prompts()).toEqual(['first plain', 'initial roll']);
    await act(async () => {
      posts[1]?.accept();
      await waitUntil(() => posts.length >= 3);
    });
    expect(prompts()).toEqual(['first plain', 'initial roll', 'head press']);
    await act(async () => {
      posts[2]?.accept();
      await waitUntil(() => posts.length >= 4);
    });
    expect(prompts()).toEqual(['first plain', 'initial roll', 'head press', 'later roll']);
    await settle(h, posts);
  });

  test('an earlier press requeued at capacity after a drain-starting press stays ahead of it', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(); });
    expect(prompts()).toEqual(['first plain']);
    // Stop keeps the sent POST; a capacity refusal now requeues it without
    // starting a drain of its own.
    h.stop();

    store().stashRoll({ id: 'lib', text: 'library roll', seed: 1, source: 'template' });
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'head press' });
    h.press();
    await act(async () => {
      posts[0]?.refuse(queueFull429());
      await waitUntil(() => posts.length >= 2);
    });
    expect(prompts()).toEqual(['first plain', 'library roll']);
    await act(async () => {
      posts[1]?.accept();
      await waitUntil(() => posts.length >= 3);
    });
    expect(posts[2]?.request).toMatchObject({ prompt: 'first plain', idempotencyKey: posts[0]?.request.idempotencyKey });
    await act(async () => {
      posts[2]?.accept();
      await waitUntil(() => posts.length >= 4);
    });
    expect(prompts()).toEqual(['first plain', 'library roll', 'first plain', 'head press']);
    await settle(h, posts);
  });

  test('a press made while a stopped drain holds consumed rolls follows them without session storage', async () => {
    // happy-dom's Storage proxy ignores plain assignment of its methods;
    // defineProperty replaces them.
    const storage = sessionStorage;
    const originals = { getItem: storage.getItem.bind(storage), setItem: storage.setItem.bind(storage) };
    const replace = (methods: Pick<Storage, 'getItem' | 'setItem'>) => {
      for (const name of ['getItem', 'setItem'] as const) {
        Object.defineProperty(storage, name, { value: methods[name], configurable: true, writable: true });
      }
    };
    const unavailable = () => { throw new DOMException('storage unavailable', 'QuotaExceededError'); };
    replace({ getItem: unavailable, setItem: unavailable });
    try {
      const { posts, generate, prompts } = controlledGenerate();
      store().setDraft({ prompt: '' });
      store().stashRoll({ id: 'lib-1', text: 'lib one', seed: 1, source: 'template' });
      store().stashRoll({ id: 'lib-2', text: 'lib two', seed: 2, source: 'template' });
      store().stashRoll({ id: 'lib-3', text: 'lib three', seed: 3, source: 'template' });
      const h = setup(generate, { model: modelA, ratio: '1:1' });
      h.press();
      await act(async () => { await tick(); });
      // The drain consumed all three rolls and waits on the first POST.
      expect(prompts()).toEqual(['lib one']);
      expect(store().draft.rollQueue).toEqual([]);

      h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'B press' });
      h.stop();
      h.press();
      store().stashRoll({ id: 'lib-c', text: 'later roll', seed: 4, source: 'template' });
      // Nothing can be read back from storage: ordering rests on memory alone.
      expect(loadRollQueue()).toEqual([]);

      await act(async () => {
        posts[0]?.accept();
        await waitUntil(() => posts.length >= 2);
      });
      expect(prompts()).toEqual(['lib one', 'lib two']);
      await act(async () => {
        posts[1]?.accept();
        await waitUntil(() => posts.length >= 3);
      });
      expect(prompts()).toEqual(['lib one', 'lib two', 'lib three']);
      await act(async () => {
        posts[2]?.accept();
        await waitUntil(() => posts.length >= 4);
      });
      expect(prompts()).toEqual(['lib one', 'lib two', 'lib three', 'B press']);
      await act(async () => {
        posts[3]?.accept();
        await waitUntil(() => posts.length >= 5);
      });
      expect(prompts()).toEqual(['lib one', 'lib two', 'lib three', 'B press', 'later roll']);
      const keys = posts.map((post) => post.request.idempotencyKey);
      expect([keys[0], keys[1], keys[2], keys[4]]).toEqual(['lib-1', 'lib-2', 'lib-3', 'lib-c']);
      expect(['lib-1', 'lib-2', 'lib-3', 'lib-c']).not.toContain(keys[3]);
      await settle(h, posts);
    } finally {
      replace(originals);
    }
  });
});

const keyModel = {
  id: 'model-key', name: 'Keyed', pool: 'shared', backend: 'cloud', requiresKey: 'gemini', maxCountPerBatch: 4,
} as unknown as Model;
const i2vModel = {
  id: 'model-i2v', name: 'Video', pool: 'local', backend: 'local', supportsI2V: true, outputsVideo: true, maxCountPerBatch: 1,
} as unknown as Model;
const motionModel = {
  id: 'model-motion', name: 'Motion', pool: 'local', backend: 'local', promptFormat: 'h3-motion', outputsVideo: true, maxCountPerBatch: 1,
} as unknown as Model;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe('useRollQueueSubmit — a press is retired, kept or pinned as it was made', () => {
  beforeEach(resetState);

  test('Clear discards a plain press still waiting for its turn', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'second plain' });
    h.press();
    await act(async () => { await tick(); });
    expect(prompts()).toEqual(['first plain']);

    act(() => { store().clearRollQueue(); });
    await act(async () => {
      posts[0]?.accept();
      posts[0]?.finish();
      await tick(20);
    });
    expect(prompts()).toEqual(['first plain']);
    expect(store().draft.rollQueue).toEqual([]);
  });

  test('Clear discards a press still buffering before any fill is paid', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'one {{ai-fill: ONE}}' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    expect(store().preparing).toBe(1);
    act(() => { store().clearRollQueue(); });
    await act(async () => { await tick(330); });
    expect(resolveAiFillMock).not.toHaveBeenCalled();
    expect(resolveAiFillBatchMock).not.toHaveBeenCalled();
    expect(prompts()).toEqual([]);
    expect(store().preparing).toBe(0);
    await settle(h, posts);
  });

  test('Clear discards a flushed press waiting behind an earlier POST', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'two {{ai-fill: TWO}}' });
    h.press();
    await act(async () => { await tick(330); });
    expect(resolveAiFillMock.mock.calls.map(([request]) => request.instructions[0])).toEqual(['TWO']);
    expect(prompts()).toEqual(['first plain']);

    act(() => { store().clearRollQueue(); });
    await act(async () => {
      posts[0]?.accept();
      posts[0]?.finish();
      await tick(20);
    });
    expect(prompts()).toEqual(['first plain']);
    expect(store().draft.rollQueue).toEqual([]);
    expect(store().preparing).toBe(0);
  });

  test('Stop retires a press waiting for its turn, releases its media and blocks no later press', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'second plain', refImages: [readyRef] });
    h.press();
    // The chip is removed from the composer: the waiting press still holds it.
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'third plain', refImages: [] });
    await act(async () => { await tick(); });
    expect(heldUploadIds()).toContain('ref-1');

    h.stop();
    await act(async () => { await tick(); });
    expect(heldUploadIds()).not.toContain('ref-1');

    h.press();
    await act(async () => {
      posts[0]?.accept();
      await tick();
    });
    // The POST already sent keeps its acceptance; the retired press never fires.
    expect(prompts()).toEqual(['first plain', 'third plain']);
    await settle(h, posts);
  });

  test('unmount retires a press waiting for its turn', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    h.switchTo({ model: modelA, ratio: '1:1' }, { prompt: 'second plain' });
    h.press();
    await act(async () => { await tick(); });
    h.unmount();
    await act(async () => {
      posts[0]?.accept();
      posts[0]?.finish();
      await tick(20);
    });
    expect(prompts()).toEqual(['first plain']);
    expect(store().draft.rollQueue).toEqual([]);
  });

  test('unmount stops a running drain before it sends another queued roll', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: '' });
    store().stashRoll({ id: 'first-roll', text: 'first queued', seed: 1, source: 'template' });
    store().stashRoll({ id: 'second-roll', text: 'second queued', seed: 2, source: 'template' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(); });
    expect(prompts()).toEqual(['first queued']);

    h.unmount();
    await act(async () => {
      posts[0]?.accept();
      posts[0]?.finish();
      await tick(20);
    });
    expect(prompts()).toEqual(['first queued']);
    expect(store().draining).toBe(false);
    expect(store().draft.rollQueue.map((roll) => roll.id)).toEqual(['second-roll']);
  });

  test('a sent POST refused at capacity after Clear queues nothing and is not retried', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(); });
    expect(prompts()).toEqual(['first plain']);

    act(() => { store().clearRollQueue(); });
    await act(async () => {
      posts[0]?.refuse(queueFull429());
      await tick(20);
    });
    expect(prompts()).toEqual(['first plain']);
    expect(store().draft.rollQueue).toEqual([]);
    expect(loadRollQueue()).toEqual([]);
    expect(store().draining).toBe(false);
    expect(h.toasts).not.toContain(CAPACITY_TOAST);
    await settle(h, posts);
  });

  test('a flushed POST refused at capacity after Clear queues nothing and is not retried', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'one {{ai-fill: ONE}}' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(330); });
    expect(prompts()).toEqual(['one FILLED']);

    act(() => { store().clearRollQueue(); });
    await act(async () => {
      posts[0]?.refuse(queueFull429());
      await tick(20);
    });
    expect(prompts()).toEqual(['one FILLED']);
    expect(store().draft.rollQueue).toEqual([]);
    expect(loadRollQueue()).toEqual([]);
    expect(store().draining).toBe(false);
    expect(h.toasts).not.toContain(CAPACITY_TOAST);
    await settle(h, posts);
  });

  test('a sent POST refused at capacity after unmount queues nothing', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(); });
    h.unmount();
    await act(async () => {
      posts[0]?.refuse(queueFull429());
      await tick(20);
    });
    expect(prompts()).toEqual(['first plain']);
    expect(store().draft.rollQueue).toEqual([]);
    expect(loadRollQueue()).toEqual([]);
    expect(store().draining).toBe(false);
  });

  test('a sent POST refused at capacity after Stop stays queued without a retry', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(); });
    h.stop();
    await act(async () => {
      posts[0]?.refuse(queueFull429());
      await tick(20);
    });
    const key = posts[0]?.request.idempotencyKey;
    if (key === undefined) throw new Error('expected the submitted press key');
    expect(prompts()).toEqual(['first plain']);
    expect(store().draining).toBe(false);
    expect(store().draft.rollQueue.map((roll) => roll.id)).toEqual([key]);
    expect(loadRollQueue().map((roll) => roll.id)).toEqual([key]);
    await settle(h, posts);
  });

  /** A capacity restart that takes a library roll under a reference attached only after the press. */
  async function restartWithLibraryRoll(h: ReturnType<typeof setup>, posts: readonly Post[]): Promise<void> {
    h.press();
    await act(async () => { await tick(); });
    h.switchTo({ model: modelA, ratio: '1:1' }, { refImages: [readyRef] });
    store().stashRoll({ id: 'lib', text: 'library roll', seed: 1, source: 'template' });
    await act(async () => {
      posts[0]?.refuse(queueFull429());
      await waitUntil(() => posts.length >= 2);
    });
  }

  test('a library roll a queue-only drain takes holds the reference it was bound to', async () => {
    const { posts, generate } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    await restartWithLibraryRoll(h, posts);
    expect(posts[1]?.request).toMatchObject({ prompt: 'library roll', modelId: 'model-a', refImageIds: ['ref-1'] });
    expect(store().draft.rollQueue).toEqual([]);

    // The chip is removed from the composer: the consumed roll still holds it.
    h.switchTo({ model: modelA, ratio: '1:1' }, { refImages: [] });
    expect(heldUploadIds()).toContain('ref-1');

    await act(async () => {
      posts[1]?.accept();
      await waitUntil(() => posts.length >= 3);
    });
    expect(posts[2]?.request.prompt).toBe('first plain');
    expect(heldUploadIds()).toContain('ref-1');
    await act(async () => {
      posts[2]?.accept();
      await tick(20);
    });
    expect(heldUploadIds()).not.toContain('ref-1');
    await settle(h, posts);
  });

  test('Stop and reload keep a consumed library roll bound to the press that took it', async () => {
    const { posts, generate } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    await restartWithLibraryRoll(h, posts);
    const bound = { modelId: 'model-a', ratio: '1:1', refImageIds: ['ref-1'] };
    const count = posts[1]?.request.count;
    // A reload now resumes the roll under the settings it was taken with.
    const saved = loadRollQueue().find((roll) => roll.id === 'lib');
    expect(saved?.submission?.request).toMatchObject(bound);
    expect(saved?.submission?.request.count).toBe(count);

    h.switchTo({ model: modelB, ratio: '16:9' }, { refImages: [], count: 1 });
    h.stop();
    await act(async () => { await tick(20); });
    const restored = store().draft.rollQueue.find((roll) => roll.id === 'lib');
    expect(restored?.submission?.request).toMatchObject(bound);
    expect(restored?.submission?.request.count).toBe(count);
    const reloaded = loadRollQueue().find((roll) => roll.id === 'lib');
    expect(reloaded?.submission?.request).toMatchObject(bound);
    expect(reloaded?.submission?.request.count).toBe(count);
    // Back in the queue, which holds its reference again.
    expect(heldUploadIds()).toContain('ref-1');
    await settle(h, posts);
  });

  const switches: readonly [string, Props, Partial<ComposerDraft>][] = [
    ['a keyed model', { model: keyModel, ratio: '1:1' }, { prompt: 'keyed press' }],
    ['video without a source', { model: i2vModel, ratio: '16:9' }, { prompt: '', motionPrompt: 'move' }],
    ['no model and a blank draft', { model: undefined, ratio: '1:1' }, { prompt: '' }],
  ];
  for (const [name, props, patch] of switches) {
    test(`a capacity requeue retries under its own settings after switching to ${name}`, async () => {
      const { posts, generate } = controlledGenerate();
      store().setDraft({ prompt: 'first plain' });
      const h = setup(generate, { model: modelA, ratio: '1:1' });
      h.press();
      await act(async () => { await tick(); });
      h.switchTo(props, patch);
      await act(async () => {
        posts[0]?.refuse(queueFull429());
        await tick();
      });
      expect(posts[1]?.request).toMatchObject({
        prompt: 'first plain',
        modelId: 'model-a',
        idempotencyKey: posts[0]?.request.idempotencyKey,
      });
      // Saved non-BYOK work never goes through the BYOK dialog.
      expect(h.byokFires).toEqual([]);
      await settle(h, posts);
    });
  }

  test('a queue-only restart under a keyed model leaves library rolls queued', async () => {
    const { posts, generate } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(); });
    h.switchTo({ model: keyModel, ratio: '1:1' }, { prompt: '' });
    store().stashRoll({ id: 'lib', text: 'library roll', seed: 1, source: 'template' });
    await act(async () => {
      posts[0]?.refuse(queueFull429());
      await tick();
    });
    await act(async () => {
      posts[1]?.accept();
      await tick(20);
    });
    expect(posts.map((post) => post.request.prompt)).toEqual(['first plain', 'first plain']);
    expect(h.byokFires).toEqual([]);
    expect(store().draft.rollQueue.map((roll) => roll.id)).toEqual(['lib']);
    await settle(h, posts);
  });

  test('a press flushed after the debounce does not pull the user back from where they went', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    store().setDraft({ prompt: 'one {{ai-fill: ONE}}' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    act(() => { store().setView(APP_VIEW_PROMPTS); });
    await act(async () => { await tick(330); });
    expect(prompts()).toEqual(['one FILLED']);
    expect(store().view).toEqual(APP_VIEW_PROMPTS);
    await settle(h, posts);
  });

  test('a buffered press still pins the feed while the user stays where they pressed', async () => {
    const { posts, generate, prompts } = controlledGenerate();
    act(() => { store().setView(collectionView('c1')); });
    store().setDraft({ prompt: 'one {{ai-fill: ONE}}' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(330); });
    expect(prompts()).toEqual(['one FILLED']);
    expect(store().view).toEqual(APP_VIEW_UNSORTED);
    await settle(h, posts);
  });

  test('a capacity restart does not pull the user back from where they went', async () => {
    const { posts, generate } = controlledGenerate();
    store().setDraft({ prompt: 'first plain' });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    await act(async () => { await tick(); });
    act(() => { store().setView(APP_VIEW_PROMPTS); });
    await act(async () => {
      posts[0]?.refuse(queueFull429());
      await tick();
    });
    expect(posts[1]?.request.prompt).toBe('first plain');
    expect(store().view).toEqual(APP_VIEW_PROMPTS);
    await settle(h, posts);
  });

  test('a direct press refused at capacity keeps its paid motion text', async () => {
    const originalFetch = globalThis.fetch;
    const enhanced: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      if (!requestUrl(input).includes('/enhance-prompt')) return Promise.resolve(Response.json({}));
      if (typeof init?.body !== 'string') throw new Error('expected a JSON request body');
      const { prompt } = JSON.parse(init.body) as { prompt: string };
      enhanced.push(prompt);
      // The drain's own preparation never finishes: the queued text is what the press paid for.
      if (enhanced.length > 1) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); });
        });
      }
      const frames = `event: delta\ndata: ${JSON.stringify({ text: `enhanced ${prompt}` })}\n\nevent: done\ndata: {}\n\n`;
      return Promise.resolve(new Response(frames, { headers: { 'content-type': 'text/event-stream' } }));
    }) as unknown as typeof fetch;
    try {
      const { posts, generate } = controlledGenerate();
      store().setDraft({ prompt: 'raw motion' });
      const h = setup(generate, { model: motionModel, ratio: '16:9' });
      h.press();
      await act(async () => { await waitUntil(() => posts.length >= 1); });
      expect(posts[0]?.request.prompt).toBe('enhanced raw motion');
      const key = posts[0]?.request.idempotencyKey;

      await act(async () => {
        posts[0]?.refuse(queueFull429());
        await tick(20);
      });
      // Requeued with the enhanced text and the press's model, not the raw prompt.
      expect(loadRollQueue()).toMatchObject([{
        id: key,
        text: 'enhanced raw motion',
        submission: { request: { modelId: 'model-motion' } },
      }]);
      await settle(h, posts);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a buffered press holds its media until its POST is accepted', async () => {
    const { posts, generate } = controlledGenerate();
    store().setDraft({ prompt: 'a {{ai-fill: ONE}}', refImages: [readyRef] });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    h.switchTo({ model: modelA, ratio: '1:1' }, { refImages: [] });
    expect(heldUploadIds()).toContain('ref-1');

    await act(async () => { await tick(330); });
    expect(posts[0]?.request.refImageIds).toEqual(['ref-1']);
    expect(heldUploadIds()).toContain('ref-1');

    await act(async () => {
      posts[0]?.accept();
      await tick();
    });
    expect(heldUploadIds()).not.toContain('ref-1');
    await settle(h, posts);
  });

  test('a consumed roll holds its media through Stop until its batch is accepted', async () => {
    const { posts, generate } = controlledGenerate();
    store().setDraft({ prompt: 'first plain', refImages: [readyRef] });
    const h = setup(generate, { model: modelA, ratio: '1:1' });
    h.press();
    h.switchTo({ model: modelA, ratio: '1:1' }, { refImages: [] });
    await act(async () => { await tick(); });
    await act(async () => {
      posts[0]?.refuse(queueFull429());
      await tick();
    });
    // The drain consumed the requeued roll: it is no longer in the queue, still held.
    expect(posts[1]?.request.refImageIds).toEqual(['ref-1']);
    expect(store().draft.rollQueue).toEqual([]);
    expect(heldUploadIds()).toContain('ref-1');

    // Stop puts the unanswered roll back in the queue, which keeps holding it.
    h.stop();
    await act(async () => { await tick(); });
    const key = posts[0]?.request.idempotencyKey;
    if (key === undefined) throw new Error('expected the submitted roll key');
    expect(store().draft.rollQueue.map((roll) => roll.id)).toEqual([key]);
    expect(heldUploadIds()).toContain('ref-1');

    await act(async () => {
      posts[1]?.accept();
      await tick(20);
    });
    expect(store().draft.rollQueue).toEqual([]);
    expect(heldUploadIds()).not.toContain('ref-1');
    await settle(h, posts);
  });
});
