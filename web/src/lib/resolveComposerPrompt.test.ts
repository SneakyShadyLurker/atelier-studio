import { describe, expect, test } from 'bun:test';
import type { TagDimension, VariableList } from '@atelier/shared';
import { resolveComposerPrompt } from './resolveComposerPrompt';

const era: VariableList = {
  id: 'e',
  name: 'era',
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  options: [{ id: 'e1', listId: 'e', value: 'ancient era', tagIds: [], sortOrder: 0, weight: 1 }],
};
const dims: readonly TagDimension[] = [];
const library = { variableLists: [era], dimensions: dims };

describe('resolveComposerPrompt', () => {
  test('plain text passes through unchanged, no warnings', () => {
    const r = resolveComposerPrompt('a cat on a mat', undefined, 1);
    expect(r.text).toBe('a cat on a mat');
    expect(r.warnings).toHaveLength(0);
  });

  test('{{random::}} resolves with no library (macros work for everyone)', () => {
    const r = resolveComposerPrompt('a {{random::cat::dog}}', undefined, 7);
    expect(['a cat', 'a dog']).toContain(r.text);
    expect(r.warnings).toHaveLength(0);
  });

  test('{{random::}} is seeded-deterministic', () => {
    const a = resolveComposerPrompt('{{random::x::y::z}}', undefined, 42);
    const b = resolveComposerPrompt('{{random::x::y::z}}', undefined, 42);
    expect(a.text).toBe(b.text);
  });

  test('{{var::}} resolves from library data', () => {
    const r = resolveComposerPrompt('set in {{var::era}}', library, 3);
    expect(r.text).toBe('set in ancient era');
    expect(r.warnings).toHaveLength(0);
  });

  test('unknown {{var::}} with no library stays verbatim and warns', () => {
    const r = resolveComposerPrompt('set in {{var::era}}', undefined, 3);
    expect(r.text).toBe('set in {{var::era}}');
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test('comment-only prompt resolves to empty', () => {
    const r = resolveComposerPrompt('{{//just a note}}', undefined, 1);
    expect(r.text.trim()).toBe('');
  });

  test('re-resolving already-resolved output is idempotent (no double-roll)', () => {
    const once = resolveComposerPrompt('{{random::cat::dog}}', undefined, 5).text;
    const twice = resolveComposerPrompt(once, undefined, 999).text;
    expect(twice).toBe(once);
  });

  test('resolver-significant characters with no {{ braces pass through unchanged', () => {
    // Picker output can legitimately contain `::`, `1d6`, `,` etc. as plain
    // text — these must NOT be re-interpreted on a second resolution pass.
    const text = 'a man rolling 1d6 dice :: option a, option b';
    const r = resolveComposerPrompt(text, undefined, 3);
    expect(r.text).toBe(text);
    expect(r.warnings).toHaveLength(0);
  });
});
