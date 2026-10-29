import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import type {
  AiFillBackend,
  AiFillBatchRequest,
  AiFillRequest,
  GenerateRequest,
  Model,
  TagDimension,
  VariableList,
} from '@atelier/shared';
import { useAtelierStore, initialAtelierState } from '../store/atelier';
import { StreamTruncatedError } from './useGenerate';
import { QuotaExhaustedError } from '../api/sse';
import { QueueFullError } from '../api/queueFullRetry';
import { ApiError } from '../api/client';
import { AI_FILL_MAX_INSTRUCTION_CHARS } from '@atelier/shared/ai-fill';
import { isDrainOwned } from '../lib/drainOwnership';

// Mock the ai-fill SSE client before the hook module is loaded (mock.module is
// not auto-hoisted in bun, so the hook is dynamic-imported below).
const resolveAiFillMock = mock((req: AiFillRequest, _signal?: AbortSignal, _onBackend?: (backend: AiFillBackend) => void) =>
  Promise.resolve({ prompt: req.staticSegments.join('FILLED'), fills: req.instructions.map(() => 'FILLED') }),
);
interface BatchMockResult {
  items: ({ ok: true; prompt: string; fills: string[] } | { ok: false })[];
}
const resolveAiFillBatchMock = mock((
  req: AiFillBatchRequest,
  _signal?: AbortSignal,
  _onBackend?: (backend: AiFillBackend) => void,
): Promise<BatchMockResult> => Promise.resolve({
  items: req.items.map((item) => ({
    ok: true as const,
    prompt: item.staticSegments.join('FILLED'),
    fills: item.instructions.map(() => 'FILLED'),
  })),
}));
void mock.module('../api/aiFill', () => ({
  resolveAiFill: resolveAiFillMock,
  resolveAiFillBatch: resolveAiFillBatchMock,
}));

const { useRollQueueSubmit } = await import('./useRollQueueSubmit');

const model = { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', pool: 'shared', backend: 'cloud', supportsReferenceImages: false } as unknown as Model;
const byokModel = { ...model, requiresKey: true } as unknown as Model;
const emptyLib: { variableLists: readonly VariableList[]; dimensions: readonly TagDimension[] } = { variableLists: [], dimensions: [] };

function queueFull429(retryAfterSeconds = 0): ApiError {
  return new ApiError(429, 'queue full', { code: 'QUEUE_FULL', retry_after_seconds: retryAfterSeconds }, undefined);
}

type GenerateMock = Mock<(req: GenerateRequest) => Promise<void>>;
type FireMock = Mock<(req: GenerateRequest) => void>;

interface Harness {
  toasts: { text: string; tone: string | undefined }[];
  generate: GenerateMock;
  fire: FireMock;
  submit: () => Promise<void>;
  press: () => void;
  stop: () => void;
  unmount: () => void;
}

function setup(opts: {
  prompt: string;
  model?: Model;
  library?: { variableLists: readonly VariableList[]; dimensions: readonly TagDimension[] } | undefined;
  rollQueue?: { id: string; text: string; seed: number; source: 'template' }[];
  generate?: (req: GenerateRequest) => Promise<void>;
}): Harness {
  const toasts: { text: string; tone: string | undefined }[] = [];
  const generate: GenerateMock = mock(opts.generate ?? ((_req: GenerateRequest) => Promise.resolve()));
  const fire: FireMock = mock((_req: GenerateRequest) => undefined);
  useAtelierStore.getState().setDraft({ prompt: opts.prompt });
  for (const r of opts.rollQueue ?? []) useAtelierStore.getState().stashRoll(r);
  const { result, unmount } = renderHook(() => useRollQueueSubmit({
    draft: useAtelierStore.getState().draft,
    effectiveModel: opts.model ?? model, effectiveRatio: '1:1', effectiveDuration: undefined,
    generate, fireGenerate: fire,
    addToast: (text: string, tone?: string) => { toasts.push({ text, tone }); return ''; },
    setComposerExpanded: () => undefined,
    library: 'library' in opts ? opts.library : emptyLib, libraryPending: false,
  }));
  const submit = async () => {
    const coalesces = opts.prompt.includes('{{ai-fill:')
      && (opts.rollQueue?.length ?? 0) === 0
      && !(opts.model ?? model).requiresKey
      && ('library' in opts ? opts.library !== undefined : true);
    await act(async () => {
      result.current.submitDraft();
      await new Promise((r) => setTimeout(r, coalesces ? 330 : 0));
    });
  };
  const press = () => { result.current.submitDraft(); };
  return { toasts, generate, fire, submit, press, stop: result.current.stopDraining, unmount };
}

describe('useRollQueueSubmit — {{ai-fill}} resolution', () => {
  beforeEach(() => {
    useAtelierStore.setState(initialAtelierState, true);
    resolveAiFillMock.mockClear();
    resolveAiFillMock.mockImplementation((req: AiFillRequest) =>
      Promise.resolve({ prompt: req.staticSegments.join('FILLED'), fills: req.instructions.map(() => 'FILLED') }),
    );
    resolveAiFillBatchMock.mockClear();
    resolveAiFillBatchMock.mockImplementation((req: AiFillBatchRequest): Promise<BatchMockResult> => Promise.resolve({
      items: req.items.map((item) => ({
        ok: true as const,
        prompt: item.staticSegments.join('FILLED'),
        fills: item.instructions.map(() => 'FILLED'),
      })),
    }));
  });

  test('composer prompt with an ai-fill token calls resolveAiFill once and fires the FILLED text', async () => {
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await h.submit();
    expect(resolveAiFillMock).toHaveBeenCalledTimes(1);
    expect(resolveAiFillBatchMock).not.toHaveBeenCalled();
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0]?.[0]?.prompt).toBe('a FILLED b');
  });

  test('two rapid idle presses batch their fills and fire without entering the drain', async () => {
    let release: ((value: BatchMockResult) => void) | undefined;
    resolveAiFillBatchMock.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await act(async () => {
      h.press();
      h.press();
      expect(useAtelierStore.getState().preparing).toBe(2);
      await new Promise((resolve) => setTimeout(resolve, 330));
    });
    expect(resolveAiFillBatchMock).toHaveBeenCalledTimes(1);
    expect(resolveAiFillBatchMock.mock.calls[0]?.[0].items).toHaveLength(2);
    expect(useAtelierStore.getState().draining).toBe(false);
    expect(h.generate).not.toHaveBeenCalled();
    await act(async () => {
      release?.({
        items: [
          { ok: true, prompt: 'first filled', fills: ['FILLED'] },
          { ok: true, prompt: 'second filled', fills: ['FILLED'] },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(resolveAiFillMock).not.toHaveBeenCalled();
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(useAtelierStore.getState().draining).toBe(false);
    expect(useAtelierStore.getState().preparing).toBe(0);
  });

  test('four rapid presses flush immediately at the batch cap', async () => {
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await act(async () => {
      h.press();
      h.press();
      h.press();
      h.press();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(resolveAiFillBatchMock).toHaveBeenCalledTimes(1);
    expect(resolveAiFillBatchMock.mock.calls[0]?.[0].items).toHaveLength(4);
    expect(h.generate).toHaveBeenCalledTimes(4);
  });

  test('batch capacity enqueues only affected composer rolls and starts the drain', async () => {
    let calls = 0;
    resolveAiFillBatchMock.mockImplementation((_req, signal) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new QueueFullError(25));
      return new Promise((_resolve, reject) => {
        const abort = () => { reject(new DOMException('aborted', 'AbortError')); };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    });
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await act(async () => {
      h.press();
      h.press();
      await new Promise((resolve) => setTimeout(resolve, 330));
      for (let i = 0; i < 30 && !useAtelierStore.getState().draining; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(useAtelierStore.getState().draining).toBe(true);
    expect(resolveAiFillBatchMock).toHaveBeenCalledTimes(2);
    expect(resolveAiFillBatchMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(resolveAiFillBatchMock.mock.calls[1]?.[1]).toBeInstanceOf(AbortSignal);
    expect(resolveAiFillBatchMock.mock.calls[1]?.[1]).not.toBe(resolveAiFillBatchMock.mock.calls[0]?.[1]);
    expect(h.toasts.filter((toast) => toast.text === 'At capacity — queued, will generate automatically.')).toHaveLength(1);
    expect(h.generate).not.toHaveBeenCalled();
    await act(async () => {
      h.stop();
      for (let i = 0; i < 30 && useAtelierStore.getState().draining; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(2);
    expect(useAtelierStore.getState().draft.rollQueue.every((roll) => roll.source === 'composer')).toBe(true);
    expect(useAtelierStore.getState().preparing).toBe(0);
  });

  test('Stop aborts a capacity-exposed fast flush before later groups can fire', async () => {
    const instruction = 'x'.repeat(AI_FILL_MAX_INSTRUCTION_CHARS);
    let flushSignal: AbortSignal | undefined;
    resolveAiFillBatchMock.mockImplementation((_req, signal) => {
      if (!flushSignal) {
        flushSignal = signal;
        return Promise.reject(new QueueFullError(25));
      }
      return new Promise((_resolve, reject) => {
        const abort = () => { reject(new DOMException('aborted', 'AbortError')); };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    });
    const h = setup({ prompt: `a {{ai-fill: ${instruction}}} b` });
    await act(async () => {
      h.press();
      h.press();
      h.press();
      h.press();
      for (let i = 0; i < 60; i += 1) {
        if (resolveAiFillBatchMock.mock.calls.length >= 3 && useAtelierStore.getState().draining) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      h.stop();
      for (let i = 0; i < 60 && useAtelierStore.getState().draining; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(resolveAiFillBatchMock).toHaveBeenCalledTimes(3);
    expect(flushSignal?.aborted).toBe(true);
    expect(h.generate).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().preparing).toBe(0);
  });

  test('a later capacity unit starts a new drain after the first drain completes', async () => {
    const instruction = 'x'.repeat(AI_FILL_MAX_INSTRUCTION_CHARS);
    let flushSignal: AbortSignal | undefined;
    let rejectLaterUnit: (() => void) | undefined;
    const drainSignals = new Set<AbortSignal>();
    resolveAiFillBatchMock.mockImplementation((req, signal) => {
      if (!flushSignal) {
        flushSignal = signal;
        return Promise.reject(new QueueFullError(0));
      }
      if (signal === flushSignal) {
        return new Promise((_resolve, reject) => {
          rejectLaterUnit = () => { reject(new QueueFullError(0)); };
        });
      }
      if (signal) drainSignals.add(signal);
      return Promise.resolve({
        items: req.items.map((item) => ({
          ok: true as const,
          prompt: item.staticSegments.join('FILLED'),
          fills: item.instructions.map(() => 'FILLED'),
        })),
      });
    });
    const h = setup({ prompt: `a {{ai-fill: ${instruction}}} b` });
    await act(async () => {
      h.press();
      h.press();
      h.press();
      h.press();
      let sawFirstDrain = false;
      for (let i = 0; i < 100; i += 1) {
        const draining = useAtelierStore.getState().draining;
        sawFirstDrain ||= draining;
        if (sawFirstDrain && !draining && rejectLaterUnit) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      rejectLaterUnit?.();
      for (let i = 0; i < 100; i += 1) {
        if (drainSignals.size >= 2 && !useAtelierStore.getState().draining) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(drainSignals.size).toBe(2);
    expect(h.generate).toHaveBeenCalledTimes(4);
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
    expect(useAtelierStore.getState().preparing).toBe(0);
  });

  test('generate-stage capacity preserves resolved fills and starts the drain', async () => {
    resolveAiFillBatchMock.mockImplementation(() => Promise.resolve({
      items: [
        { ok: true as const, prompt: 'first resolved', fills: ['FILLED'] },
        { ok: true as const, prompt: 'second resolved', fills: ['FILLED'] },
      ],
    }));
    const queuedComposerTexts: string[] = [];
    const unsubscribe = useAtelierStore.subscribe((state, previousState) => {
      if (state.draft.rollQueue === previousState.draft.rollQueue) return;
      queuedComposerTexts.push(...state.draft.rollQueue
        .filter((roll) => roll.source === 'composer')
        .map((roll) => roll.text));
    });
    let generateCalls = 0;
    const h = setup({
      prompt: 'a {{ai-fill: yard}} b',
      generate: () => {
        generateCalls += 1;
        return generateCalls === 1 ? Promise.reject(queueFull429()) : Promise.resolve();
      },
    });
    try {
      await act(async () => {
        h.press();
        h.press();
        for (let i = 0; i < 100; i += 1) {
          if (generateCalls >= 3 && !useAtelierStore.getState().draining) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      // The refused first press is requeued; the second queues behind it rather
      // than POSTing past it, each with the fill it already paid for.
      expect(queuedComposerTexts).toContain('first resolved');
      expect(queuedComposerTexts).toContain('second resolved');
      expect(h.generate.mock.calls.map((call) => call[0].prompt)).toEqual([
        'first resolved',
        'first resolved',
        'second resolved',
      ]);
      expect(h.generate.mock.calls.slice(0, 2).every((call) => isDrainOwned(call[0]))).toBe(true);
      expect(h.toasts.filter((toast) => toast.text === 'At capacity — queued, will generate automatically.')).toHaveLength(1);
      expect(h.generate).toHaveBeenCalledTimes(3);
      expect(resolveAiFillMock).not.toHaveBeenCalled();
      expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
      expect(useAtelierStore.getState().preparing).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  test('a capacity requeue at the queue cap keeps the paid fill', async () => {
    const fillers = Array.from({ length: 200 }, (_, index) => ({
      id: `filler-${index}`, text: `filler ${index}`, seed: index, source: 'template' as const,
    }));
    resolveAiFillBatchMock.mockImplementation(() => {
      // The queue reaches the cap while the coalesced fill is being paid for.
      useAtelierStore.getState().hydrateRollQueue(fillers);
      return Promise.resolve({
        items: [
          { ok: true as const, prompt: 'first resolved', fills: ['FILLED'] },
          { ok: true as const, prompt: 'second resolved', fills: ['FILLED'] },
        ],
      });
    });
    const refusedOnce = new Set<string>();
    const h = setup({
      prompt: 'a {{ai-fill: yard}} b',
      generate: (req) => {
        if (req.prompt.endsWith('resolved') && !refusedOnce.has(req.prompt)) {
          refusedOnce.add(req.prompt);
          return Promise.reject(queueFull429());
        }
        return Promise.resolve();
      },
    });
    await act(async () => {
      h.press();
      h.press();
      // The second press queues behind the first, so its refusal now comes
      // from the drain and waits out one backoff.
      for (let i = 0; i < 800; i += 1) {
        if (h.generate.mock.calls.length >= 204 && !useAtelierStore.getState().draining) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    const prompts = h.generate.mock.calls.map((call) => call[0].prompt);
    expect(prompts.filter((prompt) => prompt === 'first resolved')).toHaveLength(2);
    expect(prompts.filter((prompt) => prompt === 'second resolved')).toHaveLength(2);
    expect(resolveAiFillMock).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().toasts.some((toast) => toast.text.startsWith('Roll queue is limited'))).toBe(false);
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
  });

  test('batch quota stops the coalesced pipeline once and preserves the composer text', async () => {
    resolveAiFillBatchMock.mockImplementation(() => Promise.reject(new QuotaExhaustedError(120)));
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await act(async () => {
      h.press();
      h.press();
      await new Promise((resolve) => setTimeout(resolve, 330));
    });
    expect(resolveAiFillBatchMock).toHaveBeenCalledTimes(1);
    expect(resolveAiFillMock).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().draining).toBe(false);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
    expect(useAtelierStore.getState().draft.prompt).toBe('a {{ai-fill: yard}} b');
    expect(h.toasts.filter((toast) => /quota exhausted/i.test(toast.text))).toHaveLength(1);
    expect(useAtelierStore.getState().preparing).toBe(0);
  });

  test('an item-level coalesced batch miss retries only that item through single fill', async () => {
    resolveAiFillBatchMock.mockImplementation(() => Promise.resolve({
      items: [
        { ok: false as const },
        { ok: true as const, prompt: 'second batched', fills: ['BATCHED'] },
      ],
    }));
    resolveAiFillMock.mockImplementation((req: AiFillRequest) => Promise.resolve({
      prompt: req.staticSegments.join('SINGLE'),
      fills: ['SINGLE'],
    }));
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await act(async () => {
      h.press();
      h.press();
      await new Promise((resolve) => setTimeout(resolve, 330));
    });
    expect(resolveAiFillBatchMock).toHaveBeenCalledTimes(1);
    expect(resolveAiFillMock).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls.map((call) => call[0].prompt)).toEqual(['a SINGLE b', 'second batched']);
    expect(useAtelierStore.getState().draining).toBe(false);
    expect(useAtelierStore.getState().preparing).toBe(0);
  });

  test('genuine single-fallback failures settle every coalesced preparing item', async () => {
    resolveAiFillBatchMock.mockImplementation(() => Promise.resolve({
      items: [{ ok: false as const }, { ok: false as const }],
    }));
    resolveAiFillMock.mockImplementation(() => Promise.reject(new Error('provider boom')));
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await act(async () => {
      h.press();
      h.press();
      await new Promise((resolve) => setTimeout(resolve, 330));
    });
    expect(resolveAiFillMock).toHaveBeenCalledTimes(2);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.toasts.filter((toast) => /couldn't prepare/i.test(toast.text))).toHaveLength(2);
    expect(useAtelierStore.getState().preparing).toBe(0);
  });

  test('Stop clears a pending coalescing buffer and settles its preparing feedback', async () => {
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await act(async () => {
      h.press();
      expect(useAtelierStore.getState().preparing).toBe(1);
      h.stop();
      await new Promise((resolve) => setTimeout(resolve, 330));
    });
    expect(resolveAiFillMock).not.toHaveBeenCalled();
    expect(resolveAiFillBatchMock).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().preparing).toBe(0);
  });

  test('unmount aborts a pending coalesced flush and settles its preparing counter', async () => {
    let flushSignal: AbortSignal | undefined;
    // The fill answers even after the abort, so only the flush's own abort check
    // keeps the late result from firing.
    resolveAiFillBatchMock.mockImplementation(async (req, signal) => {
      flushSignal = signal;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        items: req.items.map((item) => ({
          ok: true as const,
          prompt: item.staticSegments.join('FILLED'),
          fills: item.instructions.map(() => 'FILLED'),
        })),
      };
    });
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await act(async () => {
      h.press();
      h.press();
      for (let i = 0; i < 100 && resolveAiFillBatchMock.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(useAtelierStore.getState().preparing).toBe(2);
      h.unmount();
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(flushSignal?.aborted).toBe(true);
    expect(h.generate).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().preparing).toBe(0);
  });

  test('each grouped item resolves its ai-fill request with distinct client entropy', async () => {
    let value = 100;
    const randomSpy = spyOn(globalThis.crypto, 'getRandomValues');
    randomSpy.mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint32Array) array[0] = value++;
      return array;
    });
    const choices = Array.from({ length: 256 }, (_, index) => `choice-${index}`).join('::');
    const h = setup({ prompt: `a {{ai-fill: {{random::${choices}}}}} b` });
    try {
      await act(async () => {
        h.press();
        h.press();
        await new Promise((resolve) => setTimeout(resolve, 330));
      });
      const instructions = resolveAiFillBatchMock.mock.calls[0]?.[0].items
        .map((batchItem) => batchItem.instructions[0]);
      expect(instructions).toHaveLength(2);
      expect(new Set(instructions).size).toBe(2);
    } finally {
      randomSpy.mockRestore();
    }
  });

  test('an announced backend counts in aiFillActive during the fill and releases after it', async () => {
    const midFill: Record<AiFillBackend, number>[] = [];
    resolveAiFillMock.mockImplementation((req: AiFillRequest, _signal?: AbortSignal, onBackend?: (backend: AiFillBackend) => void) => {
      onBackend?.('kimi');
      midFill.push({ ...useAtelierStore.getState().aiFillActive });
      return Promise.resolve({ prompt: req.staticSegments.join('FILLED'), fills: req.instructions.map(() => 'FILLED') });
    });
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await h.submit();
    expect(midFill).toEqual([{ kimi: 1, mimo: 0, grok: 0, 'gemini-argon': 0, 'deepseek-abliterated': 0, 'glm-abliterated': 0, gpt: 0 }]);
    expect(useAtelierStore.getState().aiFillActive).toEqual({ kimi: 0, mimo: 0, grok: 0, 'gemini-argon': 0, 'deepseek-abliterated': 0, 'glm-abliterated': 0, gpt: 0 });
  });

  test('a fill that fails after announcing its backend still releases the counter', async () => {
    resolveAiFillMock.mockImplementation((_req: AiFillRequest, _signal?: AbortSignal, onBackend?: (backend: AiFillBackend) => void) => {
      onBackend?.('mimo');
      return Promise.reject(new Error('boom'));
    });
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await h.submit();
    expect(h.generate).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().aiFillActive).toEqual({ kimi: 0, mimo: 0, grok: 0, 'gemini-argon': 0, 'deepseek-abliterated': 0, 'glm-abliterated': 0, gpt: 0 });
  });

  test('a retired card-notes token is stripped before ai-fill', async () => {
    resolveAiFillMock.mockImplementation((req: AiFillRequest) =>
      Promise.resolve({
        prompt: req.staticSegments.join('FILLED'),
        fills: req.instructions.map(() => 'FILLED'),
      }),
    );
    const h = setup({ prompt: 'a {{card-notes}}{{ai-fill: yard}} b' });
    await h.submit();

    expect(resolveAiFillMock.mock.calls[0]?.[0]).toEqual({
      staticSegments: ['a ', ' b'],
      instructions: ['yard'],
      modelId: 'gpt-image-2.5-sunburst',
    });
    expect(h.generate.mock.calls[0]?.[0]?.prompt).toBe('a FILLED b');
  });

  test('a retired card-notes token without ai-fill is stripped', async () => {
    const h = setup({ prompt: 'plain {{card-notes}} prompt' });
    await h.submit();
    expect(resolveAiFillMock).not.toHaveBeenCalled();
    expect(h.generate.mock.calls[0]?.[0]?.prompt).toBe('plain  prompt');
  });

  test('prompt with no ai-fill token never calls resolveAiFill', async () => {
    const h = setup({ prompt: 'plain prompt' });
    await h.submit();
    expect(resolveAiFillMock).toHaveBeenCalledTimes(0);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0]?.[0]?.prompt).toBe('plain prompt');
  });

  test('when resolveAiFill rejects, generate is not called and the actionable message is surfaced', async () => {
    // The server's curated message (e.g. over-length) is shown verbatim instead
    // of a generic "couldn't prepare" toast.
    resolveAiFillMock.mockImplementation(() => Promise.reject(new Error('Filled prompt is too long — 5000 / 4096 chars.')));
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await h.submit();
    expect(h.generate).toHaveBeenCalledTimes(0);
    expect(h.toasts.some((t) => t.tone === 'error' && /too long — 5000 \/ 4096/i.test(t.text))).toBe(true);
  });

  test('a messageless fill failure falls back to the generic prepare toast', async () => {
    resolveAiFillMock.mockImplementation(() => Promise.reject(new Error('')));
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await h.submit();
    expect(h.generate).toHaveBeenCalledTimes(0);
    expect(h.toasts.some((t) => t.tone === 'error' && /prepare the prompt/i.test(t.text))).toBe(true);
  });

  test('over-length queued roll is DROPPED (not restored) with a length toast', async () => {
    const long = 'x'.repeat(MAX_PROMPT_CHARS + 100);
    const h = setup({
      prompt: '',
      rollQueue: [{ id: 'q', text: long, seed: 1, source: 'template' }],
    });
    await h.submit();
    expect(h.generate).toHaveBeenCalledTimes(0);
    // Dropped, NOT restored — restoring an over-length roll loops forever.
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
    expect(h.toasts.some((t) => t.tone === 'error' && new RegExp(`over ${MAX_PROMPT_CHARS} chars`).test(t.text))).toBe(true);
  });

  test('a long ai-fill INSTRUCTION (short static) is NOT blocked by the prompt-length cap', async () => {
    // The instruction is a throwaway compile directive the LLM consumes — only
    // the static skeleton ("a " + " b") lands in the final prompt, so an
    // instruction longer than MAX_PROMPT_CHARS must still resolve and fire.
    const longInstruction = 'x'.repeat(MAX_PROMPT_CHARS + 100);
    const h = setup({ prompt: `a {{ai-fill: ${longInstruction}}} b` });
    await h.submit();
    expect(resolveAiFillMock).toHaveBeenCalledTimes(1);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0]?.[0]?.prompt).toBe('a FILLED b');
    expect(h.toasts.some((t) => t.tone === 'error' && /too long/i.test(t.text))).toBe(false);
  });

  test('over-cap STATIC text around an ai-fill token is still blocked (the cap protects the final prompt)', async () => {
    const longStatic = 'x'.repeat(MAX_PROMPT_CHARS + 100);
    const h = setup({ prompt: `${longStatic} {{ai-fill: yard}}` });
    await h.submit();
    // Static alone exceeds the cap → the fill can only make it worse → reject
    // before any LLM call (no wasted bill).
    expect(resolveAiFillMock).toHaveBeenCalledTimes(0);
    expect(h.generate).toHaveBeenCalledTimes(0);
    expect(h.toasts.some((t) => t.tone === 'error' && /too long after expanding tokens/i.test(t.text))).toBe(true);
  });

  test('BYOK: active ai-fill prompt wins over a queued roll for the keyed head', async () => {
    const h = setup({
      prompt: 'a {{ai-fill: yard}} b',
      model: byokModel,
      rollQueue: [{ id: 'q', text: 'queued roll', seed: 1, source: 'template' }],
    });
    await h.submit();
    expect(h.fire).toHaveBeenCalledTimes(1);
    expect(h.fire.mock.calls[0]?.[0]?.prompt).toBe('a FILLED b');
  });

  test('gated user (no library) keeps the literal token and makes no call', async () => {
    const h = setup({ prompt: 'a {{ai-fill: yard}} b', library: undefined });
    await h.submit();
    expect(resolveAiFillMock).toHaveBeenCalledTimes(0);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0]?.[0]?.prompt).toBe('a {{ai-fill: yard}} b');
  });

  test('BYOK fills ONLY the head — a queued ai-fill roll is never billed', async () => {
    const h = setup({
      prompt: 'a {{ai-fill: yard}} b',
      model: byokModel,
      rollQueue: [{ id: 'q', text: 'q {{ai-fill: pose}} z', seed: 1, source: 'template' }],
    });
    await h.submit();
    // Only the active head is filled; the queued ai-fill roll (discarded for BYOK) is not.
    expect(resolveAiFillMock).toHaveBeenCalledTimes(1);
    expect(h.fire).toHaveBeenCalledTimes(1);
    expect(h.fire.mock.calls[0]?.[0]?.prompt).toBe('a FILLED b');
  });

  test('single-owner drain: a press while draining queues the active composer prompt for the owner', async () => {
    const h = setup({
      prompt: 'active prompt',
      rollQueue: [{ id: 'q', text: 'queued {{ai-fill: yard}} roll', seed: 1, source: 'template' }],
    });
    await act(async () => {
      h.press(); // starts the drain (sets `draining` before the first await)
      h.press(); // drain already running → no-op (the single-owner guard)
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });
    const prompts = h.generate.mock.calls.map((c) => c[0].prompt);
    expect(prompts.filter((p) => p === 'queued FILLED roll')).toHaveLength(1);
    expect(prompts.filter((p) => p === 'active prompt')).toHaveLength(2);
    expect(h.toasts.some((t) => t.text === 'Added to the queue.')).toBe(true);
  });

  test('a queued roll whose batch already STARTED is not restored (no double-bill on retry)', async () => {
    // generate rejects with a StreamTruncatedError carrying a batchId → the batch
    // row exists and is billable; restoring the roll would let the user re-fire it.
    const h = setup({
      prompt: '',
      rollQueue: [{ id: 'q', text: 'queued roll', seed: 1, source: 'template' }],
      generate: () => Promise.reject(new StreamTruncatedError('batch-1')),
    });
    await h.submit();
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
  });

  test('a queued roll that fails PRE-batch is restored; a succeeding sibling is not', async () => {
    const h = setup({
      prompt: 'active prompt',
      rollQueue: [{ id: 'q', text: 'queued roll', seed: 1, source: 'template' }],
      generate: (req) => (req.prompt === 'queued roll'
        ? Promise.reject(new Error('pre-batch 429'))
        : Promise.resolve()),
    });
    await h.submit();
    // The pre-batch-failed roll is back in the queue; the active prompt is not.
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['q']);
  });

  test('quota on the active prompt: no generate() call fired, composer draft preserved, quota toast shown', async () => {
    resolveAiFillMock.mockImplementation(() => Promise.reject(new QuotaExhaustedError(120)));
    const h = setup({ prompt: 'a {{ai-fill: yard}} b' });
    await h.submit();
    // generate must never be called with a literal {{ai-fill}} string
    for (const call of h.generate.mock.calls) {
      expect(call[0].prompt).not.toContain('{{ai-fill');
    }
    expect(h.generate).toHaveBeenCalledTimes(0);
    // The unresolved token is still in the composer draft (not cleared)
    expect(useAtelierStore.getState().draft.prompt).toBe('a {{ai-fill: yard}} b');
    // A quota toast was shown
    expect(h.toasts.some((t) => /quota exhausted/i.test(t.text))).toBe(true);
  });

  test('quota on a queued roll: the roll is restored to the queue, generate() not called with literal {{ai-fill}} text, quota toast shown', async () => {
    resolveAiFillBatchMock.mockImplementation((_req: AiFillBatchRequest) =>
      Promise.reject(new QuotaExhaustedError(null)),
    );
    const h = setup({
      prompt: '',
      rollQueue: [{ id: 'q', text: 'q {{ai-fill: pose}} z', seed: 1, source: 'template' }],
    });
    await h.submit();
    // generate must never be called with a literal {{ai-fill}} string
    for (const call of h.generate.mock.calls) {
      expect(call[0].prompt).not.toContain('{{ai-fill');
    }
    expect(h.generate).toHaveBeenCalledTimes(0);
    // The queued roll is back in the queue
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['q']);
    // A quota toast was shown
    expect(h.toasts.some((t) => /quota exhausted/i.test(t.text))).toBe(true);
  });

  test('a transient (non-quota) fill failure: returns null (no quota toast), no generate() call with {{ai-fill}} text', async () => {
    resolveAiFillMock.mockImplementation(() => Promise.reject(new Error('transient 503')));
    const h = setup({
      prompt: 'plain active prompt',
      rollQueue: [{ id: 'q', text: 'q {{ai-fill: pose}} z', seed: 1, source: 'template' }],
    });
    await h.submit();
    // generate must never be called with a literal {{ai-fill}} string
    for (const call of h.generate.mock.calls) {
      expect(call[0].prompt).not.toContain('{{ai-fill');
    }
    // No quota toast — this is a plain failure, not quota-exhausted
    expect(h.toasts.some((t) => /quota exhausted/i.test(t.text))).toBe(false);
    // The active prompt (no ai-fill tokens) still generates normally
    expect(h.generate.mock.calls.some((c) => c[0].prompt === 'plain active prompt')).toBe(true);
  });

  test('batchable queued rolls resolve through one grouped preparation unit', async () => {
    const state: { release?: (value: { items: { ok: true; prompt: string; fills: string[] }[] }) => void } = {};
    resolveAiFillBatchMock.mockImplementation(() => new Promise((resolve) => { state.release = resolve; }));
    const h = setup({
      prompt: '',
      rollQueue: [
        { id: 's', text: '{{ai-fill: SLOW}}', seed: 1, source: 'template' },
        { id: 'f', text: '{{ai-fill: FAST}}', seed: 2, source: 'template' },
      ],
    });
    await act(async () => {
      h.press();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(resolveAiFillBatchMock).toHaveBeenCalledTimes(1);
    expect(resolveAiFillBatchMock.mock.calls[0]?.[0].items).toHaveLength(2);
    expect(h.generate).not.toHaveBeenCalled();
    await act(async () => {
      state.release?.({
        items: [
          { ok: true, prompt: 'slow filled', fills: ['SLOW'] },
          { ok: true, prompt: 'fast filled', fills: ['FAST'] },
        ],
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    const prompts = h.generate.mock.calls.map((call) => call[0].prompt);
    expect(prompts).toContain('slow filled');
    expect(prompts).toContain('fast filled');
  });

  test('mixed batchable rolls stay together for server-owned AI routing', async () => {
    const h = setup({
      prompt: '',
      rollQueue: [
        { id: 'k1', text: 'Kimi one: a 25-year-old woman {{ai-fill: KIMI_ONE}}', seed: 1, source: 'template' },
        { id: 'f1', text: 'Flash one: a 17-year-old girl {{ai-fill: FLASH_ONE}}', seed: 2, source: 'template' },
        { id: 'k2', text: 'Kimi two: another 25-year-old woman {{ai-fill: KIMI_TWO}}', seed: 3, source: 'template' },
        { id: 'f2', text: 'Flash two: another 17-year-old girl {{ai-fill: FLASH_TWO}}', seed: 4, source: 'template' },
      ],
    });
    await h.submit();

    const requests = resolveAiFillBatchMock.mock.calls.map((call) => call[0]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.items.map((batchItem) => batchItem.instructions[0])).toEqual([
      'KIMI_ONE',
      'FLASH_ONE',
      'KIMI_TWO',
      'FLASH_TWO',
    ]);
  });

  test('server-routed batches preserve queue order across the batch-size boundary', async () => {
    const h = setup({
      prompt: '',
      rollQueue: [
        { id: 'f1', text: 'Flash one: a 17-year-old girl {{ai-fill: FLASH_ONE}}', seed: 1, source: 'template' },
        { id: 'k1', text: 'Kimi one: a 25-year-old woman {{ai-fill: KIMI_ONE}}', seed: 2, source: 'template' },
        { id: 'f2', text: 'Flash two: another 17-year-old girl {{ai-fill: FLASH_TWO}}', seed: 3, source: 'template' },
        { id: 'k2', text: 'Kimi two: another 25-year-old woman {{ai-fill: KIMI_TWO}}', seed: 4, source: 'template' },
        { id: 'f3', text: 'Flash three: a teenage girl {{ai-fill: FLASH_THREE}}', seed: 5, source: 'template' },
        { id: 'k3', text: 'Kimi three: an adult woman {{ai-fill: KIMI_THREE}}', seed: 6, source: 'template' },
      ],
    });
    await h.submit();

    const requests = resolveAiFillBatchMock.mock.calls.map((call) => call[0]);
    expect(requests).toHaveLength(2);
    expect(requests.flatMap((request) => request.items.map((batchItem) => batchItem.instructions[0]))).toEqual([
      'FLASH_ONE',
      'KIMI_ONE',
      'FLASH_TWO',
      'KIMI_TWO',
      'FLASH_THREE',
      'KIMI_THREE',
    ]);
  });

  test('an item-level batch miss falls back to the existing single fill path for only that item', async () => {
    resolveAiFillBatchMock.mockImplementation(() => Promise.resolve({
      items: [
        { ok: false as const },
        { ok: true as const, prompt: 'second batched', fills: ['BATCHED'] },
      ],
    }));
    resolveAiFillMock.mockImplementation((req: AiFillRequest) => Promise.resolve({
      prompt: req.staticSegments.join('SINGLE'),
      fills: ['SINGLE'],
    }));
    const h = setup({
      prompt: '',
      rollQueue: [
        { id: 'a', text: 'first {{ai-fill: A}}', seed: 1, source: 'template' },
        { id: 'b', text: 'second {{ai-fill: B}}', seed: 2, source: 'template' },
      ],
    });
    await h.submit();
    expect(resolveAiFillBatchMock).toHaveBeenCalledTimes(1);
    expect(resolveAiFillMock).toHaveBeenCalledTimes(1);
    expect(resolveAiFillMock.mock.calls[0]?.[0].instructions).toEqual(['A']);
    const prompts = h.generate.mock.calls.map((call) => call[0].prompt);
    expect(prompts).toContain('first SINGLE');
    expect(prompts).toContain('second batched');
  });

  test('each submit sends a fresh random image seed so repeat Generate gives variance', async () => {
    const h = setup({ prompt: 'a plain prompt' });
    await h.submit();
    await h.submit();
    const seeds = h.generate.mock.calls.map((c) => c[0].seed);
    expect(seeds).toHaveLength(2);
    expect(seeds.every((s) => typeof s === 'number')).toBe(true);
    expect(seeds[0]).not.toBe(seeds[1]);
  });

  test('a locked seed reproduces the same image seed across repeat submits', async () => {
    const h = setup({ prompt: 'a plain prompt' });
    useAtelierStore.getState().setPickerSeed(424242);
    useAtelierStore.getState().setPickerLockSeed(true);
    await h.submit();
    await h.submit();
    const seeds = h.generate.mock.calls.map((c) => c[0].seed);
    expect(seeds).toEqual([424242, 424242]);
  });

  test('the active error toast is not clobbered by a concurrent queued roll error', async () => {
    // Under the concurrent pipeline, a queued roll's failure must NOT overwrite
    // the head/active prompt's error message (only the head records fillError).
    resolveAiFillBatchMock.mockImplementation((req: AiFillBatchRequest) => Promise.resolve({
      items: req.items.map(() => ({ ok: false as const })),
    }));
    resolveAiFillMock.mockImplementation((req: AiFillRequest) =>
      Promise.reject(new Error(req.instructions[0] === 'ACTIVE' ? 'active failure msg' : 'queued failure msg')),
    );
    const h = setup({
      prompt: 'a {{ai-fill: ACTIVE}} b',
      rollQueue: [{ id: 'q', text: 'q {{ai-fill: QUEUED}} z', seed: 1, source: 'template' }],
    });
    await h.submit();
    expect(h.toasts.some((t) => t.tone === 'error' && t.text.includes('active failure msg'))).toBe(true);
    expect(h.toasts.some((t) => t.text.includes('queued failure msg'))).toBe(false);
  });

  test('clears the search query before the first generate fires (onFirstFire side effects)', async () => {
    const h = setup({
      prompt: '',
      rollQueue: [{ id: 'q', text: 'queued roll', seed: 1, source: 'template' }],
      generate: () => {
        // onFirstFire runs setQ('') before firing this item's generate().
        expect(useAtelierStore.getState().q).toBe('');
        return Promise.resolve();
      },
    });
    useAtelierStore.getState().setQ('cats');
    await h.submit();
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  test('a composer press keeps one key from capacity requeue through the drain', async () => {
    const stashedComposerIds: string[] = [];
    const unsubscribe = useAtelierStore.subscribe((state, previousState) => {
      if (state.draft.rollQueue === previousState.draft.rollQueue) return;
      stashedComposerIds.push(...state.draft.rollQueue
        .filter((roll) => roll.source === 'composer')
        .map((roll) => roll.id));
    });
    let calls = 0;
    resolveAiFillMock.mockImplementation((req: AiFillRequest) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new QueueFullError(1));
      return Promise.resolve({ prompt: req.staticSegments.join('FILLED'), fills: ['FILLED'] });
    });
    try {
      const h = setup({ prompt: 'a {{ai-fill: x}} b' });
      await act(async () => {
        h.press();
        for (let i = 0; i < 400 && (h.generate.mock.calls.length === 0 || useAtelierStore.getState().draining); i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      const stashedKey = stashedComposerIds[0];
      expect(typeof stashedKey).toBe('string');
      expect(new Set(stashedComposerIds).size).toBe(1);
      expect(h.generate).toHaveBeenCalledTimes(1);
      expect(h.generate.mock.calls[0]?.[0].idempotencyKey).toBe(stashedKey);
    } finally {
      unsubscribe();
    }
  });

  test('coalesced presses carry distinct keys, a capacity-requeued item keeps its own, and the later press queues behind it', async () => {
    resolveAiFillBatchMock.mockImplementation(() => Promise.resolve({
      items: [
        { ok: true as const, prompt: 'first resolved', fills: ['FILLED'] },
        { ok: true as const, prompt: 'second resolved', fills: ['FILLED'] },
      ],
    }));
    const stashedIdByText = new Map<string, string>();
    const unsubscribe = useAtelierStore.subscribe((state) => {
      for (const roll of state.draft.rollQueue) stashedIdByText.set(roll.text, roll.id);
    });
    let generateCalls = 0;
    const h = setup({
      prompt: 'a {{ai-fill: yard}} b',
      generate: (req) => {
        generateCalls += 1;
        // Only the first press's item hits the queued-batch cap.
        return generateCalls === 1 && req.prompt === 'first resolved' ? Promise.reject(queueFull429()) : Promise.resolve();
      },
    });
    try {
      await act(async () => {
        h.press();
        h.press();
        for (let i = 0; i < 100; i += 1) {
          if (generateCalls >= 3 && !useAtelierStore.getState().draining) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      const requests = h.generate.mock.calls.map((call) => call[0]);
      // The refused first press keeps its place: the second never POSTs past it.
      expect(requests.map((req) => req.prompt)).toEqual(['first resolved', 'first resolved', 'second resolved']);
      const [firstKey, retryKey, secondKey] = requests.map((req) => req.idempotencyKey);
      expect(typeof firstKey).toBe('string');
      expect(typeof secondKey).toBe('string');
      expect(firstKey).not.toBe(secondKey);
      expect(retryKey).toBe(firstKey);
      expect(stashedIdByText.get('first resolved')).toBe(firstKey);
      expect(stashedIdByText.get('second resolved')).toBe(secondKey);
    } finally {
      unsubscribe();
    }
  });

  test('every generate call carries a non-empty idempotencyKey', async () => {
    const h = setup({
      prompt: 'composer {{ai-fill: x}} text',
      rollQueue: [
        { id: 'q1', text: 'queued plain', seed: 1, source: 'template' },
        { id: 'q2', text: 'queued {{ai-fill: y}} fill', seed: 1, source: 'template' },
      ],
    });
    await h.submit();
    for (let i = 0; i < 100 && useAtelierStore.getState().draining; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    const drainKeys = h.generate.mock.calls.map((call) => call[0].idempotencyKey);
    expect(drainKeys).toHaveLength(3);
    expect(drainKeys.slice(0, 2)).toEqual(['q1', 'q2']);
    expect(typeof drainKeys[2]).toBe('string');
    expect(drainKeys[2]).not.toBe('');
    expect(new Set(drainKeys).size).toBe(3);

    const plain = setup({ prompt: 'a plain prompt' });
    await plain.submit();
    await plain.submit();
    const plainKeys = plain.generate.mock.calls.map((call) => call[0].idempotencyKey);
    expect(plainKeys).toHaveLength(2);
    expect(plainKeys.every((key) => typeof key === 'string' && key.length > 0)).toBe(true);
    expect(plainKeys[0]).not.toBe(plainKeys[1]);

    useAtelierStore.setState(initialAtelierState, true);
    const byok = setup({ prompt: 'a {{ai-fill: yard}} b', model: byokModel });
    await byok.submit();
    expect(byok.fire).toHaveBeenCalledTimes(1);
    expect(typeof byok.fire.mock.calls[0]?.[0].idempotencyKey).toBe('string');
    expect(byok.fire.mock.calls[0]?.[0].idempotencyKey).not.toBe('');
  });
});
