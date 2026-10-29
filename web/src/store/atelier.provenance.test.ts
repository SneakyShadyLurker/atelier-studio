import { beforeEach, describe, expect, test } from 'bun:test';
import { useAtelierStore, initialAtelierState, toGenerateRequest } from './atelier';

describe('composer provenance capture + invalidation', () => {
  beforeEach(() => { useAtelierStore.setState(initialAtelierState, true); });

  test('setDraft preserves provenance when prompt + provenance set together', () => {
    useAtelierStore.getState().setDraft({
      prompt: 'resolved text',
      provenance: { templateId: 'tpl1', rollSeed: 5, pins: { 'face#0': 'opt-a' } },
    });
    expect(useAtelierStore.getState().draft.provenance).toEqual({
      templateId: 'tpl1', rollSeed: 5, pins: { 'face#0': 'opt-a' },
    });
  });

  test('a prompt-only setDraft (manual edit) clears provenance', () => {
    useAtelierStore.getState().setDraft({
      prompt: 'resolved',
      provenance: { templateId: 'tpl1', rollSeed: 5, pins: {} },
    });
    useAtelierStore.getState().setDraft({ prompt: 'resolved + hand edit' });
    expect(useAtelierStore.getState().draft.provenance).toBeUndefined();
  });

  test('a setDraft without prompt (e.g. model change) keeps provenance', () => {
    useAtelierStore.getState().setDraft({
      prompt: 'resolved',
      provenance: { templateId: 'tpl1', rollSeed: 5, pins: {} },
    });
    useAtelierStore.getState().setDraft({ count: 4 });
    expect(useAtelierStore.getState().draft.provenance).toEqual({ templateId: 'tpl1', rollSeed: 5, pins: {} });
  });

  test('toGenerateRequest forwards provenance onto the wire request', () => {
    const draft = {
      prompt: '  text  ', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1' as const, durationFrames: null, count: 2 as const,
      refImages: [], rollQueue: [],
      provenance: { templateId: 'tpl1', rollSeed: 5, pins: { 'face#0': 'opt-a' } },
    };
    const req = toGenerateRequest(draft, 'gpt-image-2.5-sunburst', '1:1');
    expect(req.provenance).toEqual({ templateId: 'tpl1', rollSeed: 5, pins: { 'face#0': 'opt-a' } });
  });

  test('toGenerateRequest omits provenance key when absent', () => {
    const draft = {
      prompt: 'text', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1' as const, durationFrames: null, count: 2 as const,
      refImages: [], rollQueue: [],
    };
    const req = toGenerateRequest(draft, 'gpt-image-2.5-sunburst', '1:1');
    expect('provenance' in req).toBe(false);
  });
});

describe('picker-open store state', () => {
  beforeEach(() => { useAtelierStore.setState(initialAtelierState, true); });

  test('pickerOpen defaults false; openPicker/closePicker/setPickerOpen flip it', () => {
    expect(useAtelierStore.getState().pickerOpen).toBe(false);
    useAtelierStore.getState().openPicker();
    expect(useAtelierStore.getState().pickerOpen).toBe(true);
    useAtelierStore.getState().closePicker();
    expect(useAtelierStore.getState().pickerOpen).toBe(false);
    useAtelierStore.getState().setPickerOpen(true);
    expect(useAtelierStore.getState().pickerOpen).toBe(true);
  });
});

describe('reopenBatchInPicker', () => {
  beforeEach(() => { useAtelierStore.setState(initialAtelierState, true); });

  test('replays templateId, seed, and each pin into the picker draft AND opens the picker', () => {
    expect(useAtelierStore.getState().pickerOpen).toBe(false);
    useAtelierStore.getState().reopenBatchInPicker({
      templateId: 'tpl1',
      rollSeed: 321,
      pins: { 'face#0': 'opt-a', 'outfit#0': 'opt-b' },
    });
    const pd = useAtelierStore.getState().promptPickerDraft;
    expect(pd.templateId).toBe('tpl1');
    expect(pd.seed).toBe(321);
    expect(pd.pins).toEqual({ 'face#0': 'opt-a', 'outfit#0': 'opt-b' });
    // Finding #1: reopen must actually OPEN the picker, not just stage the draft.
    expect(useAtelierStore.getState().pickerOpen).toBe(true);
  });

  test('replays with null templateId leaves picker on no template but still opens', () => {
    useAtelierStore.getState().reopenBatchInPicker({ templateId: null, rollSeed: 1, pins: {} });
    expect(useAtelierStore.getState().promptPickerDraft.templateId).toBeNull();
    expect(useAtelierStore.getState().pickerOpen).toBe(true);
  });

  // Finding E: reopening while an enhance is in flight is a no-op (returns
  // false). The picker render is gated `promptPickerOpen && !enhancing`, so
  // opening mid-enhance would leave store-open + visually-hidden, then pop the
  // picker open unexpectedly when enhance ends. Caller toasts on the false.
  test('is a no-op (returns false, picker stays closed) while enhancing', () => {
    useAtelierStore.getState().setEnhanceInFlight(true);
    const opened = useAtelierStore.getState().reopenBatchInPicker({ templateId: 'tpl1', rollSeed: 9, pins: {} });
    expect(opened).toBe(false);
    expect(useAtelierStore.getState().pickerOpen).toBe(false);
    // Draft is untouched too.
    expect(useAtelierStore.getState().promptPickerDraft.templateId).toBeNull();
  });

  test('opens (returns true) once enhancing clears', () => {
    useAtelierStore.getState().setEnhanceInFlight(true);
    expect(useAtelierStore.getState().reopenBatchInPicker({ templateId: 'tpl1', rollSeed: 9, pins: {} })).toBe(false);
    useAtelierStore.getState().setEnhanceInFlight(false);
    const opened = useAtelierStore.getState().reopenBatchInPicker({ templateId: 'tpl1', rollSeed: 9, pins: {} });
    expect(opened).toBe(true);
    expect(useAtelierStore.getState().pickerOpen).toBe(true);
  });
});
