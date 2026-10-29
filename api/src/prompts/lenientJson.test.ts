import { describe, expect, it } from 'bun:test';
import { parseJsonLenient, repairJsonObject, sliceJsonObject } from './lenientJson';

describe('parseJsonLenient', () => {
  it('returns well-formed JSON untouched', () => {
    const obj = { fills: ['a fill'], notes: 'prose' };
    expect(parseJsonLenient(JSON.stringify(obj))).toEqual(obj);
  });

  // A measured DeepSeek V4 Flash defect: the notes string is closed
  // with an array bracket that was never opened.
  it('recovers the stray closing bracket DeepSeek emits after the notes', () => {
    const text = '{"fills":["a fill"],"notes":"prose"]}';
    expect(parseJsonLenient(text)).toEqual({ fills: ['a fill'], notes: 'prose' });
  });

  it('does not treat brackets inside string values as structure', () => {
    const notes = 'she signed form [B-12] on the {17th}, then "left"';
    const text = `{"fills":["a fill"],"notes":${JSON.stringify(notes)}]}`;
    expect(parseJsonLenient(text)).toEqual({ fills: ['a fill'], notes });
  });

  it('keeps escaped quotes and backslashes intact', () => {
    const notes = 'a \\ backslash and an \\"escaped\\" quote';
    const text = `{"fills":["a fill"],"notes":${JSON.stringify(notes)}]}`;
    expect(parseJsonLenient(text)).toEqual({ fills: ['a fill'], notes });
  });

  it('stops at the end of the first object and ignores trailing commentary', () => {
    const text = '{"fills":["a fill"],"notes":"prose"} — hope this helps!';
    expect(parseJsonLenient(text)).toEqual({ fills: ['a fill'], notes: 'prose' });
  });

  // Measured live: the model opened the fill with two raw newlines,
  // which JSON forbids inside a string.
  it('escapes raw newlines the model leaves unescaped inside strings', () => {
    const text = '{"fills":["\n\nCandid photo,\nsecond line"],"notes":"prose"}';
    expect(parseJsonLenient(text)).toEqual({
      fills: ['\n\nCandid photo,\nsecond line'],
      notes: 'prose',
    });
  });

  it('escapes raw tabs and carriage returns inside strings', () => {
    const text = '{"fills":["a\tb\r\nc"],"notes":"prose"}';
    expect(parseJsonLenient(text)).toEqual({ fills: ['a\tb\r\nc'], notes: 'prose' });
  });

  it('preserves already-escaped newlines rather than double-escaping', () => {
    const text = String.raw`{"fills":["line\nbreak"],"notes":"prose"}`;
    expect(parseJsonLenient(text)).toEqual({ fills: ['line\nbreak'], notes: 'prose' });
  });

  it('returns null for a truncated object rather than inventing a close', () => {
    expect(parseJsonLenient('{"fills":["a fill"],"notes":"prose')).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(parseJsonLenient('')).toBeNull();
    expect(parseJsonLenient('   ')).toBeNull();
  });

  // D3 in the measurement run: the notes value was stuffed into `fills` and the key
  // dropped entirely. Repair must not paper over a genuine shape violation — the
  // caller's cardinality check is what should reject this.
  it('does not fabricate a missing notes key', () => {
    const text = '{"fills":["a fill","notes text"]}';
    expect(parseJsonLenient(text)).toEqual({ fills: ['a fill', 'notes text'] });
  });
});

describe('repairJsonObject', () => {
  it('returns null when no object is present', () => {
    expect(repairJsonObject('no json here')).toBeNull();
  });

  it('drops a stray closer that does not match the open bracket', () => {
    expect(repairJsonObject('{"a":[1]]}')).toBe('{"a":[1]}');
  });

  it('handles nested structures', () => {
    const text = '{"a":{"b":[1,2,{"c":3}]},"d":"e"}';
    expect(repairJsonObject(text)).toBe(text);
  });
});

describe('sliceJsonObject', () => {
  it('slices first { through last } out of fenced or prose-wrapped output', () => {
    expect(sliceJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(sliceJsonObject('Here: {"a":{"b":2}} done')).toBe('{"a":{"b":2}}');
  });
  it('returns the trimmed input when no object braces exist', () => {
    expect(sliceJsonObject('  nothing  ')).toBe('nothing');
    expect(sliceJsonObject('} {')).toBe('} {');
  });
});
