import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import type { EnhancePromptRequest, GenerateRequest, Model, TagDimension, VariableList } from '@atelier/shared';
import { useAtelierStore, initialAtelierState } from '../store/atelier';
import { ApiError } from '../api/client';
import { useRollQueueSubmit } from './useRollQueueSubmit';

// Enhance presses at the hook boundary: the real enhance transport over a
// stubbed fetch for /enhance-prompt, and an injected generate.

const model = { id: 'gpt-image-2.6-sunburst', name: 'GPT Image 2.6 Sunburst', pool: 'shared', backend: 'cloud', supportsReferenceImages: true } as unknown as Model;

const era: VariableList = {
  id: 'e', name: 'era', sortOrder: 0, createdAt: 0, updatedAt: 0,
  options: [{ id: 'e1', listId: 'e', value: 'ancient era', tagIds: [], sortOrder: 0, weight: 1 }],
};
const library: { variableLists: readonly VariableList[]; dimensions: readonly TagDimension[] } = { variableLists: [era], dimensions: [] };

const realFetch = globalThis.fetch;

function sse(text: string): Response {
  return new Response(
    `event: delta\ndata: ${JSON.stringify({ text })}\n\nevent: done\ndata: {}\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

let batchFillGate = Promise.withResolvers<undefined>();

/** Answers /enhance-prompt with `answer(request, callIndex)`; anything else rejects, as in setup. */
function stubEnhance(answer: (request: EnhancePromptRequest, call: number) => Promise<Response>): EnhancePromptRequest[] {
  const requests: EnhancePromptRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // Two buffered presses fill as one batch, held until the test releases it.
    if (url.includes('/prompts/ai-fill/batch')) {
      const batch = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { items: { staticSegments: string[] }[] };
      const body = `event: result\ndata: ${JSON.stringify({
        items: batch.items.map((item) => ({ ok: true, prompt: item.staticSegments.join('FILLED'), fills: ['FILLED'] })),
      })}\n\n`;
      return batchFillGate.promise.then(() => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    // A lone ai-fill resolves its blank as FILLED, so a press can take the buffered path.
    if (url.includes('/prompts/ai-fill')) {
      const fill = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { staticSegments: string[] };
      return Promise.resolve(new Response(
        `event: result\ndata: ${JSON.stringify({ prompt: fill.staticSegments.join('FILLED'), fills: ['FILLED'] })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ));
    }
    if (!url.includes('/enhance-prompt')) return Promise.reject(new Error(`unexpected fetch ${url}`));
    const request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as EnhancePromptRequest;
    requests.push(request);
    return answer(request, requests.length - 1);
  }) as typeof fetch;
  return requests;
}

function setup(opts: {
  prompt: string;
  generate?: (req: GenerateRequest, options?: { onAccepted?: (batchId: string) => void }) => Promise<unknown>;
}) {
  const toasts: { text: string; tone: string | undefined }[] = [];
  const generate = mock(opts.generate ?? ((_req: GenerateRequest, _options?: { onAccepted?: (batchId: string) => void }) => Promise.resolve()));
  useAtelierStore.getState().setDraft({
    prompt: opts.prompt,
    refImages: [{ clientId: 'c1', serverId: 'ref-1', status: 'ready', mime: 'image/png', sizeBytes: 1, previewUrl: '/ref.png' }],
  });
  const { result, rerender } = renderHook(() => useRollQueueSubmit({
    draft: useAtelierStore.getState().draft,
    effectiveModel: model, effectiveRatio: '4:5', effectiveDuration: undefined,
    generate, fireGenerate: () => undefined,
    addToast: (text: string, tone?: string) => { toasts.push({ text, tone }); return ''; },
    setComposerExpanded: () => undefined,
    library, libraryPending: false,
  }));
  return { toasts, generate, result, rerender };
}

const prompts = (generate: ReturnType<typeof mock>) => generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt);

async function settle(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  await act(async () => {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('useRollQueueSubmit — Enhance presses', () => {
  beforeEach(() => {
    useAtelierStore.setState(initialAtelierState, true);
    batchFillGate = Promise.withResolvers<undefined>();
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  test('rewrites the resolved prompt, generates from the rewrite and leaves the draft byte-identical', async () => {
    const prompt = 'a {{random::red::blue}} fox in the {{var::era}}';
    const requests = stubEnhance(() => Promise.resolve(sse('a crimson fox in an ancient era')));
    const h = setup({ prompt });
    act(() => { h.result.current.submitEnhanced(); });
    await settle(() => h.generate.mock.calls.length > 0);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toMatch(/^a (red|blue) fox in the ancient era$/);
    expect(requests[0]).toMatchObject({ modelId: model.id, refImageIds: ['ref-1'], ratio: '4:5' });
    expect(prompts(h.generate)).toEqual(['a crimson fox in an ancient era']);
    expect(useAtelierStore.getState().draft.prompt).toBe(prompt);
    expect(useAtelierStore.getState().resolving).toBe(0);
    expect(useAtelierStore.getState().resolvingEnhance).toBe(0);
  });

  test('fires the Composer prompt alone: library rolls waiting in the queue stay queued and unbound', async () => {
    const requests = stubEnhance(() => Promise.resolve(sse('a rewritten fox')));
    const h = setup({ prompt: 'a fox' });
    const stashed = { id: 'sweep-1', text: 'a stashed sweep roll', seed: 7, source: 'sweep' as const };
    act(() => { useAtelierStore.getState().setDraft({ rollQueue: [stashed] }); });
    act(() => { h.result.current.submitEnhanced(); });
    await settle(() => h.generate.mock.calls.length > 0);
    await settle(() => false, 30);

    expect(requests.map((request) => request.prompt)).toEqual(['a fox']);
    expect(prompts(h.generate)).toEqual(['a rewritten fox']);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([stashed]);

    // A later Generate press takes the roll as written, never through the enhancer.
    act(() => { h.result.current.submitDraft(); });
    await settle(() => h.generate.mock.calls.length === 3);
    expect(requests).toHaveLength(1);
    expect(prompts(h.generate)).toContain('a stashed sweep roll');
  });

  test('without a prompt it does nothing, whatever is queued', async () => {
    const requests = stubEnhance(() => Promise.resolve(sse('never')));
    const h = setup({ prompt: '   ' });
    const stashed = { id: 'sweep-1', text: 'a stashed sweep roll', seed: 7, source: 'sweep' as const };
    act(() => { useAtelierStore.getState().setDraft({ rollQueue: [stashed] }); });
    act(() => { h.result.current.submitEnhanced(); });
    await settle(() => false, 40);

    expect(requests).toHaveLength(0);
    expect(h.generate).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([stashed]);
    expect(useAtelierStore.getState().resolving).toBe(0);
  });

  test('overlapping presses each rewrite the original prompt and POST in press order', async () => {
    const answers = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
    const requests = stubEnhance((_request, call) => answers[call]?.promise ?? Promise.reject(new Error('extra call')));
    const h = setup({ prompt: 'a fox in the {{var::era}}' });
    act(() => {
      h.result.current.submitEnhanced();
      h.result.current.submitEnhanced();
    });
    await settle(() => requests.length === 2);
    expect(requests.map((request) => request.prompt)).toEqual(['a fox in the ancient era', 'a fox in the ancient era']);
    expect(useAtelierStore.getState().resolvingEnhance).toBe(2);
    // Repeated presses are counted on the status line, not toasted one by one.
    expect(h.toasts).toEqual([]);

    // The second rewrite lands first; the POSTs still keep press order.
    answers[1]?.resolve(sse('rewrite two'));
    await settle(() => false, 30);
    expect(h.generate).not.toHaveBeenCalled();
    answers[0]?.resolve(sse('rewrite one'));
    await settle(() => h.generate.mock.calls.length === 2);
    expect(prompts(h.generate)).toEqual(['rewrite one', 'rewrite two']);
    expect(useAtelierStore.getState().resolvingEnhance).toBe(0);
    expect(useAtelierStore.getState().draft.prompt).toBe('a fox in the {{var::era}}');
  });

  test('a failed rewrite generates nothing and says why', async () => {
    stubEnhance(() => Promise.resolve(Response.json({ error: 'No text model can write prompts for this model.' }, { status: 409 })));
    const h = setup({ prompt: 'a fox' });
    act(() => { h.result.current.submitEnhanced(); });
    await settle(() => h.toasts.length > 0);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.toasts).toEqual([{ text: 'No text model can write prompts for this model.', tone: 'error' }]);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
  });

  test('a rewrite refused at capacity is requeued and re-POSTed with the same text, never enhanced twice', async () => {
    const requests = stubEnhance(() => Promise.resolve(sse('a rewritten fox')));
    let calls = 0;
    const h = setup({
      prompt: 'a fox',
      generate: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new ApiError(429, 'queue full', { code: 'QUEUE_FULL', retry_after_seconds: 0 }))
          : Promise.resolve();
      },
    });
    act(() => { h.result.current.submitEnhanced(); });
    await settle(() => h.generate.mock.calls.length >= 2 && !useAtelierStore.getState().draining);
    expect(prompts(h.generate)).toEqual(['a rewritten fox', 'a rewritten fox']);
    const keys = h.generate.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(requests).toHaveLength(1);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
  });

  const queueFull = () => new ApiError(429, 'queue full', { code: 'QUEUE_FULL', retry_after_seconds: 0 });
  const stashed = { id: 'sweep-1', text: 'a stashed sweep roll', seed: 7, source: 'sweep' as const };

  test('a capacity retry of a buffered (ai-fill) Enhance press still leaves library rolls queued', async () => {
    const requests = stubEnhance(() => Promise.resolve(sse('a rewritten fox')));
    let calls = 0;
    const h = setup({
      prompt: 'a {{ai-fill: animal}}',
      generate: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(queueFull()) : Promise.resolve();
      },
    });
    act(() => { useAtelierStore.getState().setDraft({ rollQueue: [stashed] }); });
    act(() => { h.result.current.submitEnhanced(); });
    await settle(() => h.generate.mock.calls.length >= 2 && !useAtelierStore.getState().draining);
    await settle(() => false, 40);

    expect(requests.map((request) => request.prompt)).toEqual(['a FILLED']);
    expect(prompts(h.generate)).toEqual(['a rewritten fox', 'a rewritten fox']);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([stashed]);
  });

  test('a Generate press that joins an Enhance retry drain still fires the library rolls', async () => {
    const requests = stubEnhance(() => Promise.resolve(sse('a rewritten fox')));
    const stream = Promise.withResolvers<undefined>();
    let calls = 0;
    const h = setup({
      prompt: 'a fox',
      generate: (_req, options) => {
        calls += 1;
        if (calls === 1) return Promise.reject(queueFull());
        if (calls === 2) {
          // The retry is accepted and its stream keeps running, so the drain stays up.
          options?.onAccepted?.('batch-2');
          return stream.promise;
        }
        return Promise.resolve();
      },
    });
    act(() => { useAtelierStore.getState().setDraft({ rollQueue: [stashed] }); });
    act(() => { h.result.current.submitEnhanced(); });
    await settle(() => h.generate.mock.calls.length >= 2);
    expect(useAtelierStore.getState().draining).toBe(true);
    expect(useAtelierStore.getState().draft.rollQueue.map((roll) => roll.id)).toContain('sweep-1');

    act(() => { h.result.current.submitDraft(); });
    await settle(() => h.generate.mock.calls.length >= 4);
    // A roll stashed after the Generate press joined is picked up too, as in any drain.
    act(() => { useAtelierStore.getState().stashRoll({ id: 'sweep-2', text: 'a later sweep roll', seed: 8, source: 'sweep' }); });
    await settle(() => h.generate.mock.calls.length >= 5);
    stream.resolve(undefined);
    await settle(() => !useAtelierStore.getState().draining);

    expect(requests.map((request) => request.prompt)).toEqual(['a fox']);
    expect(prompts(h.generate).slice(0, 2)).toEqual(['a rewritten fox', 'a rewritten fox']);
    expect(prompts(h.generate).slice(2).sort()).toEqual(['a fox', 'a later sweep roll', 'a stashed sweep roll']);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
  });

  test('Generate with an empty Composer starts the library rolls while the Enhance retry still runs', async () => {
    stubEnhance(() => Promise.resolve(sse('a rewritten fox')));
    const stream = Promise.withResolvers<undefined>();
    let calls = 0;
    const h = setup({
      prompt: 'a fox',
      generate: (_req, options) => {
        calls += 1;
        if (calls === 1) return Promise.reject(queueFull());
        if (calls === 2) {
          options?.onAccepted?.('batch-2');
          return stream.promise;
        }
        return Promise.resolve();
      },
    });
    act(() => { h.result.current.submitEnhanced(); });
    await settle(() => h.generate.mock.calls.length >= 2);
    // The Composer is emptied and a roll stashed; the drain idles on the running generation.
    act(() => { useAtelierStore.getState().setDraft({ prompt: '' }); });
    h.rerender();
    act(() => { useAtelierStore.getState().stashRoll(stashed); });
    await settle(() => false, 60);
    expect(prompts(h.generate)).toEqual(['a rewritten fox', 'a rewritten fox']);

    act(() => { h.result.current.submitDraft(); });
    await settle(() => h.generate.mock.calls.length >= 3);
    // Started before the Enhance generation finished.
    expect(prompts(h.generate)).toEqual(['a rewritten fox', 'a rewritten fox', 'a stashed sweep roll']);
    stream.resolve(undefined);
    await settle(() => !useAtelierStore.getState().draining);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
  });

  test('a library roll stashed while no Generate press is live waits out an Enhance retry drain', async () => {
    stubEnhance(() => Promise.resolve(sse('a rewritten fox')));
    const stream = Promise.withResolvers<undefined>();
    let calls = 0;
    const h = setup({
      prompt: 'a fox',
      generate: (_req, options) => {
        calls += 1;
        if (calls === 1) return Promise.reject(queueFull());
        options?.onAccepted?.('batch-2');
        return stream.promise;
      },
    });
    act(() => { h.result.current.submitEnhanced(); });
    await settle(() => h.generate.mock.calls.length >= 2);
    expect(useAtelierStore.getState().draining).toBe(true);
    act(() => { useAtelierStore.getState().stashRoll(stashed); });
    await settle(() => false, 60);
    stream.resolve(undefined);
    await settle(() => !useAtelierStore.getState().draining);

    expect(prompts(h.generate)).toEqual(['a rewritten fox', 'a rewritten fox']);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([stashed]);
  });

  test('a buffered Generate press still gets library rolls fired when an Enhance retry owns the drain', async () => {
    const requests = stubEnhance(() => Promise.resolve(sse('a rewritten fox')));
    let calls = 0;
    const h = setup({
      prompt: 'a {{ai-fill: animal}}',
      generate: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(queueFull()) : Promise.resolve();
      },
    });
    // Enhance then Generate buffer into one flush; a roll is stashed while their fill waits.
    act(() => {
      h.result.current.submitEnhanced();
      h.result.current.submitDraft();
    });
    await settle(() => false, 400);
    act(() => { useAtelierStore.getState().stashRoll(stashed); });
    batchFillGate.resolve(undefined);
    await settle(() => h.generate.mock.calls.length >= 4 && !useAtelierStore.getState().draining);

    expect(requests.map((request) => request.prompt)).toEqual(['a FILLED']);
    expect(prompts(h.generate)[0]).toBe('a rewritten fox');
    expect(prompts(h.generate).slice(1).sort()).toEqual(['a FILLED', 'a rewritten fox', 'a stashed sweep roll']);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
  });

  test('a plain Generate press never calls the enhancer', async () => {
    const requests = stubEnhance(() => Promise.resolve(sse('unused')));
    const h = setup({ prompt: 'a fox in the {{var::era}}' });
    act(() => { h.result.current.submitDraft(); });
    await settle(() => h.generate.mock.calls.length > 0);
    expect(requests).toHaveLength(0);
    expect(prompts(h.generate)).toEqual(['a fox in the ancient era']);
  });
});
