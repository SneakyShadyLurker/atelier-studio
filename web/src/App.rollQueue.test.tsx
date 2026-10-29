import type { Batch, GenerateRequest, Model, PromptLibraryResponse } from '@atelier/shared';
import type { GenerateOptions } from './hooks/useGenerate';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { fixtureModels } from '../test/fixtures/models';
import { modelKeys } from './api/models';
import { RETIRED_MODEL_TOAST } from './lib/historicalGeneration';
import { initialAtelierState, useAtelierStore } from './store/atelier';

// fixtureModels always has at least one entry — narrow once here.
const defaultModel = fixtureModels[0] ?? (() => { throw new Error('fixtureModels is empty'); })();

// Mock useGenerate so we can observe fireGenerate calls.
const generateMock = mock((_request?: GenerateRequest, _options?: GenerateOptions) => Promise.resolve(undefined));

void mock.module('./hooks/useGenerate', () => ({
  useGenerate: () => ({ generate: generateMock }),
}));

const { default: App } = await import('./App');

const originalMatchMedia = window.matchMedia.bind(window);
const originalFetch = globalThis.fetch;

const promptLibrary: PromptLibraryResponse = {
  templates: [],
  variableLists: [],
  dimensions: [],
};

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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function collectionResponse() {
  return {
    items: [],
    summary: {
      totalCount: 0,
      pinnedCount: 0,
      unsortedCount: 0,
      archivedTotalCount: 0,
      archivedPinnedCount: 0,
      archivedUnsortedCount: 0,
    },
  };
}

function installFetch(models: readonly Model[] = fixtureModels, historyItems: readonly Batch[] = []): void {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.endsWith('/models')) return Response.json(models);
    if (url.endsWith('/collections')) return Response.json(collectionResponse());
    if (url.includes('/archive')) return Response.json({ items: [], nextCursor: null, total: 0 });
    if (url.endsWith('/prompts')) return Response.json(promptLibrary);
    if (url.includes('/history')) return Response.json({ items: historyItems, nextCursor: null });
    return Response.json({});
  }) as unknown as typeof fetch;
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0 },
      mutations: { retry: false },
    },
  });
}

function Wrapper({ children, client }: PropsWithChildren<{ client: QueryClient }>) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  installMatchMedia();
  installFetch();
  generateMock.mockClear();
  generateMock.mockImplementation(() => Promise.resolve(undefined));
  useAtelierStore.setState(initialAtelierState, true);
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  globalThis.fetch = originalFetch;
  useAtelierStore.setState(initialAtelierState, true);
});

describe('App submitDraft fan-out', () => {
  test('batch reroll and failed-tile retry preserve prompt provenance', async () => {
    const metadataBatch: Batch = {
      id: 'batch-metadata',
      prompt: 'metadata prompt',
      modelId: defaultModel.id,
      modelLabel: defaultModel.name,
      ratio: defaultModel.supportedRatios[0] ?? '1:1',
      createdAt: Date.now(),
      collectionId: null,
      pinned: false,
      status: 'done',
      provenance: {
        templateId: 'template-1',
        templateName: 'Portrait',
        rollSeed: 77,
        pins: { era: 'future' },
      },
      tiles: [{
        id: 'failed-tile',
        seed: 1,
        status: 'failed',
        error: 'internal error',
        completedAt: Date.now(),
      }],
    };
    installFetch([defaultModel], [metadataBatch]);
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);

    const more = await screen.findByRole('button', { name: /more actions/i });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: /re-roll/i }));
    fireEvent.click(screen.getByRole('button', { name: /retry failed tile/i }));

    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(2); });
    for (const call of generateMock.mock.calls) {
      expect(call[0]).toMatchObject({
        provenance: {
          templateId: 'template-1',
          rollSeed: 77,
          pins: { era: 'future' },
        },
      });
    }
  });

  const videoModel = (id: string, supportsI2V: boolean): Model => ({
    id,
    name: id,
    backend: 'local',
    tag: 'comfyui',
    latency: 'slow',
    supportedRatios: ['16:9', '9:16'],
    supportedDurations: [124, 243, 362],
    defaultDuration: 124,
    ...(supportsI2V ? { supportsI2V: true } : {}),
    outputsVideo: true,
    pool: 'local',
    concurrencyCapPerUser: 1,
    maxCountPerBatch: 1,
  });

  const historicalBatch = (overrides: Partial<Batch>): Batch => ({
    id: 'batch-historical',
    prompt: 'historical prompt',
    modelId: defaultModel.id,
    modelLabel: 'Historical',
    ratio: '16:9',
    createdAt: Date.now(),
    collectionId: null,
    pinned: false,
    status: 'done',
    tiles: [{ id: 'failed-tile', seed: 1, status: 'failed', error: 'internal error', completedAt: Date.now() }],
    ...overrides,
  });

  async function rerollThenRetry(): Promise<void> {
    const more = await screen.findByRole('button', { name: /more actions/i });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: /re-roll/i }));
    fireEvent.click(screen.getByRole('button', { name: /retry failed tile/i }));
  }

  test('batch reroll and tile retry replay the I2V source and non-default duration', async () => {
    const i2v = videoModel('minimax-h3-i2v', true);
    installFetch([defaultModel, i2v], [historicalBatch({
      modelId: i2v.id,
      i2vSourceUploadId: 'upload-source',
      durationFrames: 362,
    })]);
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    await waitFor(() => { expect(client.getQueryState(modelKeys.list())?.status).toBe('success'); });

    await rerollThenRetry();

    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(2); });
    for (const call of generateMock.mock.calls) {
      expect(call[0]).toMatchObject({ modelId: i2v.id, i2vSourceUploadId: 'upload-source', durationFrames: 362, count: 1 });
      expect(call[0] && 'extendsTileId' in call[0]).toBe(false);
    }
  });

  test('Re-roll and tile Retry each get a distinct logical idempotency key', async () => {
    installFetch([defaultModel], [historicalBatch({ ratio: defaultModel.supportedRatios[0] ?? '1:1' })]);
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    await waitFor(() => { expect(client.getQueryState(modelKeys.list())?.status).toBe('success'); });

    await rerollThenRetry();

    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(2); });
    const keys = generateMock.mock.calls.map((call) => call[0]?.idempotencyKey);
    expect(keys.every((key) => typeof key === 'string' && key.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(2);
  });

  test('batch reroll and tile retry replay a T2V duration', async () => {
    const t2v = videoModel('minimax-h3-t2v', false);
    installFetch([defaultModel, t2v], [historicalBatch({ modelId: t2v.id, durationFrames: 243 })]);
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    await waitFor(() => { expect(client.getQueryState(modelKeys.list())?.status).toBe('success'); });

    await rerollThenRetry();

    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(2); });
    for (const call of generateMock.mock.calls) {
      expect(call[0]).toMatchObject({ modelId: t2v.id, durationFrames: 243 });
    }
  });

  test('retired model absent from loaded inventory sends no request and explains recovery', async () => {
    installFetch([defaultModel], [historicalBatch({ modelId: 'retired-model' })]);
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    await waitFor(() => { expect(client.getQueryState(modelKeys.list())?.status).toBe('success'); });

    await rerollThenRetry();

    const toast = useAtelierStore.getState().toasts.find((t) => t.text === RETIRED_MODEL_TOAST);
    expect(toast?.action?.label).toBe('Copy prompt');
    expect(generateMock).not.toHaveBeenCalled();
  });

  test('pending model inventory keeps server handling instead of claiming retirement', async () => {
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith('/models')) return new Promise<Response>(() => undefined);
      if (url.endsWith('/collections')) return Response.json(collectionResponse());
      if (url.includes('/archive')) return Response.json({ items: [], nextCursor: null, total: 0 });
      if (url.endsWith('/prompts')) return Response.json(promptLibrary);
      if (url.includes('/history')) return Response.json({ items: [historicalBatch({ modelId: 'retired-model' })], nextCursor: null });
      return Response.json({});
    }) as unknown as typeof fetch;
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);

    await rerollThenRetry();

    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(2); });
    for (const call of generateMock.mock.calls) {
      expect(call[0]?.modelId).toBe('retired-model');
    }
    expect(useAtelierStore.getState().toasts.some((t) => t.text === RETIRED_MODEL_TOAST)).toBe(false);
  });

  test('with empty queue, fires exactly 1 generate call', async () => {
    useAtelierStore.setState((state) => ({
      ...state,
      draft: { ...state.draft, prompt: 'hello', modelId: defaultModel.id },
    }));
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    const submitBtn = await screen.findByRole('button', { name: /^generate$/i });
    fireEvent.click(submitBtn);
    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(1); });
  });

  test('hand-typed {{random::}} in active prompt is resolved before reaching generate', async () => {
    useAtelierStore.setState((state) => ({
      ...state,
      draft: { ...state.draft, prompt: 'a {{random::cat::dog}}', modelId: defaultModel.id },
    }));
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    const submitBtn = await screen.findByRole('button', { name: /^generate$/i });
    fireEvent.click(submitBtn);
    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(1); });
    const sent = generateMock.mock.calls[0]?.[0];
    if (!sent) throw new Error('generate was not called');
    expect(sent.prompt).not.toContain('{{random::');
    expect(['a cat', 'a dog']).toContain(sent.prompt);
  });

  test('queued rolls pass through unmodified (already resolved); active prompt re-rolls', async () => {
    useAtelierStore.setState((state) => ({
      ...state,
      draft: {
        ...state.draft,
        prompt: '{{random::active}}',
        modelId: defaultModel.id,
        rollQueue: [
          { id: 'a', text: '{{random::raw}}', seed: 1, source: 'template' as const },
        ],
      },
    }));
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    const submitBtn = await screen.findByRole('button', { name: /generate 2/i });
    fireEvent.click(submitBtn);
    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(2); });
    const prompts = generateMock.mock.calls.map((c) => c[0]?.prompt);
    // Queued roll text is preserved verbatim (it carries its own seed/provenance);
    // only the active draft prompt is resolved at submit time.
    expect(prompts).toContain('{{random::raw}}');
    expect(prompts).toContain('active');
  });

  test('with 2 queued rolls + active prompt, fires 3 generate calls and clears queue', async () => {
    useAtelierStore.setState((state) => ({
      ...state,
      draft: {
        ...state.draft,
        prompt: 'active prompt',
        modelId: defaultModel.id,
        rollQueue: [
          { id: 'a', text: 'queued one', seed: 1, source: 'template' as const },
          { id: 'b', text: 'queued two', seed: 2, source: 'template' as const },
        ],
      },
    }));
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    const submitBtn = await screen.findByRole('button', { name: /generate 3/i });
    fireEvent.click(submitBtn);
    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(3); });
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
    // Toast added — assert via the toasts slice
    expect(useAtelierStore.getState().toasts.some((t) => /queued 3 prompts/i.test(t.text))).toBe(true);
  });

  test('with queued rolls but empty active prompt, fires N calls via keyboard (no extra for active)', async () => {
    // Queue contents make the shared Composer gate submittable even when the
    // active prompt is empty. This exercises that same gate through Cmd+Enter.
    useAtelierStore.setState((state) => ({
      ...state,
      draft: {
        ...state.draft,
        prompt: '',
        modelId: defaultModel.id,
        rollQueue: [
          { id: 'a', text: 'queued one', seed: 1, source: 'template' as const },
          { id: 'b', text: 'queued two', seed: 2, source: 'template' as const },
        ],
      },
    }));
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    // Cmd+Enter is owned by the composer prompt field itself.
    const textarea = await screen.findByRole('textbox', { name: /prompt/i });
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(2); });
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
  });

  test('requiresKey + queue-only (no active prompt) via ⌘+Enter: opens BYOK, fires nothing, preserves all rolls', async () => {
    // Cmd+Enter runs the same Composer submit gate as the Generate button: a
    // key-gated model opens the BYOK pane and never reaches submitDraft.
    const keyModel = fixtureModels.find((m: Model) => m.requiresKey !== undefined);
    if (!keyModel) throw new Error('Add a requiresKey fixture model to make this test meaningful');
    useAtelierStore.setState((state) => ({
      ...state,
      draft: {
        ...state.draft,
        prompt: '',
        modelId: keyModel.id,
        rollQueue: [
          { id: 'a', text: 'queued one', seed: 1, source: 'template' as const },
          { id: 'b', text: 'queued two', seed: 2, source: 'template' as const },
        ],
      },
    }));
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    const textarea = await screen.findByRole('textbox', { name: /prompt/i });
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await waitFor(() => { expect(useAtelierStore.getState().byokOpen).toBe(true); });
    expect(generateMock).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['a', 'b']);
  });

  test('all dispatches fail → queue is preserved and no success toast is emitted', async () => {
    generateMock.mockImplementation(() => Promise.reject(new Error('upstream rejected')));
    useAtelierStore.setState((state) => ({
      ...state,
      draft: {
        ...state.draft,
        prompt: 'active prompt',
        modelId: defaultModel.id,
        rollQueue: [
          { id: 'a', text: 'queued one', seed: 1, source: 'template' as const },
          { id: 'b', text: 'queued two', seed: 2, source: 'template' as const },
        ],
      },
    }));
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    const submitBtn = await screen.findByRole('button', { name: /generate 3/i });
    fireEvent.click(submitBtn);
    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(3); });
    // Queue PRESERVED — user can retry.
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['a', 'b']);
    // No "Queued N prompts" success toast emitted.
    expect(useAtelierStore.getState().toasts.some((t) => /queued \d+ prompts/i.test(t.text))).toBe(false);
  });

  test('partial dispatch → pre-batch-failed queued rolls are restored, accepted count reported', async () => {
    // fireUnits order is [queued a, queued b, active]. a fails pre-batch (a plain
    // Error, NOT a StreamTruncatedError with a batchId), b starts a batch, active
    // fails pre-batch. a is restorable (no batch exists to retry from); b is consumed.
    generateMock
      .mockImplementationOnce(() => Promise.reject(new Error('first failed')))
      .mockImplementationOnce(() => Promise.resolve(undefined))
      .mockImplementationOnce(() => Promise.reject(new Error('third failed')));
    useAtelierStore.setState((state) => ({
      ...state,
      draft: {
        ...state.draft,
        prompt: 'active prompt',
        modelId: defaultModel.id,
        rollQueue: [
          { id: 'a', text: 'queued one', seed: 1, source: 'template' as const },
          { id: 'b', text: 'queued two', seed: 2, source: 'template' as const },
        ],
      },
    }));
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    const submitBtn = await screen.findByRole('button', { name: /generate 3/i });
    fireEvent.click(submitBtn);
    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(3); });
    // Roll 'a' failed before any batch existed → restored for retry; roll 'b'
    // started a batch → consumed. Only the one started batch is reported.
    await waitFor(() => {
      expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['a']);
    });
    expect(useAtelierStore.getState().toasts.some((t) => /queued 1 prompt/i.test(t.text))).toBe(true);
  });

  test('queued rolls are dispatched exactly once even with a second submit while streams are pending', async () => {
    // The composer stays interactive during background generation (the freeze
    // was the bug), so a second submit is allowed. The invariant that protects
    // against duplicates: queued rolls are cleared up-front, so a second submit
    // re-reads an empty queue and can only re-fire the still-present active
    // prompt — never the already-dispatched rolls.
    const resolvers: (() => void)[] = [];
    // As the real generate does: the server accepts the batch, then streams it.
    generateMock.mockImplementation((_request, options) => {
      queueMicrotask(() => { options?.onAccepted?.('accepted-batch'); });
      return new Promise<undefined>((resolve) => {
        resolvers.push(() => { resolve(undefined); });
      });
    });
    useAtelierStore.setState((state) => ({
      ...state,
      draft: {
        ...state.draft,
        prompt: 'active prompt',
        modelId: defaultModel.id,
        rollQueue: [
          { id: 'a', text: 'queued one', seed: 1, source: 'template' as const },
          { id: 'b', text: 'queued two', seed: 2, source: 'template' as const },
        ],
      },
    }));
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    const submitBtn = await screen.findByRole('button', { name: /generate 3/i });
    fireEvent.click(submitBtn);
    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(3); });
    // Queue cleared immediately — decoupled from stream completion, so the
    // composer is usable again without waiting for the batch to finish.
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);

    // Second submit while the first batch's streams are still pending.
    fireEvent.click(submitBtn);

    const firedPrompts = () => (generateMock.mock.calls as readonly (readonly unknown[])[])
      .map((c) => (c[0] as { prompt?: string } | undefined)?.prompt);
    const countOf = (p: string) => firedPrompts().filter((x) => x === p).length;
    // Queued rolls dispatched exactly once each — never re-fired by resubmits.
    expect(countOf('queued one')).toBe(1);
    expect(countOf('queued two')).toBe(1);

    resolvers.forEach((resolve) => { resolve(); });
    await waitFor(() => { expect(useAtelierStore.getState().draft.rollQueue).toEqual([]); });
  });

  test('rolls queued AFTER submit survive — a slow in-flight batch never wipes them', async () => {
    // Regression for the deferred-clear race: previously the queue was cleared
    // only after every stream settled, so rolls the user queued during that
    // window were erased when the original batch finished. Now clearing is
    // up-front and id-targeted, so later additions are untouched.
    const resolvers: (() => void)[] = [];
    // As the real generate does: the server accepts the batch, then streams it.
    generateMock.mockImplementation((_request, options) => {
      queueMicrotask(() => { options?.onAccepted?.('accepted-batch'); });
      return new Promise<undefined>((resolve) => {
        resolvers.push(() => { resolve(undefined); });
      });
    });
    useAtelierStore.setState((state) => ({
      ...state,
      draft: {
        ...state.draft,
        prompt: '',
        modelId: defaultModel.id,
        rollQueue: [
          { id: 'a', text: 'queued one', seed: 1, source: 'template' as const },
          { id: 'b', text: 'queued two', seed: 2, source: 'template' as const },
        ],
      },
    }));
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    const textarea = await screen.findByRole('textbox', { name: /prompt/i });
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(2); });
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);

    // User queues a fresh roll while the first batch is still streaming.
    useAtelierStore.getState().stashRoll({ id: 'c', text: 'queued three', seed: 3, source: 'template' });

    // First batch finishes — its completion must NOT wipe roll 'c'.
    resolvers.forEach((resolve) => { resolve(); });
    await waitFor(() => {
      expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['c']);
    });
  });

  test('count above the model maxCountPerBatch is clamped at submit (audit T1-001)', async () => {
    // Pre-fix: the App-level submit clamp only fired for local-pool models
    // (`localCap` boolean). A non-local model whose admin-narrowed
    // maxCountPerBatch was below the global default left draft.count stale,
    // so the server returned 400 COUNT_EXCEEDS_POOL with no UI recovery.
    // Post-fix: the clamp is `effectiveModel.maxCountPerBatch`-driven for
    // every pool.
    const cappedModel: Model = {
      id: 'capped-cloud',
      name: 'Capped Cloud',
      backend: 'cloud',
      tag: 'cloud',
      latency: 'medium',
      supportedRatios: ['1:1', '4:5', '16:9', '9:16'],
      pool: 'shared',
      concurrencyCapPerUser: 2,
      maxCountPerBatch: 2,
    };
    installFetch([cappedModel]);
    useAtelierStore.setState((state) => ({
      ...state,
      draft: { ...state.draft, prompt: 'hello', modelId: cappedModel.id, count: 4 },
    }));
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    const submitBtn = await screen.findByRole('button', { name: /^generate$/i });
    fireEvent.click(submitBtn);
    await waitFor(() => { expect(generateMock).toHaveBeenCalledTimes(1); });
    const calls = generateMock.mock.calls as readonly (readonly unknown[])[];
    const firstArg = calls[0]?.[0] as { count?: number } | undefined;
    expect(firstArg?.count).toBe(2);
  });

  test('requiresKey + active prompt + queue via ⌘+Enter: opens BYOK, fires nothing, preserves queue', async () => {
    // Same gate as the Generate button: the key-gated model opens BYOK first.
    const keyModel = fixtureModels.find((m: Model) => m.requiresKey !== undefined);
    if (!keyModel) throw new Error('Add a requiresKey fixture model to make this test meaningful');
    useAtelierStore.setState((state) => ({
      ...state,
      draft: {
        ...state.draft,
        prompt: 'active',
        modelId: keyModel.id,
        rollQueue: [
          { id: 'a', text: 'queued one', seed: 1, source: 'template' as const },
          { id: 'b', text: 'queued two', seed: 2, source: 'template' as const },
        ],
      },
    }));
    const client = makeClient();
    render(<Wrapper client={client}><App /></Wrapper>);
    const textarea = await screen.findByRole('textbox', { name: /prompt/i });
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await waitFor(() => { expect(useAtelierStore.getState().byokOpen).toBe(true); });
    expect(generateMock).not.toHaveBeenCalled();
    // Queue is PRESERVED for retry after BYOK
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
