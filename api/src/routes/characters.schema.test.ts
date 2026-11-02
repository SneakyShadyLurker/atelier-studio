import { describe, it, expect } from 'bun:test';
import { BRAINSTORM_MAX_COUNT_CEILING, BRAINSTORM_VARIATION_SEED_MAX } from '@atelier/shared';
import { CHARACTER_SOURCE_TEXT_MAX_CHARS } from '@atelier/shared/character-source-text';
import { BrainstormCharactersRequestSchema } from './characters.schema';

describe('BrainstormCharactersRequestSchema', () => {
  it('accepts a minimal valid request', () => {
    const r = BrainstormCharactersRequestSchema.safeParse({ count: 12, modelId: 'gpt-image-2.5-sunburst' });
    expect(r.success).toBe(true);
  });

  it('accepts a valid layout and stays valid when layout is omitted', () => {
    expect(BrainstormCharactersRequestSchema.safeParse({ count: 1, layout: 'diptych', modelId: 'm' }).success).toBe(true);
    expect(BrainstormCharactersRequestSchema.safeParse({ count: 1, modelId: 'm' }).success).toBe(true);
  });

  it('rejects a bogus layout', () => {
    expect(BrainstormCharactersRequestSchema.safeParse({ count: 1, layout: 'triptych', modelId: 'm' }).success).toBe(false);
  });

  it('accepts only a 32-bit non-negative integer variation seed', () => {
    expect(BrainstormCharactersRequestSchema.safeParse({
      count: 1,
      modelId: 'm',
      variationSeed: BRAINSTORM_VARIATION_SEED_MAX,
    }).success).toBe(true);
    expect(BrainstormCharactersRequestSchema.safeParse({ count: 1, modelId: 'm', variationSeed: -1 }).success).toBe(false);
    expect(BrainstormCharactersRequestSchema.safeParse({ count: 1, modelId: 'm', variationSeed: 1.5 }).success).toBe(false);
    expect(BrainstormCharactersRequestSchema.safeParse({
      count: 1,
      modelId: 'm',
      variationSeed: BRAINSTORM_VARIATION_SEED_MAX + 1,
    }).success).toBe(false);
  });

  it('rejects count above the ceiling', () => {
    const r = BrainstormCharactersRequestSchema.safeParse({
      count: BRAINSTORM_MAX_COUNT_CEILING + 1,
      modelId: 'm',
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty modelId', () => {
    expect(BrainstormCharactersRequestSchema.safeParse({ count: 1, modelId: '' }).success).toBe(false);
  });

  it('trims and bounds brief length', () => {
    const r = BrainstormCharactersRequestSchema.safeParse({ count: 1, modelId: 'm', brief: '  noir  ' });
    expect(r.success && r.data.brief).toBe('noir');
    expect(BrainstormCharactersRequestSchema.safeParse({
      count: 1,
      modelId: 'm',
      brief: 'x'.repeat(CHARACTER_SOURCE_TEXT_MAX_CHARS),
    }).success).toBe(true);
    expect(BrainstormCharactersRequestSchema.safeParse({
      count: 1,
      modelId: 'm',
      brief: 'x'.repeat(CHARACTER_SOURCE_TEXT_MAX_CHARS + 1),
    }).success).toBe(false);
  });
});
