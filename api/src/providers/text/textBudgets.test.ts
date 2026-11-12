import { describe, expect, test } from 'bun:test';
import {
  AI_FILL_MAX_OUTPUT_TOKENS,
  ENHANCE_MAX_OUTPUT_TOKENS,
  DRAFT_LIST_MAX_OUTPUT_TOKENS,
  DRAFT_TEMPLATE_MAX_OUTPUT_TOKENS,
  draftTemplateMaxOutputTokens,
  draftTemplateMaxResponseBytes,
  MOTION_ENHANCE_MAX_OUTPUT_TOKENS,
  STORY_PLANNER_MAX_OUTPUT_TOKENS,
  GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS,
  GLM_ABLITERATED_KREA_CONDENSE_TIMEOUT_MS,
  GLM_ABLITERATED_MAX_RESPONSE_BYTES,
  GLM_ABLITERATED_STREAM_DRAIN_MS,
  aiFillBatchPerAttemptTimeoutMs,
  aiFillPerAttemptTimeoutMs,
  promptRewriteTimeoutMs,
  AI_FILL_BATCH_PER_ATTEMPT_TIMEOUT_MS,
  AI_FILL_ROUTE_TIMEOUT_MARGIN_MS,
  aiFillBatchRouteTimeoutMs,
  aiFillPolicyEnvelopeMs,
  textMaxResponseBytes,
  textStreamDrainMs,
  textStreamIdleMs,
  brainstormMaxOutputTokens,
  PINNED_EFFORT_MAX_RESPONSE_BYTES,
  pinnedEffortMaxResponseBytes,
  brainstormRouteTimeoutMs,
  INFER_DIMENSIONS_MAX_OUTPUT_TOKENS,
  KIMI_LOW_REASONING_OVERHEAD_TOKENS,
  RESCUE_ROUTE_TIMEOUT_MS,
  TEXT_ROUTE_TIMEOUT_MARGIN_MS,
  textPerAttemptTimeoutMs,
  textPolicyRouteTimeoutMs,
  draftRouteTimeoutMs,
  rescueRouteTimeoutMs,
} from './textBudgets';
import { testConfig } from '../../test/helpers';
import { LEGACY_SEED } from '../../db/textSeed';

describe('Shared ai-fill budget', () => {
  test('keeps the 36k output budget', () => {
    expect(AI_FILL_MAX_OUTPUT_TOKENS).toBe(36_000);
  });
});

describe('Kimi brainstorm budget', () => {
  test('sizes the budget for K3 content plus low CoT', () => {
    expect(brainstormMaxOutputTokens(4)).toBe(6400);
    expect(brainstormMaxOutputTokens(10)).toBe(10000);
  });
  test('a pinned effort above low widens the CoT headroom on top of the capped content budget', () => {
    expect(brainstormMaxOutputTokens(10, 'none')).toBe(10000);
    expect(brainstormMaxOutputTokens(10, 'max')).toBe(38000);
    expect(brainstormMaxOutputTokens(60, 'low')).toBe(24000);
    expect(brainstormMaxOutputTokens(60, 'high')).toBe(36000);
  });
});

describe('Kimi generic text budgets', () => {
  test('pins the low-reasoning budgets', () => {
    expect(KIMI_LOW_REASONING_OVERHEAD_TOKENS).toBe(4000);
    expect(ENHANCE_MAX_OUTPUT_TOKENS).toBe(AI_FILL_MAX_OUTPUT_TOKENS);
    expect(MOTION_ENHANCE_MAX_OUTPUT_TOKENS).toBe(36_000);
    expect(STORY_PLANNER_MAX_OUTPUT_TOKENS).toBe(36_000);
    expect(INFER_DIMENSIONS_MAX_OUTPUT_TOKENS).toBe(36000);
    expect(DRAFT_LIST_MAX_OUTPUT_TOKENS).toBe(5200);
    expect(DRAFT_TEMPLATE_MAX_OUTPUT_TOKENS).toBe(5500);
  });
});

describe('draftTemplateMaxOutputTokens', () => {
  test('a fresh draft at low or default effort keeps the base budget', () => {
    expect(draftTemplateMaxOutputTokens('', undefined)).toBe(DRAFT_TEMPLATE_MAX_OUTPUT_TOKENS);
    expect(draftTemplateMaxOutputTokens('', null)).toBe(DRAFT_TEMPLATE_MAX_OUTPUT_TOKENS);
    expect(draftTemplateMaxOutputTokens('', 'low')).toBe(DRAFT_TEMPLATE_MAX_OUTPUT_TOKENS);
  });

  test('a rework adds about one token per three characters of the existing body', () => {
    expect(draftTemplateMaxOutputTokens('a'.repeat(3000), 'low')).toBe(DRAFT_TEMPLATE_MAX_OUTPUT_TOKENS + 1000);
    expect(draftTemplateMaxOutputTokens('ab', undefined)).toBe(DRAFT_TEMPLATE_MAX_OUTPUT_TOKENS + 1);
    // Counted in code points, like the body cap.
    expect(draftTemplateMaxOutputTokens('🌅🌅🌅', 'minimal')).toBe(DRAFT_TEMPLATE_MAX_OUTPUT_TOKENS + 1);
  });

  test('an effort above low reasons through at least the enhance budget', () => {
    expect(draftTemplateMaxOutputTokens('', 'high')).toBe(ENHANCE_MAX_OUTPUT_TOKENS);
    expect(draftTemplateMaxOutputTokens('', 'medium')).toBe(ENHANCE_MAX_OUTPUT_TOKENS);
    const huge = 'a'.repeat(3 * ENHANCE_MAX_OUTPUT_TOKENS);
    expect(draftTemplateMaxOutputTokens(huge, 'max')).toBe(DRAFT_TEMPLATE_MAX_OUTPUT_TOKENS + ENHANCE_MAX_OUTPUT_TOKENS);
  });
});

describe('draftTemplateMaxResponseBytes', () => {
  test('a fresh draft keeps the cap it was given', () => {
    expect(draftTemplateMaxResponseBytes(1024 * 1024, '')).toBe(1024 * 1024);
  });

  test('a rework adds stream room for the body it carries back', () => {
    // 15,000 characters are 5,000 tokens, at 512 raw bytes each.
    expect(draftTemplateMaxResponseBytes(1024 * 1024, 'a'.repeat(15_000))).toBe(1024 * 1024 + 5_000 * 512);
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
    expect(promptRewriteTimeoutMs('standard', 150_000)).toBe(150_000);
    expect(textMaxResponseBytes('standard', 1024 * 1024)).toBe(1024 * 1024);

    expect(aiFillPerAttemptTimeoutMs('slow', 120_000)).toBe(GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS);
    expect(aiFillBatchPerAttemptTimeoutMs('slow')).toBe(GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS);
    expect(textStreamDrainMs('slow', 300_000)).toBe(GLM_ABLITERATED_STREAM_DRAIN_MS);
    expect(promptRewriteTimeoutMs('slow', 150_000)).toBe(GLM_ABLITERATED_KREA_CONDENSE_TIMEOUT_MS);
    expect(textMaxResponseBytes('slow', 1024 * 1024)).toBe(GLM_ABLITERATED_MAX_RESPONSE_BYTES);
    // A configured value above the floor still wins.
    expect(textStreamDrainMs('slow', GLM_ABLITERATED_STREAM_DRAIN_MS + 1)).toBe(GLM_ABLITERATED_STREAM_DRAIN_MS + 1);
  });

  test('stream idle limit: slow rows get at least 10 min, standard keeps the configured value', () => {
    expect(textStreamIdleMs('standard', 120_000)).toBe(120_000);
    expect(textStreamIdleMs('slow', 120_000)).toBe(600_000);
    expect(textStreamIdleMs('slow', 900_000)).toBe(900_000);
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

describe('policy-wrapped call deadlines (drafts, rescue)', () => {
  test('per attempt: the configured knob on standard rows, at least the slow floor on slow rows', () => {
    expect(textPerAttemptTimeoutMs('standard', 70_000)).toBe(70_000);
    expect(textPerAttemptTimeoutMs('slow', 70_000)).toBe(GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS);
    expect(textPerAttemptTimeoutMs('slow', 400_000)).toBe(400_000);
  });

  test('standard rows keep today\'s route deadlines exactly', () => {
    // List and template drafts: CLOUD_TIMEOUT_MS; rescue: 90 s.
    expect(textPolicyRouteTimeoutMs('standard', 300_000, { perAttemptTimeoutMs: 70_000, maxAttempts: 2, maxBackoffMs: 8_000 }))
      .toBe(300_000);
    expect(RESCUE_ROUTE_TIMEOUT_MS).toBe(90_000);
    expect(textPolicyRouteTimeoutMs('standard', RESCUE_ROUTE_TIMEOUT_MS, { perAttemptTimeoutMs: 70_000, maxAttempts: 1, maxBackoffMs: 8_000 }))
      .toBe(90_000);
  });

  test('slow rows get a route deadline that covers every slow attempt plus backoff', () => {
    const slowAttempt = GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS;
    expect(textPolicyRouteTimeoutMs('slow', 300_000, { perAttemptTimeoutMs: 70_000, maxAttempts: 2, maxBackoffMs: 8_000 }))
      .toBe(2 * slowAttempt + 8_000 + TEXT_ROUTE_TIMEOUT_MARGIN_MS);
    expect(textPolicyRouteTimeoutMs('slow', RESCUE_ROUTE_TIMEOUT_MS, { perAttemptTimeoutMs: 70_000, maxAttempts: 1, maxBackoffMs: 8_000 }))
      .toBe(slowAttempt + TEXT_ROUTE_TIMEOUT_MARGIN_MS);
    // A longer standard deadline still wins.
    expect(textPolicyRouteTimeoutMs('slow', 3_000_000, { perAttemptTimeoutMs: 70_000, maxAttempts: 2, maxBackoffMs: 8_000 }))
      .toBe(3_000_000);
  });
});

describe('draft and rescue route deadlines', () => {
  test('standard rows: CLOUD_TIMEOUT_MS for drafts and 90 s for rescue, as before', () => {
    const config = testConfig();
    expect(draftRouteTimeoutMs('standard', config)).toBe(config.CLOUD_TIMEOUT_MS);
    expect(rescueRouteTimeoutMs('standard', config)).toBe(90_000);
  });
  test('slow rows cover the slow attempts of their policy', () => {
    const config = testConfig();
    expect(draftRouteTimeoutMs('slow', config)).toBe(Math.max(
      config.CLOUD_TIMEOUT_MS,
      GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS * config.RESILIENT_MAX_ATTEMPTS
        + config.RESILIENT_MAX_BACKOFF_MS * (config.RESILIENT_MAX_ATTEMPTS - 1)
        + TEXT_ROUTE_TIMEOUT_MARGIN_MS,
    ));
    expect(rescueRouteTimeoutMs('slow', config)).toBe(GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS + TEXT_ROUTE_TIMEOUT_MARGIN_MS);
  });
});
