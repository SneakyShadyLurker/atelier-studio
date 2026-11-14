import { describe, expect, test } from 'bun:test';
import { TEMPLATE_BODY_HARD_MAX } from '../../prompts/limits';
import { reworkTemplateResultFromContent, type DraftTemplateResult } from './featureHelpers';

const base = 'A red fox jumps over the lazy dog under a {{var::sky}} sky.';
const known = new Set(['sky', 'lens']);

function rework(content: unknown, existingBody = base, knownNames: ReadonlySet<string> = known): DraftTemplateResult {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return reworkTemplateResultFromContent(text, knownNames, existingBody, TEMPLATE_BODY_HARD_MAX);
}

function changesOf(result: DraftTemplateResult) {
  if (result.type !== 'ok' || result.payload.kind !== 'changes') throw new Error(`expected changes, got ${JSON.stringify(result)}`);
  return result.payload;
}

const UNPARSEABLE: DraftTemplateResult = { type: 'failed', kind: 'transient', status: null, detail: 'unparseable draft response' };

describe('reworkTemplateResultFromContent', () => {
  test('a well-formed answer places its changes at offsets into the body', () => {
    const payload = changesOf(rework({
      changes: [
        { why: 'Colder palette.', find: 'red', replace: 'grey' },
        { why: 'Livelier dog.', find: 'lazy dog', replace: 'sleepy hound' },
      ],
      summary: '  Cooler and livelier.  ',
    }));
    expect(payload).toEqual({
      kind: 'changes',
      baseLength: base.length,
      changes: [
        { id: 0, start: base.indexOf('red'), end: base.indexOf('red') + 3, replace: 'grey', why: 'Colder palette.' },
        { id: 1, start: base.indexOf('lazy dog'), end: base.indexOf('lazy dog') + 8, replace: 'sleepy hound', why: 'Livelier dog.' },
      ],
      unplaced: [],
      summary: 'Cooler and livelier.',
      warnings: [],
    });
  });

  test('malformed entries are skipped; a non-string why reads as empty and a non-string summary as null', () => {
    const payload = changesOf(rework({
      changes: [
        null,
        'red → grey',
        { why: 'no find', replace: 'x' },
        { why: 'number replace', find: 'fox', replace: 3 },
        { why: 42, find: 'red', replace: 'grey' },
        { find: 'jumps', replace: 'leaps' },
      ],
      summary: 7,
    }));
    expect(payload.changes.map((c) => ({ replace: c.replace, why: c.why }))).toEqual([
      { replace: 'grey', why: '' },
      { replace: 'leaps', why: '' },
    ]);
    expect(payload.unplaced).toEqual([]);
    expect(payload.summary).toBeNull();
  });

  test('at most the first 100 operations are read', () => {
    const words = Array.from({ length: 120 }, (_, i) => `w${String(i).padStart(3, '0')}`);
    const body = words.join(' ');
    const payload = changesOf(rework({
      changes: words.map((w) => ({ why: '', find: w, replace: w.toUpperCase() })),
      summary: 'Shouted.',
    }, body, new Set()));
    expect(payload.changes).toHaveLength(100);
    expect(payload.changes.at(-1)?.replace).toBe('W099');
  });

  test('a body answer becomes the hunks of one whole operation', () => {
    const payload = changesOf(rework({ kind: 'body', body: 'A red fox leaps over the lazy dog under a {{var::sky}} sky.', warnings: [] }));
    expect(payload.changes).toEqual([
      { id: 0, start: base.indexOf('jumps'), end: base.indexOf('jumps') + 5, replace: 'leaps', why: '' },
    ]);
    expect(payload.summary).toBeNull();
  });

  test('prose, or JSON with neither a changes array nor a string body, is the unparseable failure', () => {
    expect(rework('I changed the fox to grey.')).toEqual(UNPARSEABLE);
    expect(rework({ summary: 'nothing' })).toEqual(UNPARSEABLE);
    expect(rework({ changes: 'red → grey', summary: 'x' })).toEqual(UNPARSEABLE);
    expect(rework({ kind: 'body', body: 5 })).toEqual(UNPARSEABLE);
  });

  test('an unknown list in a replacement becomes its readable name with a warning; an unplaced one adds none', () => {
    const payload = changesOf(rework({
      changes: [
        { why: 'Vary the fox.', find: 'red', replace: '{{var::fur_colour}} {{var::lens}}' },
        { why: 'Gone.', find: 'cat', replace: '{{var::cat_breed}}' },
      ],
      summary: 'Varied.',
    }));
    expect(payload.changes.map((c) => c.replace)).toEqual(['fur colour {{var::lens}}']);
    expect(payload.unplaced).toEqual([{ find: 'cat', replace: 'cat breed', why: 'Gone.', reason: 'missing' }]);
    expect(payload.warnings).toEqual(['Removed unknown {{var::fur_colour}} reference']);
  });

  test("the summary is preceded by a whole operation's why, unless they are equal", () => {
    const rewritten = 'A grey fox jumps over the lazy dog under a {{var::sky}} sky.';
    expect(changesOf(rework({ changes: [{ why: 'Colder fox.', find: '', replace: rewritten }], summary: 'Recoloured.' })).summary)
      .toBe('Colder fox. Recoloured.');
    expect(changesOf(rework({ changes: [{ why: 'Colder fox.', find: '', replace: rewritten }], summary: 'Colder fox.' })).summary)
      .toBe('Colder fox.');
    expect(changesOf(rework({ changes: [{ why: 'Colder fox.', find: '', replace: rewritten }], summary: '' })).summary)
      .toBe('Colder fox.');
    expect(changesOf(rework({ changes: [{ why: '', find: '', replace: rewritten }], summary: ' ' })).summary)
      .toBeNull();
    expect(changesOf(rework({ changes: [], summary: 'Nothing to change.' }))).toEqual({
      kind: 'changes', baseLength: base.length, changes: [], unplaced: [], summary: 'Nothing to change.', warnings: [],
    });
  });

  test('fenced JSON is accepted', () => {
    const payload = changesOf(rework(`\`\`\`json\n${JSON.stringify({ changes: [{ why: 'w', find: 'red', replace: 'grey' }], summary: 's' })}\n\`\`\``));
    expect(payload.changes).toHaveLength(1);
    expect(payload.summary).toBe('s');
  });
});
