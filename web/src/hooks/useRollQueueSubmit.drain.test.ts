import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import type { AiFillBatchRequest, AiFillRequest, GenerateRequest, Model, TagDimension, VariableList } from '@atelier/shared';
import { AI_FILL_MAX_INPUT_CHARS, AI_FILL_MAX_INSTRUCTION_CHARS } from '@atelier/shared/ai-fill';
import { useAtelierStore, initialAtelierState, type ToastAction } from '../store/atelier';
import { QueueFullError } from '../api/queueFullRetry';
import { ApiError } from '../api/client';
import { loadRollQueue, rollQueueStorageKey, setRollQueueScope } from '../lib/rollQueuePersist';

// Mock the ai-fill SSE client before the hook module is loaded.
const resolveAiFillMock = mock((req: AiFillRequest) =>
  Promise.resolve({ prompt: req.staticSegments.join('FILLED'), fills: req.instructions.map(() => 'FILLED') }),
);
interface BatchMockResult {
  items: ({ ok: true; prompt: string; fills: string[] } | { ok: false })[];
}
const resolveAiFillBatchMock = mock((req: AiFillBatchRequest): Promise<BatchMockResult> => Promise.resolve({
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
const emptyLib: { variableLists: readonly VariableList[]; dimensions: readonly TagDimension[] } = { variableLists: [], dimensions: [] };

function queueFull429(retryAfterSeconds = 0): ApiError {
  return new ApiError(429, 'queue full', { code: 'QUEUE_FULL', retry_after_seconds: retryAfterSeconds }, undefined);
}

interface Harness {
  toasts: { text: string; tone: string | undefined; durationMs: number | undefined; action: ToastAction | undefined }[];
  generate: ReturnType<typeof mock>;
  submitDraft: () => void;
  stopDraining: () => void;
  submitPrepared: (request: GenerateRequest) => void;
}

function setup(opts: {
  prompt?: string;
  rollQueue?: { id: string; text: string; seed: number; source: 'template' }[];
  generate?: (req: GenerateRequest, options?: { onAccepted?: (batchId: string) => void }) => Promise<unknown>;
}): Harness {
  const toasts: Harness['toasts'] = [];
  const generate = mock(opts.generate ?? ((_req: GenerateRequest, _options?: { onAccepted?: (batchId: string) => void }) => Promise.resolve()));
  useAtelierStore.getState().setDraft({ prompt: opts.prompt ?? '' });
  for (const r of opts.rollQueue ?? []) useAtelierStore.getState().stashRoll(r);
  const { result } = renderHook(() => useRollQueueSubmit({
    draft: useAtelierStore.getState().draft,
    effectiveModel: model, effectiveRatio: '1:1', effectiveDuration: undefined,
    generate, fireGenerate: () => undefined,
    addToast: (text: string, tone?: 'success' | 'error' | 'soft', durationMs?: number, action?: ToastAction) => {
      toasts.push({ text, tone, durationMs, action });
      return '';
    },
    setComposerExpanded: () => undefined,
    library: emptyLib, libraryPending: false,
  }));
  return { toasts, generate, submitDraft: result.current.submitDraft, stopDraining: result.current.stopDraining, submitPrepared: result.current.submitPrepared };
}

// Drives a drain to completion: kicks the submit, then polls until the store's
// `draining` flag clears (or a generous timeout), wrapped in act().
async function runDrain(h: Harness): Promise<void> {
  await act(async () => {
    h.submitDraft();
    for (let i = 0; i < 400 && useAtelierStore.getState().draining; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 0));
  });
}

const roll = (id: string, text: string) => ({ id, text, seed: 1, source: 'template' as const });

async function waitUntil(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const prompts = (h: Harness) => h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt);

// Stops a drain while the composer prompt's POST is unanswered, so the visible
// queue is empty, then presses Generate again: the press must wait for the answer.
async function pressAfterUnansweredComposer(prompt: string, submitted: string, settleMs = 20): Promise<void> {
  let acceptComposer: (() => void) | undefined;
  const h = setup({
    prompt,
    rollQueue: [roll('a', 'first plain')],
    generate: (req, options) => {
      if (req.prompt === submitted && acceptComposer === undefined) {
        return new Promise<void>((resolve) => {
          acceptComposer = () => {
            options?.onAccepted?.('batch-composer');
            resolve();
          };
        });
      }
      queueMicrotask(() => { options?.onAccepted?.(`batch-${req.prompt}`); });
      return Promise.resolve();
    },
  });
  await act(async () => {
    h.submitDraft();
    for (let i = 0; i < 100 && h.generate.mock.calls.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    h.stopDraining();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
  await act(async () => {
    h.submitDraft();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  });
  expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual(['first plain', submitted]);
  await act(async () => {
    acceptComposer?.();
    for (let i = 0; i < 100 && (h.generate.mock.calls.length < 3 || useAtelierStore.getState().draining); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
  expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual(['first plain', submitted, submitted]);
}

describe('useRollQueueSubmit — durable drain (backpressure, no silent drops)', () => {
  beforeEach(() => {
    setRollQueueScope('drain-test');
    sessionStorage.removeItem(rollQueueStorageKey('drain-test'));
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

  test('ai-fill QUEUE_FULL is backpressure: the roll is retried and fires, never dropped', async () => {
    let calls = 0;
    resolveAiFillBatchMock.mockImplementation((req: AiFillBatchRequest) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new QueueFullError(1));   // first pass: pool busy
      return Promise.resolve({ items: req.items.map((item) => ({
        ok: true as const,
        prompt: item.staticSegments.join('FILLED'),
        fills: ['FILLED'],
      })) });
    });
    const h = setup({ rollQueue: [roll('q', 'a {{ai-fill: x}} b')] });
    await runDrain(h);
    expect(calls).toBe(2);                                  // retried after backpressure
    expect(h.generate).toHaveBeenCalledTimes(1);            // eventually fired
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);  // consumed, not stuck
  });

  test('submits the displayed queue in order, releasing each row on acceptance and admitting a mid-burst stash before earlier streams finish', async () => {
    let finishFill: ((value: BatchMockResult) => void) | undefined;
    let acceptFirst: (() => void) | undefined;
    let finishFirst: (() => void) | undefined;
    resolveAiFillBatchMock.mockImplementation(() => new Promise((resolve) => { finishFill = resolve; }));
    const h = setup({
      rollQueue: [roll('a', 'first {{ai-fill: x}}'), roll('b', 'second plain')],
      generate: (req, options) => {
        if (req.prompt === 'first FILLED') return new Promise<void>((resolve) => {
          acceptFirst = () => { options?.onAccepted?.('batch-a'); };
          finishFirst = resolve;
        });
        return Promise.resolve();
      },
    });

    try {
      await act(async () => {
        h.submitDraft();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(h.generate).not.toHaveBeenCalled();

      await act(async () => {
        finishFill?.({ items: [{ ok: true, prompt: 'first FILLED', fills: ['FILLED'] }] });
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Reuse the original submit closure while the first POST is pending.
        useAtelierStore.getState().stashRoll(roll('c', 'third plain'));
        h.submitDraft();
        h.submitDraft();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual(['first FILLED']);

      await act(async () => {
        acceptFirst?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        for (let i = 0; i < 100 && h.generate.mock.calls.length < 3; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      // Acceptance, rather than completion of the long-lived stream, releases
      // the next queued submission, and the roll stashed mid-burst follows at
      // once instead of waiting for the first stream.
      expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual(['first FILLED', 'second plain', 'third plain']);
      expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
      expect(useAtelierStore.getState().draining).toBe(true);
      await act(async () => {
        finishFirst?.();
        for (let i = 0; i < 100 && useAtelierStore.getState().draining; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      expect(useAtelierStore.getState().draining).toBe(false);
      expect(h.generate).toHaveBeenCalledTimes(3);
    } finally {
      h.stopDraining();
      await act(async () => {
        finishFill?.({ items: [{ ok: true, prompt: 'first FILLED', fills: ['FILLED'] }] });
        acceptFirst?.();
        finishFirst?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  });

  test('Stop returns at once while a submission waits for its answer; a later refusal restores the roll', async () => {
    let refuse: ((error: unknown) => void) | undefined;
    const h = setup({
      rollQueue: [roll('a', 'first plain')],
      generate: () => new Promise<void>((_resolve, reject) => { refuse = reject; }),
    });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 100 && h.generate.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(h.generate).toHaveBeenCalledTimes(1);
    await act(async () => {
      h.stopDraining();
      for (let i = 0; i < 100 && useAtelierStore.getState().draining; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    // Stopped without waiting for the POST, whose roll stays saved in flight.
    expect(useAtelierStore.getState().draining).toBe(false);
    expect(loadRollQueue().map((queued) => queued.id)).toEqual(['a']);
    await act(async () => {
      // The POST answers after Stop: the per-user queue was full, so no batch exists.
      refuse?.(queueFull429());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useAtelierStore.getState().draft.rollQueue.map((queued) => queued.id)).toEqual(['a']);
  });

  test('a submission accepted after Stop stays consumed and leaves nothing in flight', async () => {
    let accept: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const h = setup({
      rollQueue: [roll('a', 'first plain')],
      generate: (_req, options) => new Promise<void>((resolve) => {
        accept = () => { options?.onAccepted?.('batch-a'); };
        finish = resolve;
      }),
    });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 100 && h.generate.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      h.stopDraining();
      for (let i = 0; i < 100 && useAtelierStore.getState().draining; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    await act(async () => {
      accept?.();
      finish?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
    expect(loadRollQueue()).toEqual([]);
  });

  test('Stop keeps a fill already made for a row waiting behind an earlier submission', async () => {
    let acceptFirst: (() => void) | undefined;
    let finishFirst: (() => void) | undefined;
    const h = setup({
      rollQueue: [roll('a', 'first plain'), roll('b', 'second {{ai-fill: x}}')],
      generate: (req, options) => {
        if (req.prompt !== 'first plain') return Promise.resolve();
        return new Promise<void>((resolve) => {
          acceptFirst = () => { options?.onAccepted?.('batch-a'); };
          finishFirst = resolve;
        });
      },
    });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 100 && (h.generate.mock.calls.length === 0 || resolveAiFillBatchMock.mock.calls.length === 0); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(resolveAiFillBatchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      h.stopDraining();
      await new Promise((resolve) => setTimeout(resolve, 0));
      acceptFirst?.();
      for (let i = 0; i < 100 && useAtelierStore.getState().draining; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    // Row a made its batch; row b comes back with the text its fill already paid for.
    expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual(['first plain']);
    expect(useAtelierStore.getState().draft.rollQueue.map((queued) => [queued.id, queued.text])).toEqual([
      ['b', 'second FILLED'],
    ]);
    await act(async () => {
      finishFirst?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  test('Clear after Stop drops a roll whose POST is still unanswered, from the queue and the saved copy', async () => {
    let refuse: ((error: unknown) => void) | undefined;
    const h = setup({
      rollQueue: [roll('a', 'first plain')],
      generate: () => new Promise<void>((_resolve, reject) => { refuse = reject; }),
    });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 100 && h.generate.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      h.stopDraining();
      for (let i = 0; i < 100 && useAtelierStore.getState().draining; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(loadRollQueue().map((queued) => queued.id)).toEqual(['a']);
    act(() => { useAtelierStore.getState().clearRollQueue(); });
    // A reload now brings nothing back.
    expect(loadRollQueue()).toEqual([]);
    await act(async () => {
      refuse?.(queueFull429());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
    expect(loadRollQueue()).toEqual([]);
  });

  test('Generate after Stop waits for the unanswered submission, so a refused roll keeps its place', async () => {
    let refuseFirst: ((error: unknown) => void) | undefined;
    const h = setup({
      rollQueue: [roll('a', 'first plain'), roll('b', 'second plain')],
      generate: (req, options) => {
        if (req.prompt === 'first plain' && refuseFirst === undefined) {
          return new Promise<void>((_resolve, reject) => { refuseFirst = reject; });
        }
        queueMicrotask(() => { options?.onAccepted?.(`batch-${req.prompt}`); });
        return Promise.resolve();
      },
    });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 100 && h.generate.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      h.stopDraining();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Stop frees Generate and returns every unconfirmed row at once, in place.
    expect(useAtelierStore.getState().draining).toBe(false);
    expect(useAtelierStore.getState().draft.rollQueue.map((queued) => queued.id)).toEqual(['a', 'b']);
    expect(loadRollQueue().map((queued) => queued.id)).toEqual(['a', 'b']);

    await act(async () => {
      h.submitDraft();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // The resumed drain may not pass row a while its POST is unanswered.
    expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual(['first plain']);

    await act(async () => {
      refuseFirst?.(queueFull429());
      for (let i = 0; i < 100 && (h.generate.mock.calls.length < 3 || useAtelierStore.getState().draining); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual([
      'first plain',
      'first plain',
      'second plain',
    ]);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
    expect(loadRollQueue()).toEqual([]);
  });

  test('a composer prompt pressed after Stop waits for the earlier one still unanswered', async () => {
    await pressAfterUnansweredComposer('composer plain', 'composer plain');
  });

  test('an ai-fill prompt pressed after Stop waits for the earlier one still unanswered', async () => {
    // Longer than the coalescing window, which would otherwise fire it alone.
    await pressAfterUnansweredComposer('composer {{ai-fill: x}}', 'composer FILLED', 400);
  });

  test("Clear's Undo after Stop never brings back a roll accepted meanwhile", async () => {
    let acceptFirst: (() => void) | undefined;
    const h = setup({
      rollQueue: [roll('a', 'first plain'), roll('b', 'second plain')],
      generate: (req, options) => {
        if (req.prompt === 'first plain' && acceptFirst === undefined) {
          return new Promise<void>((resolve) => {
            acceptFirst = () => {
              options?.onAccepted?.('batch-a');
              resolve();
            };
          });
        }
        queueMicrotask(() => { options?.onAccepted?.(`batch-${req.prompt}`); });
        return Promise.resolve();
      },
    });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 100 && h.generate.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      h.stopDraining();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Clear keeps an Undo snapshot of the visible queue, row a included.
    const snapshot = [...useAtelierStore.getState().draft.rollQueue];
    expect(snapshot.map((queued) => queued.id)).toEqual(['a', 'b']);
    act(() => { useAtelierStore.getState().clearRollQueue(); });
    await act(async () => {
      acceptFirst?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => { useAtelierStore.getState().restoreRollQueue(snapshot); });
    expect(useAtelierStore.getState().draft.rollQueue.map((queued) => queued.id)).toEqual(['b']);
    expect(loadRollQueue().map((queued) => queued.id)).toEqual(['b']);

    await runDrain(h);
    expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual(['first plain', 'second plain']);
  });

  test('Clear while a press waits on a stopped drain discards that press', async () => {
    let refuseFirst: ((error: unknown) => void) | undefined;
    const h = setup({
      prompt: 'composer plain',
      rollQueue: [roll('a', 'first plain')],
      generate: (req, options) => {
        if (req.prompt === 'first plain') {
          return new Promise<void>((_resolve, reject) => { refuseFirst = reject; });
        }
        queueMicrotask(() => { options?.onAccepted?.(`batch-${req.prompt}`); });
        return Promise.resolve();
      },
    });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 100 && h.generate.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      h.stopDraining();
      await new Promise((resolve) => setTimeout(resolve, 0));
      h.submitDraft();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() => { useAtelierStore.getState().clearRollQueue(); });
    await act(async () => {
      refuseFirst?.(queueFull429());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual(['first plain']);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
    expect(useAtelierStore.getState().draining).toBe(false);
  });

  test('a row stashed after Stop waits for the composer prompt still unanswered', async () => {
    let acceptComposer: (() => void) | undefined;
    const h = setup({
      prompt: 'composer plain',
      rollQueue: [roll('a', 'first plain')],
      generate: (req, options) => {
        if (req.prompt === 'composer plain' && acceptComposer === undefined) {
          return new Promise<void>((resolve) => {
            acceptComposer = () => {
              options?.onAccepted?.('batch-composer');
              resolve();
            };
          });
        }
        queueMicrotask(() => { options?.onAccepted?.(`batch-${req.prompt}`); });
        return Promise.resolve();
      },
    });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 100 && h.generate.mock.calls.length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      h.stopDraining();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual(['first plain', 'composer plain']);
    await act(async () => {
      useAtelierStore.getState().stashRoll(roll('c', 'third plain'));
      h.submitDraft();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual(['first plain', 'composer plain']);
    await act(async () => {
      acceptComposer?.();
      for (let i = 0; i < 100 && (h.generate.mock.calls.length < 4 || useAtelierStore.getState().draining); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual([
      'first plain',
      'composer plain',
      'third plain',
      'composer plain',
    ]);
  });

  test('a roll unanswered at Stop goes back in its place, saved copy included, and stays when refused', async () => {
    let refuseSecond: ((error: unknown) => void) | undefined;
    const h = setup({
      rollQueue: [roll('a', 'first plain'), roll('b', 'second plain'), roll('c', 'third plain')],
      generate: (req) => {
        if (req.prompt === 'first plain') return Promise.reject(new ApiError(500, 'provider down', undefined, undefined));
        return new Promise<void>((_resolve, reject) => { refuseSecond = reject; });
      },
    });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 100 && h.generate.mock.calls.length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      h.stopDraining();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual(['first plain', 'second plain']);
    // A reload before the answer resumes in display order.
    expect(loadRollQueue().map((queued) => queued.id)).toEqual(['a', 'b', 'c']);
    await act(async () => {
      refuseSecond?.(queueFull429());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useAtelierStore.getState().draft.rollQueue.map((queued) => queued.id)).toEqual(['a', 'b', 'c']);
    expect(loadRollQueue().map((queued) => queued.id)).toEqual(['a', 'b', 'c']);
  });

  test('a fill finished behind an unanswered submission is saved with its roll', async () => {
    let acceptFirst: (() => void) | undefined;
    const h = setup({
      rollQueue: [roll('a', 'first plain'), roll('b', 'second {{ai-fill: x}}')],
      generate: (req, options) => {
        if (req.prompt === 'first plain') return new Promise<void>((resolve) => {
          acceptFirst = () => {
            options?.onAccepted?.('batch-a');
            resolve();
          };
        });
        queueMicrotask(() => { options?.onAccepted?.(`batch-${req.prompt}`); });
        return Promise.resolve();
      },
    });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 100 && (h.generate.mock.calls.length === 0 || resolveAiFillBatchMock.mock.calls.length === 0); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // A reload now would resume row b without paying for its fill again.
    expect(loadRollQueue().map((queued) => [queued.id, queued.text])).toEqual([
      ['a', 'first plain'],
      ['b', 'second FILLED'],
    ]);
    await act(async () => {
      acceptFirst?.();
      for (let i = 0; i < 100 && useAtelierStore.getState().draining; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(loadRollQueue()).toEqual([]);
  });

  test('Stop while generation streams run lets the next press start at once', async () => {
    let finishFirst: (() => void) | undefined;
    const h = setup({
      rollQueue: [roll('a', 'first plain')],
      generate: (req, options) => {
        queueMicrotask(() => { options?.onAccepted?.(`batch-${req.prompt}`); });
        if (req.prompt === 'first plain') return new Promise<void>((resolve) => { finishFirst = resolve; });
        return Promise.resolve();
      },
    });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 100 && h.generate.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      h.stopDraining();
      useAtelierStore.getState().stashRoll(roll('b', 'second plain'));
      h.submitDraft();
      for (let i = 0; i < 100 && h.generate.mock.calls.length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    // Row a's stream is still running; row b was not held behind it.
    expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).prompt)).toEqual(['first plain', 'second plain']);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
    await act(async () => {
      finishFirst?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  test('a single composer prompt joins the durable drain after ai-fill backpressure', async () => {
    const seenSources: string[] = [];
    const unsubscribe = useAtelierStore.subscribe((state, previousState) => {
      if (state.draft.rollQueue === previousState.draft.rollQueue) return;
      seenSources.push(...state.draft.rollQueue.map((queued) => queued.source));
    });
    let calls = 0;
    resolveAiFillMock.mockImplementation((req: AiFillRequest) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new QueueFullError(1));
      return Promise.resolve({ prompt: req.staticSegments.join('FILLED'), fills: ['FILLED'] });
    });
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const h = setup({ prompt: 'a {{ai-fill: x}} b' });
      await act(async () => {
        h.submitDraft();
        for (let i = 0; i < 400 && h.generate.mock.calls.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      expect(h.generate).toHaveBeenCalledTimes(1);
      expect(seenSources).toContain('composer');
      expect(h.toasts.some((toast) => toast.text === 'At capacity — queued, will generate automatically.')).toBe(true);
      expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
    } finally {
      Math.random = originalRandom;
      unsubscribe();
    }
  });

  test('generate QUEUE_FULL (queued-batch cap) re-queues the roll and retries — never lost', async () => {
    let gcalls = 0;
    const h = setup({
      rollQueue: [roll('q', 'plain roll')],
      generate: () => { gcalls += 1; return gcalls === 1 ? Promise.reject(queueFull429()) : Promise.resolve(); },
    });
    await runDrain(h);
    expect(gcalls).toBe(2);                                 // first QUEUE_FULL, then retried
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);  // fired on retry
  });

  test('a QUEUE_FULL retry re-POSTs the same roll with the same idempotency key and a different seed', async () => {
    let gcalls = 0;
    const h = setup({
      rollQueue: [roll('a', 'plain roll')],
      generate: () => { gcalls += 1; return gcalls === 1 ? Promise.reject(queueFull429()) : Promise.resolve(); },
    });
    await runDrain(h);
    const requests = h.generate.mock.calls.map((call) => call[0] as GenerateRequest);
    expect(requests).toHaveLength(2);
    expect(requests.map((req) => req.idempotencyKey)).toEqual(['a', 'a']);
    expect(requests[0]?.seed).not.toBe(requests[1]?.seed);
  });

  test('a roll restored by Stop keeps its key on the next drain', async () => {
    let refuseFirst: ((error: unknown) => void) | undefined;
    const h = setup({
      rollQueue: [roll('a', 'first plain')],
      generate: (_req, options) => {
        if (refuseFirst === undefined) {
          return new Promise<void>((_resolve, reject) => { refuseFirst = reject; });
        }
        queueMicrotask(() => { options?.onAccepted?.('batch-a'); });
        return Promise.resolve();
      },
    });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 100 && h.generate.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      h.stopDraining();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      refuseFirst?.(queueFull429());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useAtelierStore.getState().draft.rollQueue.map((queued) => queued.id)).toEqual(['a']);

    await runDrain(h);

    expect(h.generate.mock.calls.map((call) => (call[0] as GenerateRequest).idempotencyKey)).toEqual(['a', 'a']);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
  });

  test('a whole burst with one always-busy slot still drains every roll (no drops)', async () => {
    // Two rolls; the first ai-fill call of each pass is busy, the rest succeed —
    // exercises repeated backpressure without ever dropping a roll.
    let calls = 0;
    resolveAiFillBatchMock.mockImplementation((req: AiFillBatchRequest) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new QueueFullError(1));
      return Promise.resolve({ items: req.items.map((item) => ({
        ok: true as const,
        prompt: item.staticSegments.join('FILLED'),
        fills: ['FILLED'],
      })) });
    });
    const h = setup({ rollQueue: [roll('a', 'a {{ai-fill: x}} z'), roll('b', 'b {{ai-fill: x}} z')] });
    await runDrain(h);
    expect(h.generate).toHaveBeenCalledTimes(2);            // both fired
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
  });

  test('batch QUEUE_FULL re-queues every member with the shared retry delay', async () => {
    resolveAiFillBatchMock.mockImplementation(() => Promise.reject(new QueueFullError(50)));
    const h = setup({
      rollQueue: [roll('a', 'a {{ai-fill: x}} z'), roll('b', 'b {{ai-fill: y}} z')],
    });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 50 && resolveAiFillBatchMock.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      h.stopDraining();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(resolveAiFillBatchMock.mock.calls[0]?.[0].items).toHaveLength(2);
    expect(useAtelierStore.getState().draft.rollQueue.map((queued) => queued.id)).toEqual(['a', 'b']);
    expect(h.generate).not.toHaveBeenCalled();
  });

  test('hard-failed groups defer roll fallbacks to the next pass without exceeding fill concurrency', async () => {
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const beginCall = () => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
    };
    const endCall = () => { activeCalls -= 1; };
    resolveAiFillBatchMock.mockImplementation(async () => {
      beginCall();
      await Promise.resolve();
      endCall();
      throw new Error('batch transport failed');
    });
    resolveAiFillMock.mockImplementation(async (req: AiFillRequest) => {
      beginCall();
      await new Promise((resolve) => setTimeout(resolve, 5));
      endCall();
      return { prompt: req.staticSegments.join('FILLED'), fills: req.instructions.map(() => 'FILLED') };
    });
    const h = setup({
      rollQueue: Array.from({ length: 8 }, (_, index) => (
        roll(`q${index}`, `roll ${index} {{ai-fill: detail ${index}}}`)
      )),
    });

    await runDrain(h);

    expect(resolveAiFillBatchMock).toHaveBeenCalledTimes(2);
    expect(resolveAiFillBatchMock.mock.calls.every((call) => call[0].items.length === 4)).toBe(true);
    expect(resolveAiFillMock).toHaveBeenCalledTimes(8);
    expect(maxActiveCalls).toBeLessThanOrEqual(5);
    expect(h.generate).toHaveBeenCalledTimes(8);
  });

  test('splits backend groups before their aggregate input reaches the server cap', async () => {
    const instruction = 'x'.repeat(AI_FILL_MAX_INSTRUCTION_CHARS - 1);
    const h = setup({
      rollQueue: Array.from({ length: 4 }, (_, index) => (
        roll(`q${index}`, `roll ${index} {{ai-fill: ${instruction}}}`)
      )),
    });

    await runDrain(h);

    expect(resolveAiFillBatchMock).toHaveBeenCalledTimes(2);
    for (const [request] of resolveAiFillBatchMock.mock.calls) {
      const inputChars = request.items.reduce(
        (batchTotal, item) => batchTotal
          + item.staticSegments.reduce((total, segment) => total + segment.length, 0)
          + item.instructions.reduce((total, itemInstruction) => total + itemInstruction.length, 0),
        0,
      );
      expect(inputChars).toBeLessThan(AI_FILL_MAX_INPUT_CHARS);
    }
    expect(resolveAiFillBatchMock.mock.calls.map((call) => call[0].items.length)).toEqual([3, 1]);
    expect(h.generate).toHaveBeenCalledTimes(4);
  });

  test('a genuinely failed roll is KEPT in the queue (not dropped) and not re-fired', async () => {
    resolveAiFillBatchMock.mockImplementation(() => Promise.resolve({ items: [{ ok: false as const }] }));
    resolveAiFillMock.mockImplementation(() => Promise.reject(new Error('provider boom')));
    const h = setup({ rollQueue: [roll('q', 'a {{ai-fill: x}} b')] });
    await runDrain(h);
    expect(h.generate).toHaveBeenCalledTimes(0);
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['q']);  // preserved
    expect(h.toasts.some((t) => /left in the queue to retry/i.test(t.text))).toBe(true);
    expect(resolveAiFillBatchMock).toHaveBeenCalledTimes(1); // deferred retry stayed single-only
    expect(resolveAiFillMock).toHaveBeenCalledTimes(1);    // skipped after failing — no spin
  });

  test('the failed-prompt toast stays actionable and retries through the submit entry point', async () => {
    let calls = 0;
    resolveAiFillBatchMock.mockImplementation(() => Promise.resolve({ items: [{ ok: false as const }] }));
    resolveAiFillMock.mockImplementation((req: AiFillRequest) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('provider boom'));
      return Promise.resolve({ prompt: req.staticSegments.join('FILLED'), fills: ['FILLED'] });
    });
    const h = setup({ rollQueue: [roll('q', 'a {{ai-fill: x}} b')] });
    await runDrain(h);
    const retryToast = h.toasts.find((toast) => toast.action?.label === 'Retry');
    expect(retryToast?.durationMs).toBe(10_000);

    await act(async () => {
      retryToast?.action?.onClick();
      for (let i = 0; i < 100 && h.generate.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
  });

  test('Resume with composer text drains only saved queued rolls', async () => {
    const originalDateNow = Date.now;
    let now = 0;
    Date.now = () => now;
    resolveAiFillBatchMock.mockImplementation(() => {
      now = 8 * 60 * 1000 + 1;
      return Promise.reject(new QueueFullError(1));
    });
    const h = setup({
      prompt: 'composer {{ai-fill: x}} prompt',
      rollQueue: [roll('q', 'queued {{ai-fill: x}} prompt')],
    });
    try {
      await runDrain(h);
      const resumeToast = h.toasts.find((toast) => toast.action?.label === 'Resume');
      expect(resumeToast?.durationMs).toBe(30_000);
      expect(useAtelierStore.getState().draft.rollQueue.map((queued) => queued.id)).toEqual(['q']);

      resolveAiFillBatchMock.mockImplementation((req: AiFillBatchRequest) => Promise.resolve({
        items: req.items.map((batchItem) => ({
          ok: true as const,
          prompt: batchItem.staticSegments.join('FILLED'),
          fills: ['FILLED'],
        })),
      }));
      Date.now = originalDateNow;
      await act(async () => {
        resumeToast?.action?.onClick();
        for (let i = 0; i < 100 && h.generate.mock.calls.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      expect(h.generate).toHaveBeenCalledTimes(1);
      expect(h.generate.mock.calls[0]?.[0]).toMatchObject({ prompt: 'queued FILLED prompt' });
      expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test('a retained Resume action waits for a historical retry POST before taking its saved row', async () => {
    const originalDateNow = Date.now;
    let now = 0;
    Date.now = () => now;
    resolveAiFillBatchMock.mockImplementation(() => {
      now = 8 * 60 * 1000 + 1;
      return Promise.reject(new QueueFullError(1));
    });
    const posts: { request: GenerateRequest; accept: () => void; finish: () => void; refuse: (error: unknown) => void }[] = [];
    const h = setup({
      rollQueue: [roll('paused', 'paused {{ai-fill: action}}')],
      generate: (request, options) => {
        const stream = Promise.withResolvers<undefined>();
        posts.push({ request, accept: () => { options?.onAccepted?.(`b-${posts.length}`); }, finish: () => { stream.resolve(undefined); }, refuse: stream.reject });
        return stream.promise;
      },
    });
    try {
      await runDrain(h);
      const resume = h.toasts.find((toast) => toast.action?.label === 'Resume')?.action;
      expect(resume).toBeDefined();
      Date.now = originalDateNow;
      resolveAiFillBatchMock.mockClear();
      resolveAiFillBatchMock.mockImplementation((request) => Promise.resolve({
        items: request.items.map((item) => ({ ok: true as const, prompt: item.staticSegments.join('FILLED'), fills: ['FILLED'] })),
      }));
      h.submitPrepared({ prompt: 'historical', modelId: model.id, ratio: '1:1', count: 1, seed: 77 });
      await act(async () => { await waitUntil(() => posts.length === 1); });
      const key = posts[0]?.request.idempotencyKey;
      if (!key) throw new Error('missing historical replay key');
      await act(async () => { posts[0]?.refuse(queueFull429()); await waitUntil(() => posts.length === 2, 2_000); });
      expect(posts[1]?.request.idempotencyKey).toBe(key);
      await act(async () => { resume?.onClick(); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(posts).toHaveLength(2);
      expect(resolveAiFillBatchMock).not.toHaveBeenCalled();
      expect(useAtelierStore.getState().draft.rollQueue.map((item) => item.id)).toEqual(['paused', key]);
      await act(async () => { posts[1]?.accept(); await waitUntil(() => posts.length === 3); });
      expect(posts.map((post) => post.request.prompt)).toEqual(['historical', 'historical', 'paused FILLED']);
      expect(useAtelierStore.getState().draft.rollQueue.some((item) => item.id === key)).toBe(false);
    } finally {
      Date.now = originalDateNow;
      await act(async () => {
        h.stopDraining();
        for (const post of posts) post.finish();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  });

  test('idle budget starts at the last productive pass before backpressure', async () => {
    const originalDateNow = Date.now;
    const originalRandom = Math.random;
    let now = 0;
    let fillCalls = 0;
    Date.now = () => now;
    Math.random = () => 0;
    resolveAiFillBatchMock.mockImplementation(() => {
      fillCalls += 1;
      now = fillCalls === 1 ? 8 * 60 * 1000 + 1 : 9 * 60 * 1000 + 1;
      return Promise.reject(new QueueFullError(0));
    });
    const h = setup({
      rollQueue: [roll('productive', 'productive roll')],
      generate: () => {
        now = 60 * 1000;
        useAtelierStore.getState().stashRoll(roll('busy', 'busy {{ai-fill: x}} roll'));
        return Promise.resolve();
      },
    });
    try {
      await runDrain(h);
      expect(fillCalls).toBe(2);
      expect(h.toasts.some((toast) => toast.action?.label === 'Resume')).toBe(true);
      expect(useAtelierStore.getState().draft.rollQueue.map((queued) => queued.id)).toEqual(['busy']);
    } finally {
      Date.now = originalDateNow;
      Math.random = originalRandom;
    }
  });

  test('mid-pass persistence retains consumed rolls until their terminal settlement', async () => {
    let finishFill: ((value: { items: { ok: true; prompt: string; fills: string[] }[] }) => void) | undefined;
    resolveAiFillBatchMock.mockImplementation(() => new Promise((resolve) => { finishFill = resolve; }));
    const h = setup({ rollQueue: [roll('q', 'queued {{ai-fill: x}} prompt')] });

    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 50 && resolveAiFillBatchMock.mock.calls.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
    expect(loadRollQueue().map((queued) => queued.id)).toEqual(['q']);

    await act(async () => {
      finishFill?.({ items: [{ ok: true, prompt: 'queued FILLED prompt', fills: ['FILLED'] }] });
      for (let i = 0; i < 100 && useAtelierStore.getState().draining; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(loadRollQueue()).toEqual([]);
  });

  test('a known-accepted roll leaves reload persistence while another unit is still pending', async () => {
    const settlers: (() => void)[] = [];
    const h = setup({
      rollQueue: [roll('a', 'plain a'), roll('b', 'plain b')],
      generate: (req, options) => new Promise<void>((resolve, reject) => {
        if (req.prompt === 'plain a') {
          options?.onAccepted?.('batch-a');
          // Post-acceptance transport loss still settles as a started batch.
          settlers.push(() => { reject(Object.assign(new Error('lost'), { name: 'StreamTruncatedError', batchId: 'batch-a' })); });
        } else {
          settlers.push(() => { resolve(); });
        }
      }),
    });

    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 100 && h.generate.mock.calls.length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(loadRollQueue().map((queued) => queued.id)).toEqual(['b']);

    await act(async () => {
      for (const settle of settlers) settle();
      for (let i = 0; i < 100 && useAtelierStore.getState().draining; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });
    expect(loadRollQueue()).toEqual([]);
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
    expect(h.generate).toHaveBeenCalledTimes(2);
  });

  test('an accepted roll is not re-fired even when its stream rejects with a non-truncation error', async () => {
    let calls = 0;
    const h = setup({
      rollQueue: [roll('q', 'plain roll')],
      generate: (_req, options) => {
        calls += 1;
        options?.onAccepted?.('batch-q');
        return Promise.reject(new Error('events unavailable'));
      },
    });
    await runDrain(h);
    expect(calls).toBe(1);
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
    expect(loadRollQueue()).toEqual([]);
  });

  test('the drain sets and clears the `draining` flag', async () => {
    const h = setup({ rollQueue: [roll('q', 'plain roll')] });
    expect(useAtelierStore.getState().draining).toBe(false);
    await runDrain(h);
    expect(useAtelierStore.getState().draining).toBe(false);  // cleared when done
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  test('clearing the queue mid-drain is NOT undone by a late backpressure restore (epoch guard)', async () => {
    // The roll backpressures (would normally be restored), but the user clears the
    // queue during the inter-pass wait — the restore must respect that.
    resolveAiFillBatchMock.mockImplementation(() => Promise.reject(new QueueFullError(20)));
    const h = setup({ rollQueue: [roll('q', 'a {{ai-fill: x}} b')] });
    await act(async () => {
      h.submitDraft();
      for (let i = 0; i < 30 && !useAtelierStore.getState().draining; i++) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 30));   // let pass 1 backpressure + restore
      useAtelierStore.getState().clearRollQueue();   // user discards the queue
      for (let i = 0; i < 60 && useAtelierStore.getState().draining; i++) await new Promise((r) => setTimeout(r, 5));
    });
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);  // stayed cleared
    expect(loadRollQueue()).toEqual([]);
    expect(h.generate).toHaveBeenCalledTimes(0);
  });

  test('roll #201 stashed while 200 consumed rolls await their first answer is refused, and a reload keeps every roll', async () => {
    const refusals: ((error: unknown) => void)[] = [];
    const queued = Array.from({ length: 200 }, (_, index) => roll(`q${index}`, `plain ${index}`));
    const h = setup({
      rollQueue: queued,
      generate: () => new Promise<void>((_resolve, reject) => { refusals.push(reject); }),
    });
    try {
      await act(async () => {
        h.submitDraft();
        for (let i = 0; i < 100 && h.generate.mock.calls.length === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);   // all 200 consumed

      const admitted = useAtelierStore.getState().stashRoll(roll('late', 'late plain'));
      expect(admitted).toBe(false);
      expect(useAtelierStore.getState().toasts.at(-1)).toMatchObject({ text: 'Roll queue is limited to 200 prompts.' });

      const reloaded = new Set(loadRollQueue().map((saved) => saved.id));
      const live = [...queued.map((r) => r.id), ...useAtelierStore.getState().draft.rollQueue.map((r) => r.id)];
      expect(live.filter((id) => !reloaded.has(id))).toEqual([]);
      expect(reloaded.size).toBe(200);
    } finally {
      await act(async () => {
        h.stopDraining();
        for (const refuse of refusals) refuse(new Error('offline'));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  });

  test('pending reference images block submission without resolving feedback', async () => {
    useAtelierStore.getState().setDraft({
      refImages: [{ clientId: 'ref-1', status: 'uploading', mime: 'image/png', sizeBytes: 1, previewUrl: '' }],
    });
    let maxResolving = 0;
    const unsubscribe = useAtelierStore.subscribe((state) => {
      maxResolving = Math.max(maxResolving, state.resolving);
    });
    try {
      const h = setup({ prompt: 'plain composer prompt', rollQueue: [roll('q', 'queued plain')] });
      await runDrain(h);
      expect(h.generate).not.toHaveBeenCalled();
      expect(maxResolving).toBe(0);
      expect(h.toasts).toEqual([]);
      expect(useAtelierStore.getState().draft.rollQueue.map((queued) => queued.id)).toEqual(['q']);
    } finally {
      unsubscribe();
    }
  });

  test('at most four preparation units run concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    // Pass one: every batch member misses, so each roll is deferred to a single
    // fill in pass two — six single units for the same pass.
    resolveAiFillBatchMock.mockImplementation((req: AiFillBatchRequest) => Promise.resolve({
      items: req.items.map(() => ({ ok: false as const })),
    }));
    resolveAiFillMock.mockImplementation(async (req: AiFillRequest) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { prompt: req.staticSegments.join('FILLED'), fills: req.instructions.map(() => 'FILLED') };
    });
    const h = setup({
      rollQueue: Array.from({ length: 6 }, (_, index) => roll(`q${index}`, `roll ${index} {{ai-fill: x}}`)),
    });
    await runDrain(h);
    expect(resolveAiFillMock).toHaveBeenCalledTimes(6);
    expect(maxActive).toBe(4);
    expect(h.generate).toHaveBeenCalledTimes(6);
  });

  test('a 429 VIDEO_BUSY is a genuine failure, not backpressure', async () => {
    const h = setup({
      rollQueue: [roll('q', 'plain roll')],
      generate: () => Promise.reject(new ApiError(429, 'busy', { code: 'VIDEO_BUSY' }, undefined)),
    });
    await runDrain(h);
    expect(h.generate).toHaveBeenCalledTimes(1);                      // not retried
    expect(useAtelierStore.getState().draft.rollQueue.map((queued) => queued.id)).toEqual(['q']);  // kept
    const retryToast = h.toasts.find((toast) => toast.action?.label === 'Retry');
    expect(retryToast?.text).toMatch(/left in the queue to retry/i);
    expect(h.toasts.some((toast) => toast.action?.label === 'Resume')).toBe(false);
  });

  test('a fired generate that rejects with AbortError is treated as started', async () => {
    const h = setup({
      rollQueue: [roll('q', 'plain roll')],
      // Never reports acceptance: the abort may still have landed after the batch existed.
      generate: () => Promise.reject(new DOMException('cancelled', 'AbortError')),
    });
    await runDrain(h);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
    expect(loadRollQueue()).toEqual([]);
    expect(h.toasts.some((toast) => toast.action?.label === 'Retry')).toBe(false);
  });

  test('stopDraining aborts a backpressured drain and leaves the roll in the queue', async () => {
    resolveAiFillBatchMock.mockImplementation(() => Promise.reject(new QueueFullError(50)));  // perpetually busy
    const h = setup({ rollQueue: [roll('q', 'a {{ai-fill: x}} b')] });
    await act(async () => {
      h.submitDraft();
      // let the first pass backpressure and enter the inter-pass wait
      for (let i = 0; i < 20 && !useAtelierStore.getState().draining; i++) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 30));
      h.stopDraining();
      for (let i = 0; i < 100 && useAtelierStore.getState().draining; i++) await new Promise((r) => setTimeout(r, 5));
    });
    expect(useAtelierStore.getState().draining).toBe(false);            // stopped
    expect(h.generate).toHaveBeenCalledTimes(0);                        // nothing fired
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['q']);  // not lost
  });

  test('a roll stashed while an earlier batch still streams is submitted before that stream completes', async () => {
    const finishers: (() => void)[] = [];
    let unanswered = 0;
    let maxUnanswered = 0;
    const h = setup({
      rollQueue: [roll('a', 'first plain')],
      generate: (req, options) => {
        unanswered += 1;
        maxUnanswered = Math.max(maxUnanswered, unanswered);
        setTimeout(() => {
          unanswered -= 1;
          options?.onAccepted?.(`batch-${req.prompt}`);
        }, 5);
        return new Promise<void>((resolve) => { finishers.push(resolve); });
      },
    });
    try {
      await act(async () => {
        h.submitDraft();
        await waitUntil(() => h.generate.mock.calls.length === 1 && unanswered === 0);
        useAtelierStore.getState().stashRoll(roll('b', 'second plain'));
        useAtelierStore.getState().stashRoll(roll('c', 'third plain'));
        await waitUntil(() => h.generate.mock.calls.length === 3 && unanswered === 0);
      });
      // Every stream is still running; each POST waited for the previous answer.
      expect(prompts(h)).toEqual(['first plain', 'second plain', 'third plain']);
      expect(finishers).toHaveLength(3);
      expect(maxUnanswered).toBe(1);
      expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
    } finally {
      await act(async () => {
        for (const finish of finishers) finish();
        await waitUntil(() => !useAtelierStore.getState().draining);
      });
    }
    expect(useAtelierStore.getState().draining).toBe(false);
  });

  test('a press joining a drain at the queue cap is refused, not acknowledged and later lost', async () => {
    // 200 queued rolls, all consumed into flight behind an unanswered first POST.
    const answers: (() => void)[] = [];
    const h = setup({
      prompt: 'composer plain',
      rollQueue: Array.from({ length: 200 }, (_, index) => roll(`r${String(index)}`, `roll ${String(index)}`)),
      generate: () => new Promise<void>((resolve) => { answers.push(resolve); }),
    });
    try {
      await act(async () => {
        h.submitDraft();
        await waitUntil(() => h.generate.mock.calls.length === 1);
      });
      expect(useAtelierStore.getState().draining).toBe(true);
      expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);

      await act(async () => {
        h.submitDraft();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(h.toasts.map((toast) => toast.text)).not.toContain('Added to the queue.');
      expect(useAtelierStore.getState().toasts.map((toast) => toast.text)).toContain('Roll queue is limited to 200 prompts.');
      expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(0);
    } finally {
      await act(async () => {
        h.stopDraining();
        for (const answer of answers) answer();
        await waitUntil(() => !useAtelierStore.getState().draining);
      });
    }
  });

  test('the drain stays owned while accepted streams run and ends when the last one completes', async () => {
    const finishers: (() => void)[] = [];
    const h = setup({
      prompt: 'composer plain',
      rollQueue: [roll('a', 'first plain')],
      generate: (req, options) => {
        queueMicrotask(() => { options?.onAccepted?.(`batch-${req.prompt}`); });
        return new Promise<void>((resolve) => { finishers.push(resolve); });
      },
    });
    await act(async () => {
      h.submitDraft();
      await waitUntil(() => h.generate.mock.calls.length === 2);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(useAtelierStore.getState().draining).toBe(true);
    await act(async () => {
      // A press while streams run joins the owner instead of starting another.
      h.submitDraft();
      await waitUntil(() => h.generate.mock.calls.length === 3);
    });
    expect(h.toasts.map((toast) => toast.text)).toContain('Added to the queue.');
    expect(prompts(h)).toEqual(['first plain', 'composer plain', 'composer plain']);
    expect(useAtelierStore.getState().draining).toBe(true);
    expect(h.toasts.some((toast) => /^Queued \d+ prompts?$/.test(toast.text))).toBe(false);

    await act(async () => {
      finishers[0]?.();
      finishers[1]?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(useAtelierStore.getState().draining).toBe(true);
    await act(async () => {
      finishers[2]?.();
      await waitUntil(() => !useAtelierStore.getState().draining);
    });
    expect(useAtelierStore.getState().draining).toBe(false);
    expect(h.toasts.map((toast) => toast.text)).toContain('Queued 3 prompts');
  });

  test('a QUEUE_FULL backoff wakes early when a tracked stream completes', async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    let finishFirst: (() => void) | undefined;
    const busyCalls: number[] = [];
    const h = setup({
      rollQueue: [roll('a', 'first plain'), roll('b', 'second plain')],
      generate: (req, options) => {
        if (req.prompt === 'first plain') {
          queueMicrotask(() => { options?.onAccepted?.('batch-a'); });
          return new Promise<void>((resolve) => { finishFirst = resolve; });
        }
        busyCalls.push(performance.now());
        if (busyCalls.length <= 2) {
          // Row a's batch finishes shortly into the second, longer backoff.
          if (busyCalls.length === 2) setTimeout(() => { finishFirst?.(); }, 50);
          return Promise.reject(queueFull429());
        }
        queueMicrotask(() => { options?.onAccepted?.('batch-b'); });
        return Promise.resolve();
      },
    });
    try {
      await act(async () => {
        h.submitDraft();
        await waitUntil(() => busyCalls.length === 3, 4_000);
      });
      // Second backoff: 2000 ms doubled, jittered to 1600 ms; the completion
      // wakes it at the 1000 ms floor instead.
      const [, second = 0, third = 0] = busyCalls;
      expect(third - second).toBeGreaterThanOrEqual(950);
      expect(third - second).toBeLessThan(1_400);
      await act(async () => { await waitUntil(() => !useAtelierStore.getState().draining); });
      expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
    } finally {
      Math.random = originalRandom;
      h.stopDraining();
      finishFirst?.();
    }
  }, 10_000);

  test('a stream completion never retries a QUEUE_FULL row sooner than the backoff floor, even a truncated stream', async () => {
    const originalRandom = Math.random;
    Math.random = () => 1;
    const busyCalls: number[] = [];
    const h = setup({
      rollQueue: [roll('a', 'first plain'), roll('b', 'second plain')],
      generate: (req, options) => {
        if (req.prompt === 'first plain') {
          return new Promise<void>((_resolve, reject) => {
            queueMicrotask(() => { options?.onAccepted?.('batch-a'); });
            // The stream drops right after row b is refused.
            setTimeout(() => {
              reject(Object.assign(new Error('lost'), { name: 'StreamTruncatedError', batchId: 'batch-a' }));
            }, 15);
          });
        }
        busyCalls.push(performance.now());
        if (busyCalls.length === 1) return Promise.reject(queueFull429());
        return Promise.resolve();
      },
    });
    try {
      await act(async () => {
        h.submitDraft();
        await waitUntil(() => !useAtelierStore.getState().draining, 4_000);
      });
      expect(busyCalls).toHaveLength(2);
      const [first = 0, second = 0] = busyCalls;
      expect(second - first).toBeGreaterThanOrEqual(950);
      expect(h.generate).toHaveBeenCalledTimes(3);
      expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
    } finally {
      Math.random = originalRandom;
      h.stopDraining();
    }
  }, 10_000);

  test('Stop while streams run still returns at once and restores nothing accepted', async () => {
    const finishers: (() => void)[] = [];
    const h = setup({
      rollQueue: [roll('a', 'first plain'), roll('b', 'second plain')],
      generate: (req, options) => {
        queueMicrotask(() => { options?.onAccepted?.(`batch-${req.prompt}`); });
        return new Promise<void>((resolve) => { finishers.push(resolve); });
      },
    });
    await act(async () => {
      h.submitDraft();
      await waitUntil(() => h.generate.mock.calls.length === 2);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(useAtelierStore.getState().draining).toBe(true);
    await act(async () => {
      h.stopDraining();
      await new Promise((resolve) => setTimeout(resolve, 0));
      useAtelierStore.getState().stashRoll(roll('c', 'third plain'));
      h.submitDraft();
      await waitUntil(() => h.generate.mock.calls.length === 3);
    });
    // The new drain started at once; accepted rows a and b stayed consumed.
    expect(prompts(h)).toEqual(['first plain', 'second plain', 'third plain']);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
    expect(loadRollQueue()).toEqual([]);
    await act(async () => {
      h.stopDraining();
      for (const finish of finishers) finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  test('an idle drain ends on a template switch and never adopts a roll stashed after it', async () => {
    let finishFirst: (() => void) | undefined;
    const h = setup({
      rollQueue: [roll('a', 'first plain')],
      generate: (_req, options) => {
        queueMicrotask(() => { options?.onAccepted?.('batch-a'); });
        return new Promise<void>((resolve) => { finishFirst = resolve; });
      },
    });
    await act(async () => {
      h.submitDraft();
      await waitUntil(() => h.generate.mock.calls.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(useAtelierStore.getState().draining).toBe(true);
    await act(async () => {
      useAtelierStore.getState().setPickerTemplate('another-template');
      useAtelierStore.getState().stashRoll(roll('c', 'new template roll'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      finishFirst?.();
      await waitUntil(() => !useAtelierStore.getState().draining);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(useAtelierStore.getState().draining).toBe(false);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(useAtelierStore.getState().draft.rollQueue.map((queued) => queued.id)).toEqual(['c']);
  });

  test('a failed row left in the queue ends the drain once the last stream completes', async () => {
    let finishFirst: (() => void) | undefined;
    const h = setup({
      rollQueue: [roll('a', 'first plain'), roll('b', 'second plain')],
      generate: (req, options) => {
        if (req.prompt === 'second plain') return Promise.reject(new ApiError(500, 'provider down', undefined, undefined));
        queueMicrotask(() => { options?.onAccepted?.('batch-a'); });
        return new Promise<void>((resolve) => { finishFirst = resolve; });
      },
    });
    await act(async () => {
      h.submitDraft();
      await waitUntil(() => h.generate.mock.calls.length === 2);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // Row b is kept but not eligible; the drain only waits for row a's stream.
    expect(useAtelierStore.getState().draft.rollQueue.map((queued) => queued.id)).toEqual(['b']);
    expect(useAtelierStore.getState().draining).toBe(true);
    await act(async () => {
      finishFirst?.();
      await waitUntil(() => !useAtelierStore.getState().draining);
    });
    expect(useAtelierStore.getState().draining).toBe(false);
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(useAtelierStore.getState().draft.rollQueue.map((queued) => queued.id)).toEqual(['b']);
    expect(h.toasts.find((toast) => toast.action?.label === 'Retry')?.text).toMatch(/left in the queue to retry/i);
  });

  test('repeated wake-ups leave no store subscribers behind', async () => {
    const originalSubscribe = useAtelierStore.subscribe;
    let active = 0;
    let maxActive = 0;
    useAtelierStore.subscribe = (listener) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const unsubscribe = originalSubscribe(listener);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        active -= 1;
        unsubscribe();
      };
    };
    const finishers: (() => void)[] = [];
    try {
      const h = setup({
        rollQueue: [roll('a', 'first plain')],
        generate: (req, options) => {
          queueMicrotask(() => { options?.onAccepted?.(`batch-${req.prompt}`); });
          return new Promise<void>((resolve) => { finishers.push(resolve); });
        },
      });
      await act(async () => {
        h.submitDraft();
        await waitUntil(() => h.generate.mock.calls.length === 1);
        for (let index = 0; index < 5; index += 1) {
          useAtelierStore.getState().stashRoll(roll(`r${index}`, `roll ${index}`));
          await waitUntil(() => h.generate.mock.calls.length === index + 2);
          // An unrelated store change and a completed stream wake nothing new.
          useAtelierStore.getState().setDraft({ prompt: `typing ${index}` });
          finishers[index]?.();
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      // The epoch watch plus at most one pending wake-up.
      expect(maxActive).toBeLessThanOrEqual(2);
      expect(useAtelierStore.getState().draining).toBe(true);
      await act(async () => {
        for (const finish of finishers) finish();
        await waitUntil(() => !useAtelierStore.getState().draining);
      });
      expect(useAtelierStore.getState().draining).toBe(false);
      expect(active).toBe(0);
    } finally {
      useAtelierStore.subscribe = originalSubscribe;
      for (const finish of finishers) finish();
    }
  });
});
