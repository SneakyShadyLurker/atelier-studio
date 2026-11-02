import { afterEach, describe, expect, test } from 'bun:test';
import { useAtelierStore } from './atelier';

describe('SaveTemplateSlice', () => {
  afterEach(() => { useAtelierStore.getState().closeSaveTemplate(); });

  test('defaults to closed', () => {
    expect(useAtelierStore.getState().saveTemplatePrompt).toBeNull();
  });

  test('openSaveTemplate stores the prompt', () => {
    useAtelierStore.getState().openSaveTemplate('a koi pond');
    expect(useAtelierStore.getState().saveTemplatePrompt).toBe('a koi pond');
  });

  test('closeSaveTemplate resets to null', () => {
    useAtelierStore.getState().openSaveTemplate('x');
    useAtelierStore.getState().closeSaveTemplate();
    expect(useAtelierStore.getState().saveTemplatePrompt).toBeNull();
  });
});
