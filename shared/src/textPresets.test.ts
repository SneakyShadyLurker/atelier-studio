import { describe, expect, test } from 'bun:test';
import { TEXT_PRESETS } from './textPresets';
import { validateTextProviderBaseUrl } from './textProviderUrl';
import { TEXT_PROTOCOLS } from './index';

describe('TEXT_PRESETS', () => {
  test('every preset with a base URL passes the validator unchanged', () => {
    for (const preset of TEXT_PRESETS) {
      if (preset.baseUrl === '') continue;
      expect(validateTextProviderBaseUrl(preset.baseUrl)).toEqual({ ok: true, normalized: preset.baseUrl });
    }
  });

  test('only the two Custom presets leave the base URL empty', () => {
    const empty = TEXT_PRESETS.filter((preset) => preset.baseUrl === '').map((preset) => preset.id);
    expect(empty.sort()).toEqual(['custom-anthropic', 'custom-openai']);
  });

  test('ids are unique and every preset has a protocol, label and one-line hint', () => {
    expect(new Set(TEXT_PRESETS.map((preset) => preset.id)).size).toBe(TEXT_PRESETS.length);
    for (const preset of TEXT_PRESETS) {
      expect(TEXT_PROTOCOLS).toContain(preset.protocol);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.hint.length).toBeGreaterThan(0);
      expect(preset.hint).not.toContain('\n');
    }
  });

  test('token field applies to OpenAI-compatible presets only', () => {
    for (const preset of TEXT_PRESETS) {
      if (preset.protocol === 'anthropic') expect(preset.tokenField).toBeNull();
      else expect(preset.tokenField).not.toBeNull();
    }
  });

  test('matches the spec table', () => {
    const rows = TEXT_PRESETS.map(({ id, protocol, baseUrl, keyRequired, tokenField, listModels }) => (
      { id, protocol, baseUrl, keyRequired, tokenField, listModels }
    ));
    expect(rows).toEqual([
      { id: 'openai', protocol: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', keyRequired: true, tokenField: 'max_completion_tokens', listModels: true },
      { id: 'anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', keyRequired: true, tokenField: null, listModels: true },
      { id: 'openrouter', protocol: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', keyRequired: true, tokenField: 'max_completion_tokens', listModels: true },
      { id: 'groq', protocol: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', keyRequired: true, tokenField: 'max_completion_tokens', listModels: true },
      { id: 'gemini', protocol: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyRequired: true, tokenField: 'max_tokens', listModels: true },
      { id: 'ollama', protocol: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', keyRequired: false, tokenField: 'max_tokens', listModels: true },
      { id: 'lm-studio', protocol: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', keyRequired: false, tokenField: 'max_tokens', listModels: true },
      { id: 'custom-openai', protocol: 'openai-compatible', baseUrl: '', keyRequired: false, tokenField: 'max_completion_tokens', listModels: true },
      { id: 'custom-anthropic', protocol: 'anthropic', baseUrl: '', keyRequired: false, tokenField: null, listModels: true },
    ]);
  });
});
