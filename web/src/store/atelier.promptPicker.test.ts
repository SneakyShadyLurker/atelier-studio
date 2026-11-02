import { afterEach, describe, expect, test } from 'bun:test';
import { useAtelierStore } from './atelier';

describe('PromptPickerDraft pin lifecycle', () => {
  afterEach(() => { useAtelierStore.getState().resetPicker(); });

  test('switching template clears stale occurrence pins', () => {
    const s = useAtelierStore.getState();
    s.setPickerTemplate('tpl-a');
    s.setPickerPin('Color#0', 'opt-red');
    expect(useAtelierStore.getState().promptPickerDraft.pins).toEqual({ 'Color#0': 'opt-red' });

    s.setPickerTemplate('tpl-b');
    expect(useAtelierStore.getState().promptPickerDraft.pins).toEqual({});
    expect(useAtelierStore.getState().promptPickerDraft.templateId).toBe('tpl-b');
  });

  test('returning to the list (null) also clears pins', () => {
    const s = useAtelierStore.getState();
    s.setPickerTemplate('tpl-a');
    s.setPickerPin('Color#0', 'opt-red');
    s.setPickerTemplate(null);
    expect(useAtelierStore.getState().promptPickerDraft.pins).toEqual({});
    expect(useAtelierStore.getState().promptPickerDraft.templateId).toBeNull();
  });
});
