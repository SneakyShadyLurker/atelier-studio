import { describe, expect, test } from 'bun:test';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { GenerateRequestSchema } from './generate.schema';

test('generation text caps still count UTF-16 units after the Zod upgrade', () => {
  const base = { prompt: 'p', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1 };
  for (const [field, maximum] of [
    ['prompt', MAX_PROMPT_CHARS],
    ['motionPrompt', MAX_PROMPT_CHARS],
  ] as const) {
    const atLimit = '😀'.repeat(Math.floor(maximum / 2)) + 'x'.repeat(maximum % 2);
    expect(GenerateRequestSchema.safeParse({ ...base, [field]: atLimit }).success).toBe(true);
    const oversized = GenerateRequestSchema.safeParse({ ...base, [field]: atLimit + 'x' });
    expect(oversized.success).toBe(false);
    if (!oversized.success) {
      expect(oversized.error.issues).toHaveLength(1);
      const issue = oversized.error.issues[0];
      expect(issue?.code).toBe('too_big');
      expect(issue?.path).toEqual([field]);
      if (issue?.code === 'too_big') {
        expect(issue.maximum).toBe(maximum);
        expect(issue.origin).toBe('string');
      }
    }
  }
});

describe('GenerateRequestSchema — provenance', () => {
  const base = { prompt: 'p', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1' as const, count: 1 };

  test('accepts valid provenance', () => {
    const r = GenerateRequestSchema.safeParse({
      ...base,
      provenance: { templateId: 'tpl1', rollSeed: 5, pins: { 'face#0': 'opt-a' } },
    });
    expect(r.success).toBe(true);
  });

  test('accepts request with no provenance', () => {
    expect(GenerateRequestSchema.safeParse(base).success).toBe(true);
  });

  test('rejects provenance with non-string pin value', () => {
    const r = GenerateRequestSchema.safeParse({
      ...base,
      provenance: { templateId: 'tpl1', rollSeed: 5, pins: { 'face#0': 42 } },
    });
    expect(r.success).toBe(false);
  });

  test('rejects provenance with negative rollSeed', () => {
    const r = GenerateRequestSchema.safeParse({
      ...base,
      provenance: { templateId: 'tpl1', rollSeed: -1, pins: {} },
    });
    expect(r.success).toBe(false);
  });
});

describe('GenerateRequestSchema — retired localHost field', () => {
  test('a stale client\'s localHost is stripped rather than rejected', () => {
    const parsed = GenerateRequestSchema.safeParse({
      prompt: 'p', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1, localHost: 'host-a',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('localHost');
  });
});

describe('GenerateRequestSchema — video sequence extension', () => {
  const base = { prompt: 'p', modelId: 'minimax-h3-i2v', ratio: '1:1' as const, count: 1 };

  test('accepts a non-empty extendsTileId without acting on it', () => {
    const result = GenerateRequestSchema.safeParse({ ...base, extendsTileId: 'tile-1' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.extendsTileId).toBe('tile-1');
  });

  test('rejects an empty extendsTileId', () => {
    expect(GenerateRequestSchema.safeParse({ ...base, extendsTileId: '' }).success).toBe(false);
  });
});

describe('GenerateRequestSchema — idempotencyKey', () => {
  const base = { prompt: 'p', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1' as const, count: 1 };

  test('accepts a 36-char key', () => {
    const key = crypto.randomUUID();
    expect(key).toHaveLength(36);
    const result = GenerateRequestSchema.safeParse({ ...base, idempotencyKey: key });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.idempotencyKey).toBe(key);
  });

  test('rejects an empty key and a 65-char key', () => {
    expect(GenerateRequestSchema.safeParse({ ...base, idempotencyKey: '' }).success).toBe(false);
    expect(GenerateRequestSchema.safeParse({ ...base, idempotencyKey: 'k'.repeat(65) }).success).toBe(false);
    expect(GenerateRequestSchema.safeParse({ ...base, idempotencyKey: 'k'.repeat(64) }).success).toBe(true);
  });

  test('an absent key parses as before', () => {
    const result = GenerateRequestSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty('idempotencyKey');
  });
});
