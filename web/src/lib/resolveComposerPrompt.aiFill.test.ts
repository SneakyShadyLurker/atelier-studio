import { describe, expect, test } from 'bun:test';
import { resolveComposerPrompt } from './resolveComposerPrompt';

describe('resolveComposerPrompt leaves {{ai-fill}} literal', () => {
  test('ai-fill token survives macro resolution untouched', () => {
    const out = resolveComposerPrompt('hello {{ai-fill: a yard}} world', undefined, 1);
    expect(out.text).toContain('{{ai-fill: a yard}}');
  });

  test('ai-fill token is preserved while a sibling {{random}} resolves', () => {
    const out = resolveComposerPrompt('{{random::x::x}} {{ai-fill: a yard}}', undefined, 1);
    expect(out.text).toContain('{{ai-fill: a yard}}');
    expect(out.text.startsWith('x ')).toBe(true);
  });
});
