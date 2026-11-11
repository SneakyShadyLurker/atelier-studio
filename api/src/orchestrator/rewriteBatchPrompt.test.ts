import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { describe, expect, test } from 'bun:test';
import { validateRewrite } from './rewriteBatchPrompt';

describe('validateRewrite', () => {
  test('accepts a trimmed rewrite', () => {
    expect(validateRewrite('  A tabby cat on a windowsill.\n')).toEqual({ ok: true, text: 'A tabby cat on a windowsill.' });
  });
  test('rejects empty output, refusal prose and an over-length result', () => {
    expect(validateRewrite(' \n ')).toEqual({ ok: false, reason: 'empty' });
    expect(validateRewrite('I can’t fulfill this request. It describes a sexualized depiction of a 15-year-old.'))
      .toEqual({ ok: false, reason: 'refusal' });
    expect(validateRewrite('word '.repeat(MAX_PROMPT_CHARS))).toEqual({ ok: false, reason: 'over-char-limit' });
  });
});
