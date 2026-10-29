import { describe, expect, test } from 'bun:test';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { AI_FILL_MAX_INPUT_CHARS, AI_FILL_MAX_INSTRUCTION_CHARS } from '@atelier/shared/ai-fill';
import { AiFillBatchRequestSchema, AiFillRequestSchema } from './aiFill.schema';

describe('AiFillRequestSchema', () => {
  test('accepts a valid request', () => {
    const r = AiFillRequestSchema.safeParse({
      staticSegments: ['A woman, ', ', golden hour.'],
      instructions: ['her swimsuit'],
      modelId: 'gpt-image-2.5-sunburst',
    });
    expect(r.success).toBe(true);
  });

  test('rejects instructions/segments length mismatch', () => {
    const r = AiFillRequestSchema.safeParse({
      staticSegments: ['a', 'b', 'c'],
      instructions: ['only one'],
      modelId: 'gpt-image-2.5-sunburst',
    });
    expect(r.success).toBe(false);
  });

  test('rejects an empty instruction', () => {
    const r = AiFillRequestSchema.safeParse({
      staticSegments: ['a', 'b'],
      instructions: ['   '],
      modelId: 'gpt-image-2.5-sunburst',
    });
    expect(r.success).toBe(false);
  });

  test('rejects more than AI_FILL_MAX_SLOTS instructions', () => {
    const instructions = Array.from({ length: 9 }, (_, i) => `i${i}`);
    const staticSegments = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const r = AiFillRequestSchema.safeParse({ staticSegments, instructions, modelId: 'm' });
    expect(r.success).toBe(false);
  });

  test('rejects empty modelId', () => {
    const r = AiFillRequestSchema.safeParse({ staticSegments: ['a', 'b'], instructions: ['x'], modelId: '' });
    expect(r.success).toBe(false);
  });

  test('rejects when the static text alone already exceeds MAX_PROMPT_CHARS (no LLM call wasted)', () => {
    const r = AiFillRequestSchema.safeParse({
      staticSegments: ['x'.repeat(MAX_PROMPT_CHARS + 1), 'y'],
      instructions: ['z'],
      modelId: 'm',
    });
    expect(r.success).toBe(false);
  });

  test('accepts a long instruction far above MAX_PROMPT_CHARS (the text model digests it; it never reaches the image model)', () => {
    const r = AiFillRequestSchema.safeParse({
      staticSegments: ['a ', ' b'],
      instructions: ['y'.repeat(MAX_PROMPT_CHARS * 5)],
      modelId: 'm',
    });
    expect(r.success).toBe(true);
  });

  test('rejects a single instruction beyond AI_FILL_MAX_INSTRUCTION_CHARS (per-field anti-abuse bound)', () => {
    const r = AiFillRequestSchema.safeParse({
      staticSegments: ['a', 'b'],
      instructions: ['y'.repeat(AI_FILL_MAX_INSTRUCTION_CHARS + 1)],
      modelId: 'm',
    });
    expect(r.success).toBe(false);
  });

  test('rejects when total input (static + instructions) exceeds AI_FILL_MAX_INPUT_CHARS', () => {
    // Five 49k-char instructions = 245k > 200k cap, each under the per-field bound.
    const instructions = Array.from({ length: 5 }, () => 'y'.repeat(AI_FILL_MAX_INSTRUCTION_CHARS - 1_000));
    const staticSegments = Array.from({ length: 6 }, () => 's');
    const total = instructions.reduce((n, s) => n + s.length, 0) + staticSegments.reduce((n, s) => n + s.length, 0);
    expect(total).toBeGreaterThanOrEqual(AI_FILL_MAX_INPUT_CHARS);
    const r = AiFillRequestSchema.safeParse({ staticSegments, instructions, modelId: 'm' });
    expect(r.success).toBe(false);
  });

  test('accepts the optional simulate flag', () => {
    const r = AiFillRequestSchema.safeParse({
      staticSegments: ['a', 'b'],
      instructions: ['x'],
      modelId: 'gpt-image-2.5-sunburst',
      simulate: true,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.simulate).toBe(true);
  });

  test('treats simulate as optional (absent = Generate path)', () => {
    const r = AiFillRequestSchema.safeParse({ staticSegments: ['a', 'b'], instructions: ['x'], modelId: 'm' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.simulate).toBeUndefined();
  });

  test('rejects a non-boolean simulate', () => {
    const r = AiFillRequestSchema.safeParse({
      staticSegments: ['a', 'b'],
      instructions: ['x'],
      modelId: 'm',
      simulate: 'yes',
    });
    expect(r.success).toBe(false);
  });
});

describe('AiFillBatchRequestSchema', () => {
  const item = { staticSegments: ['a', 'b'], instructions: ['x'] };

  test('accepts one through four items with the single-request item constraints', () => {
    expect(AiFillBatchRequestSchema.safeParse({ items: [item], modelId: 'm' }).success).toBe(true);
    expect(AiFillBatchRequestSchema.safeParse({ items: Array.from({ length: 4 }, () => item), modelId: 'm' }).success).toBe(true);
  });

  test('rejects empty and over-cap batches', () => {
    expect(AiFillBatchRequestSchema.safeParse({ items: [], modelId: 'm' }).success).toBe(false);
    expect(AiFillBatchRequestSchema.safeParse({ items: Array.from({ length: 5 }, () => item), modelId: 'm' }).success).toBe(false);
  });

  test('strips simulate instead of admitting it into batch items', () => {
    const withSingleOnlyFields = { ...item, simulate: true };
    const parsed = AiFillBatchRequestSchema.safeParse({ items: [withSingleOnlyFields], modelId: 'm' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.items[0]).toEqual(item);
  });

  test('applies the per-item segment/instruction cardinality and length limits', () => {
    expect(AiFillBatchRequestSchema.safeParse({
      items: [{ staticSegments: ['a', 'b', 'c'], instructions: ['x'] }],
      modelId: 'm',
    }).success).toBe(false);
    expect(AiFillBatchRequestSchema.safeParse({
      items: [{ staticSegments: ['a', 'b'], instructions: ['x'.repeat(AI_FILL_MAX_INSTRUCTION_CHARS + 1)] }],
      modelId: 'm',
    }).success).toBe(false);
  });

  test('rejects a batch whose aggregate input exceeds the single-call budget', () => {
    const longItem = {
      staticSegments: ['a', 'b'],
      instructions: ['x'.repeat(AI_FILL_MAX_INSTRUCTION_CHARS - 1)],
    };
    const parsed = AiFillBatchRequestSchema.safeParse({
      items: Array.from({ length: 4 }, () => longItem),
      modelId: 'm',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => (
        issue.message === 'total ai-fill batch input (static + instructions across all items) is too large'
      ))).toBe(true);
    }
  });
});
