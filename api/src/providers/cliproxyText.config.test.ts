import { describe, expect, test } from 'bun:test';
import {
  AI_FILL_DEFAULTS,
  CLIPROXY_TEXT_DEFAULTS,
  DRAFT_LIST_DEFAULTS,
  DRAFT_TEMPLATE_DEFAULTS,
  GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS,
  GLM_ABLITERATED_KREA_CONDENSE_TIMEOUT_MS,
  GLM_ABLITERATED_MAX_RESPONSE_BYTES,
  GLM_ABLITERATED_STREAM_DRAIN_MS,
  aiFillBatchPerAttemptTimeoutMs,
  aiFillPerAttemptTimeoutMs,
  kreaCondenseTimeoutMs,
  legacyLatencyProfile,
  textMaxResponseBytes,
  textStreamDrainMs,
  brainstormDefaults,
  PINNED_EFFORT_MAX_RESPONSE_BYTES,
  pinnedEffortMaxResponseBytes,
  brainstormRouteTimeoutMs,
  GROK_SAMPLING,
  INFER_DIMENSIONS_DEFAULTS,
  KIMI_LOW_REASONING_OVERHEAD_TOKENS,
  TEXT_BACKEND_DEFAULT_REASONING_EFFORT,
  textBackendModels,
} from './cliproxyText.config';
import { AI_FILL_BACKEND_VALUES, textBackendReasoningEfforts } from '@atelier/shared';
import { testConfig } from '../test/helpers';

describe('Shared ai-fill defaults', () => {
  // 'low' here is KIMI's setting. Every other backend sends its own
  // default at the wire, so do not "fix" this value for another backend.
  test('keeps the shared Kimi-facing low default', () => {
    expect(AI_FILL_DEFAULTS.reasoning_effort).toBe('low');
    expect(AI_FILL_DEFAULTS.max_completion_tokens).toBe(36_000);
  });
});

describe('text backend registry', () => {
  test('maps every backend to its configured CLIProxy model id', () => {
    expect(textBackendModels(testConfig())).toEqual({
      kimi: 'kimi-latest',
      mimo: 'mimo-v2.6-pro',
      grok: 'grok-latest',
      'gemini-argon': 'gemini-4-argon',
      'deepseek-abliterated': 'abliterated-model-large-flash',
      'glm-abliterated': 'glm-5.3',
      gpt: 'gpt-6.1-sol',
    });
    expect(textBackendModels(testConfig({ CLIPROXY_TEXT_MODEL_GLM_ABLITERATED: 'proxy/glm' }))['glm-abliterated'])
      .toBe('proxy/glm');
  });

  test('every fixed default effort is one the backend lists, so the proxy never remaps it', () => {
    expect(TEXT_BACKEND_DEFAULT_REASONING_EFFORT).toEqual({
      kimi: null,
      mimo: 'none',
      grok: 'low',
      'gemini-argon': 'low',
      'deepseek-abliterated': 'none',
      'glm-abliterated': 'low',
      gpt: 'medium',
    });
    for (const backend of AI_FILL_BACKEND_VALUES) {
      const effort = TEXT_BACKEND_DEFAULT_REASONING_EFFORT[backend];
      // GPT is never user-pinned, so it lists nothing; Kimi takes the per-path default.
      if (effort === null || backend === 'gpt') continue;
      expect(textBackendReasoningEfforts(backend)).toContain(effort);
    }
    // Kimi's per-path default must itself be a level Kimi lists.
    expect(textBackendReasoningEfforts('kimi')).toContain(AI_FILL_DEFAULTS.reasoning_effort);
  });

  test("Grok sampling follows xAI's recommendation", () => {
    expect(GROK_SAMPLING).toEqual({ temperature: 0.7, top_p: 0.95 });
  });
});

describe('Kimi brainstorm defaults', () => {
  test('uses low reasoning so K3 can think without starving content', () => {
    expect(brainstormDefaults(10).reasoning_effort).toBe('low');
  });
  test('sizes the budget for K3 content plus low CoT', () => {
    expect(brainstormDefaults(4).max_completion_tokens).toBe(6400);
    expect(brainstormDefaults(10).max_completion_tokens).toBe(10000);
  });
  test('a pinned effort above low widens the CoT headroom on top of the capped content budget', () => {
    expect(brainstormDefaults(10, 'none').max_completion_tokens).toBe(10000);
    expect(brainstormDefaults(10, 'max')).toMatchObject({ reasoning_effort: 'max', max_completion_tokens: 38000 });
    expect(brainstormDefaults(60, 'low').max_completion_tokens).toBe(24000);
    expect(brainstormDefaults(60, 'high').max_completion_tokens).toBe(36000);
  });
});

describe('Kimi generic text defaults', () => {
  test('pins the low-reasoning budgets', () => {
    expect(KIMI_LOW_REASONING_OVERHEAD_TOKENS).toBe(4000);
    expect(CLIPROXY_TEXT_DEFAULTS).toEqual(AI_FILL_DEFAULTS);
    expect(INFER_DIMENSIONS_DEFAULTS.max_completion_tokens).toBe(36000);
    expect(DRAFT_LIST_DEFAULTS.max_completion_tokens).toBe(5200);
    expect(DRAFT_TEMPLATE_DEFAULTS.max_completion_tokens).toBe(5500);
  });
});

describe('brainstormRouteTimeoutMs', () => {
  test('adds both backend groups\' open envelopes to the drain budget', () => {
    // 2 attempts × 45 s + 1 backoff of 8 s per backend, two backends, plus 300 s drain.
    expect(brainstormRouteTimeoutMs(300_000, 45_000, 2, 8_000)).toBe(300_000 + 2 * (90_000 + 8_000));
    expect(brainstormRouteTimeoutMs(300_000, 45_000, 1, 8_000)).toBe(300_000 + 2 * 45_000);
  });
});

describe('GLM deadlines', () => {
  test('extend every GLM deadline and byte cap without touching other backends', () => {
    for (const backend of ['kimi', 'mimo', 'grok', 'gemini-argon', 'deepseek-abliterated', 'gpt'] as const) {
      expect(aiFillPerAttemptTimeoutMs(legacyLatencyProfile(backend), 120_000)).toBe(120_000);
      expect(aiFillBatchPerAttemptTimeoutMs(legacyLatencyProfile(backend))).toBe(150_000);
      expect(textStreamDrainMs(legacyLatencyProfile(backend), 300_000)).toBe(300_000);
      expect(kreaCondenseTimeoutMs(legacyLatencyProfile(backend), 150_000)).toBe(150_000);
      expect(textMaxResponseBytes(legacyLatencyProfile(backend), 1024 * 1024)).toBe(1024 * 1024);
    }
    expect(aiFillPerAttemptTimeoutMs(legacyLatencyProfile(null), 120_000)).toBe(120_000);
    expect(aiFillPerAttemptTimeoutMs(legacyLatencyProfile('glm-abliterated'), 120_000)).toBe(GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS);
    expect(aiFillBatchPerAttemptTimeoutMs(legacyLatencyProfile('glm-abliterated'))).toBe(GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS);
    expect(textStreamDrainMs(legacyLatencyProfile('glm-abliterated'), 300_000)).toBe(GLM_ABLITERATED_STREAM_DRAIN_MS);
    expect(kreaCondenseTimeoutMs(legacyLatencyProfile('glm-abliterated'), 150_000)).toBe(GLM_ABLITERATED_KREA_CONDENSE_TIMEOUT_MS);
    expect(textMaxResponseBytes(legacyLatencyProfile('glm-abliterated'), 1024 * 1024)).toBe(GLM_ABLITERATED_MAX_RESPONSE_BYTES);
    // A configured value above the GLM floor still wins.
    expect(textStreamDrainMs(legacyLatencyProfile('glm-abliterated'), GLM_ABLITERATED_STREAM_DRAIN_MS + 1))
      .toBe(GLM_ABLITERATED_STREAM_DRAIN_MS + 1);
  });

  test('cover the slowest measured GLM call of each workload', () => {
    // Measured uncapped at 'high' through the proxy.
    expect(GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(197_000);
    expect(GLM_ABLITERATED_KREA_CONDENSE_TIMEOUT_MS).toBeGreaterThan(248_000);
    expect(GLM_ABLITERATED_STREAM_DRAIN_MS).toBeGreaterThan(1_259_000);
    // The full 32,768-token budget at the slowest measured 13 tokens/s.
    expect(GLM_ABLITERATED_STREAM_DRAIN_MS).toBeGreaterThanOrEqual((32_768 / 13) * 1000);
    // The full 32,768-token budget at ~55 bytes per token.
    expect(GLM_ABLITERATED_MAX_RESPONSE_BYTES).toBeGreaterThan(32_768 * 55);
  });
});

describe('pinned-effort raw-stream cap', () => {
  test('widens only above low, never below the configured cap', () => {
    expect(pinnedEffortMaxResponseBytes(1_048_576, undefined)).toBe(1_048_576);
    expect(pinnedEffortMaxResponseBytes(1_048_576, 'low')).toBe(1_048_576);
    expect(pinnedEffortMaxResponseBytes(1_048_576, 'medium')).toBe(PINNED_EFFORT_MAX_RESPONSE_BYTES);
    expect(pinnedEffortMaxResponseBytes(32 * 1_048_576, 'max')).toBe(32 * 1_048_576);
  });
});
