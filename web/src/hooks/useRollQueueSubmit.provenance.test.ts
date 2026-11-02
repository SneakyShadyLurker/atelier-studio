import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useAtelierStore, initialAtelierState } from '../store/atelier';
import { useRollQueueSubmit } from './useRollQueueSubmit';
import type { GenerateRequest, Model } from '@atelier/shared';

const model = { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', pool: 'shared', backend: 'cloud', supportsReferenceImages: false } as unknown as Model;

describe('useRollQueueSubmit — per-roll provenance', () => {
  beforeEach(() => { useAtelierStore.setState(initialAtelierState, true); });

  test('a stashed roll carries its own provenance', () => {
    useAtelierStore.getState().stashRoll({
      id: 'r1', text: 'roll one', seed: 11, source: 'template',
      provenance: { templateId: 'tpl1', rollSeed: 11, pins: { 'face#0': 'a' } },
    });
    const roll = useAtelierStore.getState().draft.rollQueue[0];
    expect(roll?.provenance).toEqual({ templateId: 'tpl1', rollSeed: 11, pins: { 'face#0': 'a' } });
  });

  test('firing the queue stamps each batch with its OWN roll provenance, not the draft default', async () => {
    const requests: GenerateRequest[] = [];
    const generate = mock((req: GenerateRequest) => { requests.push(req); return Promise.resolve(); });
    const fireGenerate = mock((req: GenerateRequest) => { requests.push(req); });
    // Draft carries provenance for tpl-active; the queued roll carries tpl-1.
    useAtelierStore.getState().setDraft({
      prompt: 'active prompt',
      provenance: { templateId: 'tpl-active', rollSeed: 99, pins: { 'face#0': 'z' } },
    });
    useAtelierStore.getState().stashRoll({
      id: 'r1', text: 'roll one', seed: 11, source: 'template',
      provenance: { templateId: 'tpl-1', rollSeed: 11, pins: { 'face#0': 'a' } },
    });
    const { result } = renderHook(() => useRollQueueSubmit({
      draft: useAtelierStore.getState().draft,
      effectiveModel: model, effectiveRatio: '1:1', effectiveDuration: undefined,
      generate, fireGenerate,
      addToast: () => '', setComposerExpanded: () => undefined,
      library: undefined, libraryPending: false,
    }));
    await act(async () => { result.current.submitDraft(); await Promise.resolve(); });
    const queued = requests.find((r) => r.prompt === 'roll one');
    const active = requests.find((r) => r.prompt === 'active prompt');
    expect(queued?.provenance).toEqual({ templateId: 'tpl-1', rollSeed: 11, pins: { 'face#0': 'a' } });
    expect(active?.provenance).toEqual({ templateId: 'tpl-active', rollSeed: 99, pins: { 'face#0': 'z' } });
  });
});
