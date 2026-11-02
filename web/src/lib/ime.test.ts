import { describe, expect, test } from 'bun:test';
import { isImeComposing } from './ime';

describe('isImeComposing', () => {
  test('recognises native composition and the WebKit keyCode 229 keydown', () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposing({ nativeEvent: { isComposing: true }, keyCode: 13 })).toBe(true);
  });

  test('ordinary keys are not composition', () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposing({ nativeEvent: { isComposing: false }, keyCode: 27 })).toBe(false);
  });
});
