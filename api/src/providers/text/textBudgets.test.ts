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
  AI_FILL_BATCH_PER_ATTEMPT_TIMEOUT_MS,
  AI_FILL_ROUTE_TIMEOUT_MARGIN_MS,
  aiFillBatchRouteTimeoutMs,
  aiFillPolicyEnvelopeMs,
  textMaxResponseBytes,
  textStreamDrainMs,
  brainstormDefaults,
  PINNED_EFFORT_MAX_RESPONSE_BYTES,
  pinnedEffortMaxResponseBytes,
  brainstormRouteTimeoutMs,
  INFER_DIMENSIONS_DEFAULTS,
  KIMI_LOW_REASONING_OVERHEAD_TOKENS,
} from './textBudgets';
import { LEGACY_SEED } from '../../db/textSeed';

describe('Shared ai-fill defaults', () => {
  // 'low' here is KIMI's setting. Every other backend sends its own
  // default at the wire, so do not "fix" this value for another backend.
  test('keeps the shared Kimi-facing low default', () => {
    expect(AI_FILL_DEFAULTS.reasoning_effort).toBe('low');
    expect(AI_FILL_DEFAULTS.max_completion_tokens).toBe(36_000);
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

describe('budgets by latency profile (spec § 11.2 item 2)', () => {
  test("'slow' applies the legacy GLM floors; 'standard' keeps every configured value", () => {
    expect(aiFillPerAttemptTimeoutMs('standard', 120_000)).toBe(120_000);
    expect(aiFillBatchPerAttemptTimeoutMs('standard')).toBe(150_000);
    expect(textStreamDrainMs('standard', 300_000)).toBe(300_000);
    expect(kreaCondenseTimeoutMs('standard', 150_000)).toBe(150_000);
    expect(textMaxResponseBytes('standard', 1024 * 1024)).toBe(1024 * 1024);

    expect(aiFillPerAttemptTimeoutMs('slow', 120_000)).toBe(GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS);
    expect(aiFillBatchPerAttemptTimeoutMs('slow')).toBe(GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS);
    expect(textStreamDrainMs('slow', 300_000)).toBe(GLM_ABLITERATED_STREAM_DRAIN_MS);
    expect(kreaCondenseTimeoutMs('slow', 150_000)).toBe(GLM_ABLITERATED_KREA_CONDENSE_TIMEOUT_MS);
    expect(textMaxResponseBytes('slow', 1024 * 1024)).toBe(GLM_ABLITERATED_MAX_RESPONSE_BYTES);
    // A configured value above the floor still wins.
    expect(textStreamDrainMs('slow', GLM_ABLITERATED_STREAM_DRAIN_MS + 1)).toBe(GLM_ABLITERATED_STREAM_DRAIN_MS + 1);
  });

  test('the legacy values: 360 s ai-fill, 420 s condense, 2,700 s drain, 4 MiB', () => {
    expect(GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS).toBe(360_000);
    expect(GLM_ABLITERATED_KREA_CONDENSE_TIMEOUT_MS).toBe(420_000);
    expect(GLM_ABLITERATED_STREAM_DRAIN_MS).toBe(2_700_000);
    expect(GLM_ABLITERATED_MAX_RESPONSE_BYTES).toBe(4 * 1024 * 1024);
  });

  test('the seeded GLM row is the only slow one, matching the legacy backend mapping', () => {
    for (const seed of LEGACY_SEED.models) {
      expect(seed.capabilities.latencyProfile).toBe(seed.legacyKey === 'glm-abliterated' ? 'slow' : 'standard');
    }
  });

  test('the ai-fill batch route deadline budgets each profile\'s attempt length', () => {
    expect(aiFillBatchRouteTimeoutMs('slow', 8_000)).toBe(
      2 * aiFillPolicyEnvelopeMs(GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS, 8_000) + AI_FILL_ROUTE_TIMEOUT_MARGIN_MS,
    );
    expect(aiFillBatchRouteTimeoutMs('standard', 8_000)).toBe(
      2 * aiFillPolicyEnvelopeMs(AI_FILL_BATCH_PER_ATTEMPT_TIMEOUT_MS, 8_000) + AI_FILL_ROUTE_TIMEOUT_MARGIN_MS,
    );
  });
});

describe('GLM deadlines', () => {
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
