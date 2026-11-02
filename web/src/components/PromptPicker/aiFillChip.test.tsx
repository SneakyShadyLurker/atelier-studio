import { describe, expect, test } from 'bun:test';
import { toPreviewSegments } from './aiFillPreview';

describe('toPreviewSegments', () => {
  test('splits text and ai-fill chips', () => {
    expect(toPreviewSegments('A {{ai-fill: yard}} B')).toEqual([
      { kind: 'text', value: 'A ', start: 0 },
      { kind: 'aiFill', value: 'yard', start: 2 },
      { kind: 'text', value: ' B', start: 6 },
    ]);
  });
  test('plain text → single text segment', () => {
    expect(toPreviewSegments('no tokens')).toEqual([{ kind: 'text', value: 'no tokens', start: 0 }]);
  });
  test('two adjacent chips with no text between', () => {
    expect(toPreviewSegments('{{ai-fill: a}}{{ai-fill: b}}')).toEqual([
      { kind: 'aiFill', value: 'a', start: 0 },
      { kind: 'aiFill', value: 'b', start: 1 },
    ]);
  });
  test('start offsets are unique render keys', () => {
    const segments = toPreviewSegments('A {{ai-fill: x}}{{ai-fill: y}} B');
    const keys = segments.map((seg) => `${seg.kind}:${String(seg.start)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
