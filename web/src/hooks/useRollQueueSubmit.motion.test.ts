import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { Mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { MAX_PROMPT_CHARS, type AiFillBatchRequest, type AiFillRequest, type EnhancePromptRequest, type GenerateRequest, type Model, type TagDimension, type VariableList } from '@atelier/shared';
import { useAtelierStore, initialAtelierState } from '../store/atelier';
import { QuotaExhaustedError } from '../api/sse';
import { loadRollQueue, rollQueueStorageKey, setRollQueueScope } from '../lib/rollQueuePersist';

// Mock the format SSE client before the hook module loads.
const formatMock = mock((_req: EnhancePromptRequest, _format: string, _signal?: AbortSignal) => Promise.resolve('ENHANCED MOTION'));
void mock.module('../api/formatPrompt', () => ({ formatPromptForModel: formatMock }));
const fillMock = mock((request: AiFillRequest) => Promise.resolve({ prompt: request.staticSegments.join('FILLED'), fills: ['FILLED'] }));
const batchFillMock = mock((request: AiFillBatchRequest) => Promise.resolve({ items: request.items.map((item) => ({ ok: true as const, prompt: item.staticSegments.join('FILLED'), fills: ['FILLED'] })) }));
void mock.module('../api/aiFill', () => ({ resolveAiFill: fillMock, resolveAiFillBatch: batchFillMock }));

const { useRollQueueSubmit } = await import('./useRollQueueSubmit');

const wanModel = {
  id: 'minimax-h3-i2v', name: 'MiniMax H3 I2V', pool: 'local', backend: 'local',
  supportsReferenceImages: false, supportsI2V: true, promptFormat: 'h3-motion',
} as unknown as Model;
const t2vModel = {
  id: 'minimax-h3-t2v', name: 'MiniMax H3 T2V', pool: 'local', backend: 'local',
  supportsReferenceImages: false, outputsVideo: true, promptFormat: 'h3-motion',
} as unknown as Model;
const emptyLib: { variableLists: readonly VariableList[]; dimensions: readonly TagDimension[] } = { variableLists: [], dimensions: [] };

type GenerateMock = Mock<(req: GenerateRequest) => Promise<void>>;

function setup(opts: { motionPrompt: string; sourcePrompt?: string }): {
  toasts: { text: string; tone: string | undefined }[];
  generate: GenerateMock;
  submit: () => Promise<void>;
} {
  const toasts: { text: string; tone: string | undefined }[] = [];
  const generate: GenerateMock = mock((_req: GenerateRequest) => Promise.resolve());
  useAtelierStore.getState().setDraft({
    motionPrompt: opts.motionPrompt,
    i2vSourceUploadId: 'upload-1',
    ...(opts.sourcePrompt ? { i2vSourcePrompt: opts.sourcePrompt } : {}),
  });
  const { result } = renderHook(() => useRollQueueSubmit({
    draft: useAtelierStore.getState().draft,
    effectiveModel: wanModel, effectiveRatio: '9:16', effectiveDuration: 124,
    generate, fireGenerate: () => undefined,
    addToast: (text: string, tone?: string) => { toasts.push({ text, tone }); return ''; },
    setComposerExpanded: () => undefined,
    library: emptyLib, libraryPending: false,
  }));
  const submit = async () => {
    await act(async () => { result.current.submitDraft(); await new Promise((r) => setTimeout(r, 0)); });
  };
  return { toasts, generate, submit };
}

describe('useRollQueueSubmit — h3-motion enhancement', () => {
  beforeEach(() => {
    setRollQueueScope('motion-test');
    sessionStorage.removeItem(rollQueueStorageKey('motion-test'));
    useAtelierStore.setState(initialAtelierState, true);
    formatMock.mockClear();
    formatMock.mockImplementation(() => Promise.resolve('ENHANCED MOTION'));
    fillMock.mockClear();
    batchFillMock.mockClear();
  });

  test('batch fills survive reload and Stop during motion enhancement, without paying for them again', async () => {
    const formatting = Promise.withResolvers<undefined>();
    let formattingCount = 0;
    formatMock.mockImplementation((_req, _format, signal) => new Promise<string>((_resolve, reject) => {
      formattingCount += 1;
      if (formattingCount === 2) formatting.resolve(undefined);
      signal?.addEventListener('abort', () => { reject(new DOMException('stopped', 'AbortError')); }, { once: true });
    }));
    for (const id of ['q1', 'q2']) {
      useAtelierStore.getState().stashRoll({ id, text: `${id} {{ai-fill: action}}`, seed: 1, source: 'template' });
    }
    const generate: GenerateMock = mock((_request: GenerateRequest) => Promise.resolve());
    const { result } = renderHook(() => useRollQueueSubmit({
      draft: useAtelierStore.getState().draft,
      effectiveModel: t2vModel, effectiveRatio: '16:9', effectiveDuration: 124,
      generate, fireGenerate: () => undefined, addToast: () => '', setComposerExpanded: () => undefined,
      library: emptyLib, libraryPending: false,
    }));
    await act(async () => { result.current.submitDraft(); await formatting.promise; });
    // This is exactly what startup would hydrate while both formats are pending.
    expect(loadRollQueue().map((roll) => roll.text)).toEqual(['q1 FILLED', 'q2 FILLED']);
    await act(async () => { result.current.stopDraining(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(useAtelierStore.getState().draft.rollQueue.map((roll) => roll.text)).toEqual(['q1 FILLED', 'q2 FILLED']);
    formatMock.mockImplementation(() => Promise.resolve('ENHANCED MOTION'));
    await act(async () => {
      result.current.submitDraft();
      for (let i = 0; i < 50 && useAtelierStore.getState().draining; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(batchFillMock).toHaveBeenCalledTimes(1);
    expect(fillMock).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  test('enhances and writes the result to BOTH prompt and motionPrompt', async () => {
    const h = setup({ motionPrompt: 'she dances', sourcePrompt: 'a dancer in red' });
    await h.submit();
    expect(formatMock).toHaveBeenCalledTimes(1);
    expect(formatMock.mock.calls[0]?.[0]).toEqual({
      prompt: 'she dances', modelId: 'minimax-h3-i2v', sourcePrompt: 'a dancer in red', durationFrames: 124,
    });
    expect(formatMock.mock.calls[0]?.[1]).toBe('h3-motion');
    expect(h.generate).toHaveBeenCalledTimes(1);
    const req = h.generate.mock.calls[0]?.[0];
    expect(req?.prompt).toBe('ENHANCED MOTION');
    expect(req?.motionPrompt).toBe('ENHANCED MOTION');
  });

  test('omits sourcePrompt from the request when none was captured (upload path)', async () => {
    const h = setup({ motionPrompt: 'she dances' });
    await h.submit();
    // The clip length always rides along so the enhancer paces beats to it.
    expect(formatMock.mock.calls[0]?.[0]).toEqual({ prompt: 'she dances', modelId: 'minimax-h3-i2v', durationFrames: 124 });
    expect(h.generate.mock.calls[0]?.[0]?.prompt).toBe('ENHANCED MOTION');
  });

  test('falls back to the RAW motion text on enhance failure (no drop, no error toast)', async () => {
    formatMock.mockImplementation(() => Promise.reject(new Error('deepseek down')));
    const h = setup({ motionPrompt: 'she dances', sourcePrompt: 'a dancer in red' });
    await h.submit();
    expect(h.generate).toHaveBeenCalledTimes(1);
    const req = h.generate.mock.calls[0]?.[0];
    expect(req?.prompt).toBe('she dances');
    expect(req?.motionPrompt).toBe('she dances');
    expect(h.toasts.some((t) => t.tone === 'error')).toBe(false);
  });

  test('fires a billable raw render on quota exhaustion (not preserved/held back)', async () => {
    formatMock.mockImplementation(() => Promise.reject(new QuotaExhaustedError(30)));
    const h = setup({ motionPrompt: 'she dances' });
    await h.submit();
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0]?.[0]?.motionPrompt).toBe('she dances');
  });

  test('an over-length enhancement falls back to the raw motion text', async () => {
    formatMock.mockImplementation(() => Promise.resolve('x'.repeat(MAX_PROMPT_CHARS + 1)));
    const h = setup({ motionPrompt: 'she dances' });
    await h.submit();
    expect(h.generate).toHaveBeenCalledTimes(1);
    const req = h.generate.mock.calls[0]?.[0];
    expect(req?.prompt).toBe('she dances');
    expect(req?.motionPrompt).toBe('she dances');
  });

  test('Stop mid-enhance propagates the abort instead of falling back to the raw text', async () => {
    let enhanceSignal: AbortSignal | undefined;
    formatMock.mockImplementation((_req, _format, signal) => new Promise<string>((_resolve, reject) => {
      enhanceSignal = signal;
      signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); }, { once: true });
    }));
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      useAtelierStore.getState().stashRoll({ id: 'q1', text: 'she walks', seed: 1, source: 'template' });
      const generate: GenerateMock = mock((_req: GenerateRequest) => Promise.resolve());
      const { result } = renderHook(() => useRollQueueSubmit({
        draft: useAtelierStore.getState().draft,
        effectiveModel: t2vModel, effectiveRatio: '16:9', effectiveDuration: 124,
        generate, fireGenerate: () => undefined,
        addToast: () => '',
        setComposerExpanded: () => undefined,
        library: emptyLib, libraryPending: false,
      }));
      await act(async () => {
        result.current.submitDraft();
        for (let i = 0; i < 50 && formatMock.mock.calls.length === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        result.current.stopDraining();
        for (let i = 0; i < 50 && useAtelierStore.getState().draining; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(enhanceSignal?.aborted).toBe(true);
      expect(warn.mock.calls.some((call) => call[0] === 'motion_enhance_fallback_raw')).toBe(false);
      expect(generate).not.toHaveBeenCalled();
      expect(useAtelierStore.getState().draft.rollQueue.map((r) => [r.id, r.text])).toEqual([['q1', 'she walks']]);
    } finally {
      warn.mockRestore();
    }
  });

  test('ignores a stale image-mode roll queue in video mode (no unrelated motion jobs)', async () => {
    // A roll queue carried over from a prior image session must NOT fire as motion.
    useAtelierStore.getState().stashRoll({ id: 'q1', text: 'an unrelated landscape', seed: 1, source: 'template' });
    const h = setup({ motionPrompt: 'she dances', sourcePrompt: 'a dancer in red' });
    await h.submit();
    // Only the active motion fires; the queued roll is neither animated nor consumed.
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0]?.[0]?.motionPrompt).toBe('ENHANCED MOTION');
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['q1']);
  });
});
