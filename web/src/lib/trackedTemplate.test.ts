import { describe, expect, mock, test } from 'bun:test';
import type { TemplateChange } from '@atelier/shared/template-rework';

// The word diff can only give up on a change far larger than any inline one,
// so a switch stands in for it to pin the failed-diff branches.
const real = await import('@atelier/shared/template-rework');
const realDiff = real.diffWordRuns;
let diffGivesUp = false;
await mock.module('@atelier/shared/template-rework', () => ({
  ...real,
  diffWordRuns: (before: string, after: string, maxEditLength: number) =>
    (diffGivesUp ? undefined : realDiff(before, after, maxEditLength)),
}));
const { segmentTemplate } = await import('./trackedTemplate');
type Segment = ReturnType<typeof segmentTemplate>[number];

const OPTIONS = { collapseWords: 60 };

/** `count` distinct words: p0 p1 p2 … */
const words = (count: number, prefix: string): string =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(' ');

/** Changes for each `[find, replace]`, located by the first occurrence of `find` at or after the previous change. */
function changesIn(base: string, edits: readonly (readonly [string, string])[]): TemplateChange[] {
  let from = 0;
  return edits.map(([find, replace], id) => {
    const start = base.indexOf(find, from);
    if (start < 0) throw new Error(`"${find}" is not in the base`);
    from = start + find.length + 1;
    return { id, start, end: start + find.length, replace, why: `why ${id}` };
  });
}

/** A compact picture of the segments: same/fold text, [change id], {notes}. */
function shape(segments: readonly Segment[]): string[] {
  return segments.map((segment) => {
    switch (segment.kind) {
      case 'same': return segment.text;
      case 'fold': return `<fold ${segment.words}>`;
      case 'change': return `[${segment.change.id} ${segment.mode}]`;
      case 'notes': return `{${segment.ids.join(',')}}`;
    }
  });
}

function rebuilt(segments: readonly Segment[]): string {
  return segments.map((segment) => {
    if (segment.kind === 'same' || segment.kind === 'fold') return segment.text;
    if (segment.kind === 'change') return segment.find;
    return '';
  }).join('');
}

function expectInvariants(base: string, changes: readonly TemplateChange[], segments: readonly Segment[]): void {
  expect(rebuilt(segments)).toBe(base);
  // Every same/fold start is its offset in the base.
  let offset = 0;
  for (const segment of segments) {
    if (segment.kind === 'same' || segment.kind === 'fold') {
      expect(segment.start).toBe(offset);
      offset += segment.text.length;
    } else if (segment.kind === 'change') {
      expect(segment.change.start).toBe(offset);
      offset += segment.find.length;
    }
  }
  const changeIndex = new Map<number, number>();
  const noteIndex = new Map<number, number[]>();
  const modes = new Map<number, string>();
  segments.forEach((segment, index) => {
    if (segment.kind === 'change') {
      changeIndex.set(segment.change.id, index);
      modes.set(segment.change.id, segment.mode);
    }
    if (segment.kind === 'notes') {
      expect(segment.ids.length > 0).toBe(true);
      expect(segment.ids.toSorted((a, z) => a - z)).toEqual([...segment.ids]);
      for (const id of segment.ids) noteIndex.set(id, [...(noteIndex.get(id) ?? []), index]);
    }
  });
  expect(changeIndex.size).toBe(changes.length);
  for (const change of changes) {
    const at = changeIndex.get(change.id) ?? -1;
    const notes = noteIndex.get(change.id) ?? [];
    if (modes.get(change.id) === 'block') {
      expect(notes).toEqual([]);
    } else {
      expect(notes).toHaveLength(1);
      expect((notes[0] ?? -1) > at).toBe(true);
    }
  }
}

describe('segmentTemplate modes (R4.2)', () => {
  function only(base: string, find: string, replace: string) {
    const changes = changesIn(base, [[find, replace]]);
    const segments = segmentTemplate(base, changes, OPTIONS);
    expectInvariants(base, changes, segments);
    const change = segments.find((segment) => segment.kind === 'change');
    if (change?.kind !== 'change') throw new Error('no change segment');
    return change;
  }

  test('a small edit is inline with the word diff runs', () => {
    const change = only('A red coat in soft light.', 'red coat', 'blue coat');
    expect(change.mode).toBe('inline');
    expect(change.find).toBe('red coat');
    expect(change.runs).toEqual([
      { kind: 'del', text: 'red' },
      { kind: 'ins', text: 'blue' },
      { kind: 'same', text: ' coat' },
    ]);
  });

  test('a pure insertion is one inserted run, inline, however long', () => {
    const base = 'A coat.';
    const changes: TemplateChange[] = [{ id: 0, start: 1, end: 1, replace: ` ${words(120, 'n')}`, why: '' }];
    const [, change] = segmentTemplate(base, changes, OPTIONS);
    expect(change?.kind === 'change' && change.mode).toBe('inline');
    expect(change?.kind === 'change' && change.runs).toEqual([{ kind: 'ins', text: ` ${words(120, 'n')}` }]);
  });

  test('a pure removal is one struck run, inline, however long', () => {
    const passage = words(120, 'o');
    const change = only(`Start. ${passage}. End.`, passage, '');
    expect(change.mode).toBe('inline');
    expect(change.runs).toEqual([{ kind: 'del', text: passage }]);
  });

  test('a large passage replaced by a short one is a block', () => {
    const passage = words(70, 'o');
    const change = only(`Start. ${passage}. End.`, passage, words(20, 'n'));
    expect(change.mode).toBe('block');
    expect(change.runs).toEqual([{ kind: 'del', text: passage }, { kind: 'ins', text: words(20, 'n') }]);
  });

  test('a large rewrite that keeps little of the passage is a block', () => {
    const change = only(`Start. ${words(50, 'o')}. End.`, words(50, 'o'), words(50, 'n'));
    expect(change.mode).toBe('block');
  });

  test('a large rewrite that keeps most of the passage is inline', () => {
    const passage = words(50, 'o');
    const change = only(`Start. ${passage}. End.`, passage, passage.replace('o3 ', 'n3 '));
    expect(change.mode).toBe('inline');
  });

  test('80 words together is not yet large', () => {
    const change = only(`Start. ${words(60, 'o')}. End.`, words(60, 'o'), words(20, 'n'));
    expect(change.mode).toBe('inline');
  });

  test('a diff that gives up makes a large change a block and a small one struck then inserted inline', () => {
    diffGivesUp = true;
    try {
      const large = only(`Start. ${words(50, 'o')}. End.`, words(50, 'o'), words(50, 'o').replace('o1 ', 'n1 '));
      expect(large.mode).toBe('block');
      const small = only('A red coat.', 'red', 'blue');
      expect(small.mode).toBe('inline');
      expect(small.runs).toEqual([{ kind: 'del', text: 'red' }, { kind: 'ins', text: 'blue' }]);
    } finally {
      diffGivesUp = false;
    }
  });
});

describe('segmentTemplate folds (R4.3)', () => {
  test('a short unchanged run is never folded', () => {
    const base = `${words(50, 'a')}. The coat is red.`;
    expect(shape(segmentTemplate(base, changesIn(base, [['red', 'blue']]), OPTIONS))).toEqual([
      `${words(50, 'a')}. The coat is `, '[0 inline]', '.', '{0}',
    ]);
  });

  test('a long run folds, keeping the short sentence beside the change', () => {
    // Sentences start upper case: ICU does not break before a lower-case word.
    const base = `${words(70, 'a')}. The coat is red today. ${words(70, 'B')}.`;
    const changes = changesIn(base, [['red', 'blue']]);
    const segments = segmentTemplate(base, changes, OPTIONS);
    expectInvariants(base, changes, segments);
    expect(shape(segments)).toEqual([
      '<fold 70>', 'The coat is ', '[0 inline]', ' today. ', '{0}', '<fold 70>',
    ]);
    expect(segments[0]?.kind === 'fold' && segments[0].text).toBe(`${words(70, 'a')}. `);
  });

  test('beside a long sentence the context is 12 words', () => {
    const base = `${words(70, 'a')} red ${words(70, 'b')}.`;
    const changes = changesIn(base, [['red', 'blue']]);
    const segments = segmentTemplate(base, changes, OPTIONS);
    expectInvariants(base, changes, segments);
    expect(shape(segments)).toEqual([
      '<fold 58>', `${words(70, 'a').split(' ').slice(58).join(' ')} `, '[0 inline]',
      ` ${words(12, 'b')}`, '{0}', '<fold 58>',
    ]);
  });

  test('a fold that would hide fewer than 12 words is not made', () => {
    // 63 words between two changes; their sentences keep 58, so 5 would fold.
    const base = `Red ${words(29, 'a')}. ${words(5, 'M')}. ${words(29, 'C')} green.`;
    expect(shape(segmentTemplate(base, changesIn(base, [['Red', 'Blue'], ['green', 'black']]), OPTIONS))).toEqual([
      '[0 inline]', ` ${words(29, 'a')}. `, '{0}', `${words(5, 'M')}. ${words(29, 'C')} `, '[1 inline]', '.', '{1}',
    ]);
  });

  test('the collapse threshold comes from the caller', () => {
    const base = `${words(30, 'a')}. The coat is red.`;
    expect(shape(segmentTemplate(base, changesIn(base, [['red', 'blue']]), { collapseWords: 20 }))).toEqual([
      '<fold 30>', 'The coat is ', '[0 inline]', '.', '{0}',
    ]);
  });
});

describe('segmentTemplate note placement (R4.4)', () => {
  function segments(base: string, edits: readonly (readonly [string, string])[]) {
    const changes = changesIn(base, edits);
    const out = segmentTemplate(base, changes, OPTIONS);
    expectInvariants(base, changes, out);
    return shape(out);
  }

  test('the note stands at the end of the sentence holding the change', () => {
    expect(segments('The coat is red today. The hat is grey.', [['red', 'blue']])).toEqual([
      'The coat is ', '[0 inline]', ' today. ', '{0}', 'The hat is grey.',
    ]);
  });

  test('the note stands before the line break that ends the sentence', () => {
    expect(segments('The coat is red today.\n\nThe hat is grey.', [['red', 'blue']])).toEqual([
      'The coat is ', '[0 inline]', ' today.', '{0}', '\n\nThe hat is grey.',
    ]);
  });

  test('the note follows a change that runs past its sentence end', () => {
    expect(segments('The coat is red. The hat is grey.', [['red. The', 'blue. A']])).toEqual([
      'The coat is ', '[0 inline]', ' hat is grey.', '{0}',
    ]);
  });

  test('a note at the end of the base follows the last text', () => {
    expect(segments('The coat is red', [['red', 'blue']])).toEqual(['The coat is ', '[0 inline]', '{0}']);
  });

  test('notes of changes in one sentence stack in text order', () => {
    expect(segments('The coat is red and the hat is green. Next.', [['red', 'blue'], ['green', 'black']])).toEqual([
      'The coat is ', '[0 inline]', ' and the hat is ', '[1 inline]', '. ', '{0,1}', 'Next.',
    ]);
  });

  test('an insertion is followed by its note, and an earlier note at its place stays before it', () => {
    const base = 'The coat is red. Next.';
    const changes: TemplateChange[] = [
      { id: 0, start: 12, end: 15, replace: 'blue', why: '' },
      { id: 1, start: 17, end: 17, replace: 'Bright. ', why: '' },
    ];
    const out = segmentTemplate(base, changes, OPTIONS);
    expectInvariants(base, changes, out);
    expect(shape(out)).toEqual(['The coat is ', '[0 inline]', '. ', '{0}', '[1 inline]', 'Next.', '{1}']);
  });

  test('a note that would fall inside a fold moves to where the fold begins', () => {
    const base = `The coat is red ${words(70, 'b')}. Next.`;
    // The sentence ends past the 12 words of context, inside the fold.
    const out = segments(base, [['red', 'blue']]);
    expect(out).toEqual(['The coat is ', '[0 inline]', ` ${words(12, 'b')}`, '{0}', '<fold 59>']);
  });

  test('a note never stands inside a short token that nests no other', () => {
    expect(segments('Wear {{random::a red coat. Or a hat.::boots}} today. Next.', [['red', 'blue']])).toEqual([
      'Wear {{random::a ', '[0 inline]', ' coat. Or a hat.::boots}}', '{0}', ' today. Next.',
    ]);
  });

  test('the token clamp applies to a leaf token at any depth', () => {
    expect(segments('Wear {{random::x::{{random::a red coat. Or a hat.::b}}}} today.', [['red', 'blue']])).toEqual([
      'Wear {{random::x::{{random::a ', '[0 inline]', ' coat. Or a hat.::b}}', '{0}', '}} today.',
    ]);
  });

  test('a token that nests another does not hold the note back', () => {
    expect(segments('Wear {{random::a red coat. Or {{var::hat}}.::boots}} today.', [['red', 'blue']])).toEqual([
      'Wear {{random::a ', '[0 inline]', ' coat. ', '{0}', 'Or {{var::hat}}.::boots}} today.',
    ]);
  });

  test('a leaf token over 120 characters does not hold the note back', () => {
    const long = `{{random::a red coat. ${'X'.repeat(120)}::boots}}`;
    expect(segments(`Wear ${long} today.`, [['red', 'blue']])).toEqual([
      'Wear {{random::a ', '[0 inline]', ' coat. ', '{0}', `${'X'.repeat(120)}::boots}} today.`,
    ]);
  });

  test('a block carries its own note; an inline note it interrupts waits before it', () => {
    const passage = words(70, 'o');
    const base = `The coat is red and ${passage}. End.`;
    const out = segments(base, [['red', 'blue'], [passage, words(11, 'n')]]);
    expect(out).toEqual(['The coat is ', '[0 inline]', ' and ', '{0}', '[1 block]', '. End.']);
  });
});

describe('segmentTemplate invariants', () => {
  test('a base without changes is its own text', () => {
    expect(shape(segmentTemplate('A coat.', [], OPTIONS))).toEqual(['A coat.']);
    expect(segmentTemplate('', [], OPTIONS)).toEqual([]);
  });

  // fast-check does not resolve from the web package, so a seeded generator
  // stands in: many bases with sentences, line breaks and tokens, and random
  // R1.2 change sets over them.
  function generator(seed: number) {
    let state = seed >>> 0;
    const next = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 2 ** 32;
    };
    const int = (max: number): number => Math.floor(next() * max);
    return { int };
  }

  const PIECES = ['word', 'red', 'coat', '. ', '.\n', '\n\n', ' ', '{{var::hat}}', '{{random::a. b::c}}', '{{random::x::{{var::y}}}}', '’', 'é', '🙂'];

  test.each(Array.from({ length: 300 }, (_, seed) => seed))('seed %i keeps the base and places every note once', (seed) => {
    const { int } = generator(seed + 1);
    const parts = Array.from({ length: 5 + int(400) }, () => {
      const piece = PIECES[int(PIECES.length)] ?? ' ';
      return piece.length > 2 ? `${piece} ` : piece;
    });
    const base = parts.join('');
    const changes: TemplateChange[] = [];
    let at = 0;
    while (at < base.length && changes.length < 12) {
      const start = at + int(Math.max(1, Math.floor(base.length / 4)));
      if (start > base.length) break;
      const end = Math.min(base.length, start + int(200));
      const replace = int(4) === 0 ? '' : Array.from({ length: int(120) }, () => PIECES[int(3)]).join(' ');
      changes.push({ id: changes.length, start, end, replace, why: '' });
      at = end + 1;
    }
    const collapseWords = [5, 20, 60][int(3)] ?? 60;
    expectInvariants(base, changes, segmentTemplate(base, changes, { collapseWords }));
  });
});
