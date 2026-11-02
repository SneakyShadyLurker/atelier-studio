import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import type { GenerateRequest, Model, TagDimension, VariableList } from '@atelier/shared';
import { useAtelierStore, initialAtelierState } from '../store/atelier';
import { useRollQueueSubmit } from './useRollQueueSubmit';

const model = { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', pool: 'shared', backend: 'cloud', supportsReferenceImages: false } as unknown as Model;

const era: VariableList = {
  id: 'e', name: 'era', sortOrder: 0, createdAt: 0, updatedAt: 0,
  options: [{ id: 'e1', listId: 'e', value: 'ancient era', tagIds: [], sortOrder: 0, weight: 1 }],
};
const dims: readonly TagDimension[] = [];

type GenerateMock = Mock<(req: GenerateRequest) => Promise<void>>;

interface Harness {
  toasts: { text: string; tone: string | undefined }[];
  generate: GenerateMock;
  submit: () => Promise<void>;
}

function setup(opts: {
  prompt: string;
  library?: { variableLists: readonly VariableList[]; dimensions: readonly TagDimension[] } | undefined;
  libraryPending?: boolean;
  rollQueue?: { id: string; text: string; seed: number; source: 'template' }[];
}): Harness {
  const toasts: { text: string; tone: string | undefined }[] = [];
  const generate: GenerateMock = mock((_req: GenerateRequest) => Promise.resolve());
  useAtelierStore.getState().setDraft({ prompt: opts.prompt });
  for (const r of opts.rollQueue ?? []) useAtelierStore.getState().stashRoll(r);
  const { result } = renderHook(() => useRollQueueSubmit({
    draft: useAtelierStore.getState().draft,
    effectiveModel: model, effectiveRatio: '1:1', effectiveDuration: undefined,
    generate, fireGenerate: () => undefined,
    addToast: (text: string, tone?: string) => { toasts.push({ text, tone }); return ''; },
    setComposerExpanded: () => undefined,
    library: opts.library, libraryPending: opts.libraryPending ?? false,
  }));
  const submit = async () => {
    await act(async () => { result.current.submitDraft(); await new Promise((r) => setTimeout(r, 0)); });
  };
  return { toasts, generate, submit };
}

describe('useRollQueueSubmit — submit-time resolution guards', () => {
  beforeEach(() => { useAtelierStore.setState(initialAtelierState, true); });

  test('comment-only prompt: no generate call, soft toast explains the empty result', async () => {
    const h = setup({ prompt: '{{//just a note}}' });
    await h.submit();
    expect(h.generate).toHaveBeenCalledTimes(0);
    expect(h.toasts.some((t) => /resolved to empty/i.test(t.text))).toBe(true);
  });

  test('prompt expanding past MAX_PROMPT_CHARS: no generate call, error toast', async () => {
    const bigOption = 'x'.repeat(MAX_PROMPT_CHARS + 100);
    const big: VariableList = {
      id: 'b', name: 'big', sortOrder: 0, createdAt: 0, updatedAt: 0,
      options: [{ id: 'b1', listId: 'b', value: bigOption, tagIds: [], sortOrder: 0, weight: 1 }],
    };
    const h = setup({ prompt: '{{var::big}}', library: { variableLists: [big], dimensions: dims } });
    await h.submit();
    expect(h.generate).toHaveBeenCalledTimes(0);
    const overCap = h.toasts.find((t) => /too long after expanding/i.test(t.text));
    expect(overCap).toBeDefined();
    expect(overCap?.tone).toBe('error');
  });

  test('entitled-but-loading library: {{var::}} is blocked, not sent raw to the model', async () => {
    const h = setup({ prompt: 'set in {{var::era}}', library: undefined, libraryPending: true });
    await h.submit();
    expect(h.generate).toHaveBeenCalledTimes(0);
    expect(h.toasts.some((t) => /still loading/i.test(t.text))).toBe(true);
  });

  test('library loaded: {{var::}} resolves and reaches the model', async () => {
    const h = setup({ prompt: 'set in {{var::era}}', library: { variableLists: [era], dimensions: dims } });
    await h.submit();
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0]?.[0]?.prompt).toBe('set in ancient era');
  });

  test('pending-var blocks only the active item; queued rolls still fire', async () => {
    const h = setup({
      prompt: '{{var::era}}',
      libraryPending: true,
      rollQueue: [{ id: 'a', text: 'queued roll', seed: 1, source: 'template' }],
    });
    await h.submit();
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generate.mock.calls[0]?.[0]?.prompt).toBe('queued roll');
    expect(h.toasts.some((t) => /still loading/i.test(t.text))).toBe(true);
  });
});
