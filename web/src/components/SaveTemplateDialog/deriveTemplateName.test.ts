import { describe, expect, test } from 'bun:test';
import { deriveTemplateName } from './deriveTemplateName';

describe('deriveTemplateName', () => {
  test('uses only the first line', () => {
    expect(deriveTemplateName('A serene koi pond\nsecond line ignored')).toBe('A serene koi pond');
  });

  test('trims surrounding whitespace', () => {
    expect(deriveTemplateName('   sunset over dunes   ')).toBe('sunset over dunes');
  });

  test('strips trailing punctuation', () => {
    expect(deriveTemplateName('a cat in a hat.')).toBe('a cat in a hat');
    expect(deriveTemplateName('what is this???')).toBe('what is this');
  });

  test('whitespace-only prompt yields empty string', () => {
    expect(deriveTemplateName('   \n  ')).toBe('');
    expect(deriveTemplateName('')).toBe('');
  });

  test('long line is cut at a word boundary at or before 64 chars', () => {
    const long = 'a photorealistic portrait of an astronaut riding a horse through a neon cyberpunk megacity at dusk';
    const out = deriveTemplateName(long);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(long.startsWith(out)).toBe(true);
    expect(out.endsWith(' ')).toBe(false);
  });

  test('very long single word is hard-cut to 64', () => {
    const out = deriveTemplateName('x'.repeat(200));
    expect(out).toBe('x'.repeat(64));
  });
});
