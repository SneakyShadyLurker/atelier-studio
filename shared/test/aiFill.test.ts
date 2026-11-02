import { describe, expect, test } from 'bun:test';
import {
  AI_FILL_BATCH_MAX,
  AI_FILL_RECORD_SEPARATOR,
  AI_FILL_MAX_SLOTS,
  aiFillMeasuredLength,
  assembleAiFillPrompt,
  hasAiFillTokens,
  maskAiFillTokens,
  parseAiFillTokens,
  splitOnAiFillSentinels,
  stripCardNotesToken,
} from '../src/aiFill';

describe('aiFillMeasuredLength', () => {
  test('counts only static text when ai-fill tokens are present', () => {
    expect(aiFillMeasuredLength('A woman, {{ai-fill: a long wardrobe instruction}}.')).toBe('A woman, .'.length);
  });

  test('counts the whole prompt without ai-fill tokens', () => {
    expect(aiFillMeasuredLength('plain {{var::face}}')).toBe('plain {{var::face}}'.length);
  });
});

describe('parseAiFillTokens', () => {
  test('extracts instructions + static segments, single and double colon', () => {
    const r = parseAiFillTokens('A woman, {{ai-fill: her swimsuit}}, golden hour, {{ai-fill:: her pose}}.');
    expect(r.slots.map((s) => s.instruction)).toEqual(['her swimsuit', 'her pose']);
    expect(r.staticSegments).toEqual(['A woman, ', ', golden hour, ', '.']);
  });

  test('no ai-fill tokens → one static segment, no slots', () => {
    const r = parseAiFillTokens('just a plain prompt {{var::face}}');
    expect(r.slots).toEqual([]);
    expect(r.staticSegments).toEqual(['just a plain prompt {{var::face}}']);
  });

  test('whole prompt is one ai-fill token', () => {
    const r = parseAiFillTokens('{{ai-fill: an idyllic backyard}}');
    expect(r.slots.map((s) => s.instruction)).toEqual(['an idyllic backyard']);
    expect(r.staticSegments).toEqual(['', '']);
  });

  test('non-ai-fill tokens stay inside static segments verbatim', () => {
    const r = parseAiFillTokens('{{random::a::b}} {{ai-fill: x}}');
    expect(r.staticSegments).toEqual(['{{random::a::b}} ', '']);
    expect(r.slots.map((s) => s.instruction)).toEqual(['x']);
  });

  test('instruction containing a nested {{...}} token is captured whole', () => {
    const r = parseAiFillTokens('scene: {{ai-fill: a {{var::mood}} yard}}');
    expect(r.slots.map((s) => s.instruction)).toEqual(['a {{var::mood}} yard']);
    expect(r.staticSegments).toEqual(['scene: ', '']);
  });

  test('skeleton renders [[N]] markers in order', () => {
    const r = parseAiFillTokens('A {{ai-fill: x}} B {{ai-fill: y}} C');
    expect(r.skeleton).toBe('A [[1]] B [[2]] C');
  });
});

describe('hasAiFillTokens', () => {
  test('true only when an ai-fill token is present', () => {
    expect(hasAiFillTokens('{{ai-fill: x}}')).toBe(true);
    expect(hasAiFillTokens('{{ai-fill:: x}}')).toBe(true);
    expect(hasAiFillTokens('{{var::face}}')).toBe(false);
  });
});

describe('retired card-notes token', () => {
  test('strips only the exact bare token while preserving surrounding bytes', () => {
    expect(stripCardNotesToken('before {{card-notes}} after')).toBe('before  after');
    expect(stripCardNotesToken('before {{card-notes: nope}} after')).toBe('before {{card-notes: nope}} after');
  });
});

describe('assembleAiFillPrompt', () => {
  test('splices fills between static segments verbatim', () => {
    const out = assembleAiFillPrompt(['A woman, ', ', golden hour.'], ['a red bikini']);
    expect(out).toBe('A woman, a red bikini, golden hour.');
  });

  test('throws on count mismatch', () => {
    expect(() => assembleAiFillPrompt(['a', 'b', 'c'], ['only one'])).toThrow();
  });
});

describe('mask / split round-trip', () => {
  test('masking then splitting recovers segment boundaries', () => {
    const { masked, slotCount } = maskAiFillTokens('A {{ai-fill: x}} B {{ai-fill: y}} C');
    expect(slotCount).toBe(2);
    // Simulate the var resolver mutating only the static text:
    const resolved = masked.replace('A ', 'AA ').replace(' C', ' CC');
    const segments = splitOnAiFillSentinels(resolved, slotCount);
    expect(segments).toEqual(['AA ', ' B ', ' CC']);
  });

  test('refuses to mask when the prompt already contains the sentinel char', () => {
    expect(() => maskAiFillTokens('A \u0000 {{ai-fill: x}}')).toThrow();
  });

  test('split rejects a sentinel collision injected by resolution', () => {
    const { masked, slotCount } = maskAiFillTokens('A {{ai-fill: x}} B');
    const NUL = String.fromCharCode(0);
    // Simulate the var resolver expanding a value that contains the reserved byte.
    const forged = masked.replace('A ', `A ${NUL}AIFILL0${NUL} `);
    expect(() => splitOnAiFillSentinels(forged, slotCount)).toThrow();
  });
});

test('AI_FILL_MAX_SLOTS is a small positive cap', () => {
  expect(AI_FILL_MAX_SLOTS).toBe(8);
});

test('batch constants lock the public grouping and record protocol', () => {
  expect(AI_FILL_BATCH_MAX).toBe(4);
  expect(AI_FILL_RECORD_SEPARATOR).toBe('<<<§ATELIER_AIFILL_RECORD§>>>');
});
