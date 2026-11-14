import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  applyTemplateChanges,
  countWords,
  diffWordRuns,
  isTemplateChangeSet,
  isTokenSafe,
  placeTemplateOperations,
  type PlaceOptions,
  type TemplateChange,
  type TemplateOperation,
  type TemplatePlacement,
} from './templateRework';

const identity: PlaceOptions['sanitize'] = (text) => ({ text, warnings: [] });

// Stands in for the api's token rules: an unknown `{{var::other}}` or
// `{{var::hue}}` becomes its readable name with a warning.
const sanitizeUnknown: PlaceOptions['sanitize'] = (text) => {
  const warnings: string[] = [];
  const out = text.replace(/\{\{var::(other|hue)\}\}/gu, (_whole, name: string) => {
    warnings.push(`Unknown list ${name}`);
    return name;
  });
  return { text: out, warnings };
};

const options = (overrides: Partial<PlaceOptions> = {}): PlaceOptions => ({
  sanitize: identity,
  maxGrowthChars: 2000,
  maxBodyBytes: 65_536,
  ...overrides,
});

const op = (find: string, replace: string, why = 'because'): TemplateOperation => ({ why, find, replace });

const place = (base: string, ops: TemplateOperation[], overrides: Partial<PlaceOptions> = {}): TemplatePlacement =>
  placeTemplateOperations(base, ops, options(overrides));

const applyAll = (base: string, changes: readonly TemplateChange[]): string =>
  applyTemplateChanges(base, changes, changes.map((change) => change.id));

describe('placeTemplateOperations: matching', () => {
  test('an exact find is placed at its offsets', () => {
    const base = 'a red fox jumps';
    const result = place(base, [op('red', 'grey', 'Colder palette.')]);
    expect(result.changes).toEqual([{ id: 0, start: 2, end: 5, replace: 'grey', why: 'Colder palette.' }]);
    expect(result.unplaced).toEqual([]);
    expect(result.wholeWhy).toBeNull();
    expect(applyAll(base, result.changes)).toBe('a grey fox jumps');
  });

  test('a find that is not in the base is missing and carries the sanitized replacement', () => {
    const result = place('a red fox', [op('blue', 'a {{var::other}}', 'x')], { sanitize: sanitizeUnknown });
    expect(result.changes).toEqual([]);
    expect(result.unplaced).toEqual([{ find: 'blue', replace: 'a other', why: 'x', reason: 'missing' }]);
    expect(result.warnings).toEqual([]);
  });

  test('a find that occurs twice is ambiguous', () => {
    const result = place('cat and cat', [op('cat', 'dog')]);
    expect(result.unplaced.map((u) => u.reason)).toEqual(['ambiguous']);
  });

  test('a whitespace-normalized find maps back to the original offsets', () => {
    const base = 'Intro.  He said\n\t“hello” — to   the ‘world’ today.';
    const result = place(base, [op('said "hello" - to the \'world\'', 'whispered')]);
    const start = base.indexOf('said');
    const end = base.indexOf('’') + 1;
    expect(result.changes).toEqual([{ id: 0, start, end, replace: 'whispered', why: 'because' }]);
    expect(applyAll(base, result.changes)).toBe('Intro.  He whispered today.');
  });

  test('every listed fold matches one to one', () => {
    const base = 'x ‘’‚‛′ “”„‟″ ‐‑‒–—− y';
    const result = place(base, [op(`'''''  """"" ------`, 'z')]);
    expect(result.changes).toEqual([{ id: 0, start: 2, end: base.length - 2, replace: 'z', why: 'because' }]);
  });

  test('a normalized find that occurs twice is ambiguous', () => {
    const result = place('a “b” c and a "b"  c', [op('a  "b" c', 'q')]);
    expect(result.unplaced.map((u) => u.reason)).toEqual(['ambiguous']);
  });
});

describe('placeTemplateOperations: widening, sanitize, no-op', () => {
  test('an edge inside a {{var::…}} token widens to the token edge, then sanitize runs', () => {
    const base = 'a {{var::colour}} cat sleeps';
    const result = place(base, [op('colour}} cat', 'hue}} dog')], { sanitize: sanitizeUnknown });
    expect(result.changes).toEqual([
      { id: 0, start: 2, end: base.indexOf(' sleeps'), replace: 'hue dog', why: 'because' },
    ]);
    expect(result.warnings).toEqual(['Unknown list hue']);
  });

  test('an end edge inside a nested {{var::…}} token widens to its end', () => {
    const base = '{{ai-fill: a {{var::colour}} cat}}';
    const result = place(base, [op('a {{var::col', 'one {{var::col')]);
    const tokenEnd = base.indexOf('}} cat') + 2;
    expect(result.changes).toEqual([
      { id: 0, start: base.indexOf('a {{'), end: tokenEnd, replace: 'one {{var::colour}}', why: 'because' },
    ]);
  });

  test('a replacement equal to its passage is dropped silently, with its warnings', () => {
    const sanitize: PlaceOptions['sanitize'] = (text) => ({ text, warnings: ['ignored'] });
    const result = place('a cat', [op('cat', 'cat')], { sanitize });
    expect(result).toEqual({ changes: [], unplaced: [], wholeWhy: null, warnings: [] });
  });

  test('a replacement equal after sanitize is a no-op', () => {
    const result = place('a other', [op('other', '{{var::other}}')], { sanitize: sanitizeUnknown });
    expect(result).toEqual({ changes: [], unplaced: [], wholeWhy: null, warnings: [] });
  });
});

describe('placeTemplateOperations: token safety, overlap, length', () => {
  test('a change that cuts through a token is splits_token', () => {
    const base = 'x {{random::a::b}} y';
    const result = place(base, [op('{{random::a::b', 'plain'), op('b}} y', 'c')]);
    expect(result.unplaced.map((u) => u.reason)).toEqual(['splits_token', 'splits_token']);
  });

  test('a change that splits a {{ pair is splits_token', () => {
    const result = place('ab{{random::a::b}}', [op('b{', 'q{')]);
    expect(result.unplaced.map((u) => u.reason)).toEqual(['splits_token']);
  });

  test('overlapping and touching changes are overlap', () => {
    const base = 'one two three four';
    const result = place(base, [op('two', '2'), op('two three', 'x'), op(' three', '3'), op('four', '4')]);
    expect(result.changes.map((c) => c.replace)).toEqual(['2', '4']);
    expect(result.unplaced.map((u) => u.reason)).toEqual(['overlap', 'overlap']);
  });

  test('changes come back sorted by start with id equal to index; unplaced keep arrival order', () => {
    const result = place('one two three', [op('three', '3'), op('zzz', 'q'), op('one', '1'), op('yyy', 'r')]);
    expect(result.changes.map((c) => [c.id, c.replace])).toEqual([[0, '1'], [1, '3']]);
    expect(result.unplaced.map((u) => u.find)).toEqual(['zzz', 'yyy']);
  });

  test('growth over the character limit is too_long, counted in code points', () => {
    expect(place('ab', [op('a', '😀😀')], { maxGrowthChars: 1 }).changes).toHaveLength(1);
    expect(place('ab', [op('a', '😀😀😀')], { maxGrowthChars: 1 }).unplaced.map((u) => u.reason))
      .toEqual(['too_long']);
  });

  test('growth accumulates across placed changes and shrinking earns no credit', () => {
    const base = 'aaaaaa b c';
    const result = place(base, [op('aaaaaa', 'a'), op('b', 'bbb'), op('c', 'ccc')], { maxGrowthChars: 3 });
    expect(result.changes.map((c) => c.replace)).toEqual(['a', 'bbb']);
    expect(result.unplaced.map((u) => u.reason)).toEqual(['too_long']);
  });

  test('byte growth counts UTF-8 bytes on top of the base', () => {
    // 'a' (1 byte) -> 'ééé' (6 bytes): 5 bytes of growth on a 2-byte base.
    expect(place('ab', [op('a', 'ééé')], { maxBodyBytes: 7 }).changes).toHaveLength(1);
    expect(place('ab', [op('a', 'ééé')], { maxBodyBytes: 6 }).unplaced.map((u) => u.reason)).toEqual(['too_long']);
  });

  test('warnings come from placed changes only, deduplicated in first-seen order', () => {
    const sanitize: PlaceOptions['sanitize'] = (text) => ({ text, warnings: text.split('').filter((c) => /[A-Z]/u.test(c)) });
    const result = place('one two three four', [
      op('one', 'B1'), op('nope', 'C'), op('two', 'A2'), op('three', 'B3'), op('four', 'Ddddddd'),
    ], { sanitize, maxGrowthChars: 2 });
    expect(result.unplaced.map((u) => u.reason)).toEqual(['missing', 'too_long']);
    expect(result.warnings).toEqual(['B', 'A']);
  });
});

describe('placeTemplateOperations: whole operations', () => {
  test('an empty find is decomposed into word hunks with empty why', () => {
    const base = 'one two three four five six';
    const result = place(base, [op('', 'one two three four FIVE six', 'Shouted five.')]);
    expect(result.changes).toEqual([
      { id: 0, start: base.indexOf('five'), end: base.indexOf(' six'), replace: 'FIVE', why: '' },
    ]);
    expect(result.wholeWhy).toBe('Shouted five.');
  });

  test('a find spanning the base except surrounding whitespace is whole', () => {
    const base = '\n one two three four five\n';
    const result = place(base, [op('one two three four five', '\n one two three four 5\n', ' ')]);
    expect(result.changes).toEqual([{ id: 0, start: base.indexOf('five'), end: base.indexOf('five') + 4, replace: '5', why: '' }]);
    expect(result.wholeWhy).toBeNull();
  });

  test("a whole rewrite takes the base's outer whitespace, so trimming it changes nothing", () => {
    const base = '\n  one two three four five\n\n';
    const result = place(base, [op('', 'one two three four 5', 'Digits.')]);
    expect(result.changes).toEqual([{ id: 0, start: base.indexOf('five'), end: base.indexOf('five') + 4, replace: '5', why: '' }]);
    expect(place(base, [op('', ' one two three four five ', 'Nothing.')]).changes).toEqual([]);
  });

  test('a whole operation equal to the base is dropped', () => {
    const result = place('same text', [op('', 'same text', 'nothing')]);
    expect(result).toEqual({ changes: [], unplaced: [], wholeWhy: null, warnings: [] });
  });

  test('a whole operation after a placed change is overlap, and everything after a whole is overlap', () => {
    const first = place('one two three', [op('one', '1'), op('', 'x y z')]);
    expect(first.unplaced.map((u) => u.reason)).toEqual(['overlap']);
    const second = place('one two three', [op('', 'one 2 three'), op('three', '3'), op('', 'q')]);
    expect(second.changes).toHaveLength(1);
    expect(second.unplaced.map((u) => u.reason)).toEqual(['overlap', 'overlap']);
  });

  test('a later operation after a whole one is still checked in step order', () => {
    const result = place('one two three', [op('', 'one 2 three'), op('nope', 'x')]);
    expect(result.unplaced.map((u) => u.reason)).toEqual(['missing']);
  });

  test('a whole operation whose net growth is over the limit is too_long', () => {
    const result = place('ab', [op('', 'abcdef')], { maxGrowthChars: 3 });
    expect(result.unplaced).toEqual([{ find: '', replace: 'abcdef', why: 'because', reason: 'too_long' }]);
  });

  test('hunks separated by at most two unchanged words merge', () => {
    const base = 'a b c d e f g h i j';
    expect(place(base, [op('', 'X b c Y e f g h i j')]).changes)
      .toEqual([{ id: 0, start: 0, end: 7, replace: 'X b c Y', why: '' }]);
    expect(place(base, [op('', 'X b c d Y f g h i j')]).changes.map((c) => c.replace)).toEqual(['X', 'Y']);
  });

  test('two edits inside one {{var::…}} token merge after widening', () => {
    const base = 'pre {{var::one two three four five}} post text here';
    const after = 'pre {{var::uno two three four cinco}} post text here';
    const start = base.indexOf('{{');
    const end = base.indexOf('}}') + 2;
    expect(place(base, [op('', after)]).changes)
      .toEqual([{ id: 0, start, end, replace: '{{var::uno two three four cinco}}', why: '' }]);
  });

  test('a hunk that would split a token merges with the next until token-safe', () => {
    const base = 'k {{one two three}} l m n o p q';
    const after = 'k one two three l m n o p Q';
    const result = place(base, [op('', after)]);
    expect(result.changes).toEqual([
      { id: 0, start: 2, end: base.indexOf(' l'), replace: 'one two three', why: '' },
      { id: 1, start: base.length - 1, end: base.length, replace: 'Q', why: '' },
    ]);
    expect(applyAll(base, result.changes)).toBe(after);
  });

  test('the last hunk merges with the previous one when it is not token-safe', () => {
    // '}}' moves past ' b c d': alone and merged with the insertion it is
    // unsafe, so the merged last hunk takes in the previous one.
    const base = 'Q r s t {{x y z w}} b c d';
    const after = 'q r s t {{x y z w b c d}}';
    const result = place(base, [op('', after)]);
    expect(result.changes).toEqual([{ id: 0, start: 0, end: base.length, replace: after, why: '' }]);
  });

  test('merging that ends in one unsafe hunk falls back to one whole change', () => {
    const base = 'k {{one two three}} l m n o p q';
    const after = 'k one two three}} l m n o p Q';
    const result = place(base, [op('', after, 'Flattened.')]);
    expect(result.changes).toEqual([{ id: 0, start: 0, end: base.length, replace: after, why: '' }]);
    expect(result.wholeWhy).toBe('Flattened.');
  });

  test('a diff that gives up falls back to one whole change', () => {
    const base = Array.from({ length: 900 }, (_, i) => `w${i}`).join(' ');
    const after = Array.from({ length: 900 }, (_, i) => `v${i}`).join(' ');
    const result = place(base, [op('', after)]);
    expect(result.changes).toEqual([{ id: 0, start: 0, end: base.length, replace: after, why: '' }]);
  });

  test('a long base that keeps fewer than 40 percent of its words falls back to one whole change', () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`);
    const base = words.join(' ');
    const keep50 = words.map((w, i) => (i < 50 ? `v${i}` : w)).join(' ');
    const keep30 = words.map((w, i) => (i < 70 ? `v${i}` : w)).join(' ');
    const half = place(base, [op('', keep50)]).changes;
    expect(half).toHaveLength(1);
    expect(half[0]?.start).toBe(0);
    expect(half[0]?.end).toBe(base.indexOf(' w50'));
    expect(place(base, [op('', keep30)]).changes)
      .toEqual([{ id: 0, start: 0, end: base.length, replace: keep30, why: '' }]);
  });

  test('summed hunk growth over a limit falls back to one whole change', () => {
    const base = 'aaaa b c d eeee';
    const after = 'a b c d eeeeeeee';
    expect(place(base, [op('', after)], { maxGrowthChars: 4 }).changes.map((c) => c.replace)).toEqual(['a', 'eeeeeeee']);
    expect(place(base, [op('', after)], { maxGrowthChars: 3 }).changes)
      .toEqual([{ id: 0, start: 0, end: base.length, replace: after, why: '' }]);
  });

  test('a whole operation is sanitized before decomposition and its warnings kept', () => {
    const base = 'one two three four';
    const result = place(base, [op('', 'one two {{var::other}} four')], { sanitize: sanitizeUnknown });
    expect(result.changes.map((c) => c.replace)).toEqual(['other']);
    expect(result.warnings).toEqual(['Unknown list other']);
  });
});

describe('isTokenSafe', () => {
  const base = 'a {{var::x}} b {{random::c::d}} e';
  test('text outside tokens and whole tokens are safe', () => {
    expect(isTokenSafe(base, { start: 0, end: 1, replace: 'z' })).toBe(true);
    expect(isTokenSafe(base, { start: 2, end: 12, replace: '{{var::y}}' })).toBe(true);
    expect(isTokenSafe(base, { start: 2, end: 12, replace: '' })).toBe(true);
  });
  test('an edge between the two braces of a pair is unsafe', () => {
    expect(isTokenSafe(base, { start: 3, end: 5, replace: 'q' })).toBe(false);
  });
  test('a replacement that forms a pair with the text beside it is unsafe', () => {
    expect(isTokenSafe('a{b', { start: 2, end: 2, replace: '{' })).toBe(false);
    expect(isTokenSafe('a{b', { start: 2, end: 3, replace: '' })).toBe(true);
    expect(isTokenSafe('a{ {b', { start: 2, end: 3, replace: '' })).toBe(false);
  });
  test('a change that alters the closing depth or dips below the start depth is unsafe', () => {
    expect(isTokenSafe(base, { start: 2, end: 4, replace: '' })).toBe(false);
    expect(isTokenSafe(base, { start: 9, end: 14, replace: '}} {{' })).toBe(false);
  });
  test('inside a token, editing its payload is safe', () => {
    expect(isTokenSafe(base, { start: 25, end: 26, replace: 'q' })).toBe(true);
  });
});

describe('applyTemplateChanges, isTemplateChangeSet, diffWordRuns, countWords', () => {
  const base = 'one two three';
  const first: TemplateChange = { id: 0, start: 0, end: 3, replace: '1', why: '' };
  const second: TemplateChange = { id: 1, start: 8, end: 13, replace: '3', why: '' };
  const changes = [first, second];
  test('applies only accepted ids', () => {
    expect(applyTemplateChanges(base, changes, [])).toBe(base);
    expect(applyTemplateChanges(base, changes, [1])).toBe('one two 3');
    expect(applyTemplateChanges(base, changes, new Set([1, 0]))).toBe('1 two 3');
  });
  test('checks the R1.2 shape', () => {
    expect(isTemplateChangeSet(base.length, changes)).toBe(true);
    expect(isTemplateChangeSet(base.length, [])).toBe(true);
    expect(isTemplateChangeSet(12, changes)).toBe(false);
    expect(isTemplateChangeSet(13, [{ ...first, id: 1 }])).toBe(false);
    expect(isTemplateChangeSet(13, [{ ...second, id: 0 }, { ...first, id: 1 }])).toBe(false);
    expect(isTemplateChangeSet(13, [first, { ...second, start: 3 }])).toBe(false);
    expect(isTemplateChangeSet(13, [{ ...first, start: 4 }])).toBe(false);
    expect(isTemplateChangeSet(13, [{ ...first, start: 0.5 }])).toBe(false);
    expect(isTemplateChangeSet(13, [{ ...first, start: -1 }])).toBe(false);
  });
  test('diffWordRuns labels runs and gives up past maxEditLength', () => {
    expect(diffWordRuns('a b c', 'a x c', 100)).toEqual([
      { kind: 'same', text: 'a ' },
      { kind: 'del', text: 'b' },
      { kind: 'ins', text: 'x' },
      { kind: 'same', text: ' c' },
    ]);
    expect(diffWordRuns('a b c d', 'w x y z', 1)).toBeUndefined();
  });
  test('countWords counts non-whitespace runs', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('  a  b\nc\t')).toBe(3);
  });
});

// ---- properties -----------------------------------------------------------

/** An independent scanner: depth before each character, and whether it ends a pair. */
function scanDepths(text: string): { depth: number[]; mid: boolean[] } {
  const depth: number[] = [];
  const mid: boolean[] = [];
  let d = 0;
  let i = 0;
  while (i < text.length) {
    const pair = text.slice(i, i + 2);
    if (pair === '{{' || pair === '}}') {
      depth.push(d, d);
      mid.push(false, true);
      d += pair === '{{' ? 1 : -1;
      i += 2;
    } else {
      depth.push(d);
      mid.push(false);
      i += 1;
    }
  }
  return { depth, mid };
}

const pieces = [
  'word', 'alpha', 'beta', 'x', ' ', '  ', '\n', ', ', '“q”', '—', '{{var::name}}', '{{var::other}}',
  '{{var::two words}}', '{{random::a::b}}', '{{random::{{var::name}}::c}}', '{', '}', '{{', '}}', 'é', '😀',
];
const textArb = fc.array(fc.constantFrom(...pieces), { maxLength: 24 }).map((parts) => parts.join(''));
const baseArb = fc.tuple(textArb, fc.boolean()).map(([text, wrap]) => (wrap ? `{{ai-fill: ${text}}}` : text));

const scenarioArb = baseArb.chain((base) => {
  const realFind = fc.tuple(fc.nat(base.length), fc.nat(base.length))
    .map(([a, b]) => base.slice(Math.min(a, b), Math.max(a, b)));
  const findArb = fc.oneof(
    { weight: 5, arbitrary: realFind },
    { weight: 2, arbitrary: textArb },
    { weight: 1, arbitrary: fc.constant('') },
  );
  const opArb = fc.record({ why: fc.constantFrom('', 'why'), find: findArb, replace: textArb });
  const wholeEditArb = fc.array(fc.tuple(fc.nat(base.length), fc.nat(base.length), textArb), { maxLength: 4 })
    .map((edits) => edits.reduce((text, [a, b, rep]) => {
      const s = Math.min(a, b, text.length);
      const e = Math.min(Math.max(a, b), text.length);
      return text.slice(0, s) + rep + text.slice(e);
    }, base))
    .map((replace) => ({ why: 'whole', find: '', replace }));
  return fc.record({
    base: fc.constant(base),
    operations: fc.array(fc.oneof({ weight: 4, arbitrary: opArb }, { weight: 1, arbitrary: wholeEditArb }), { maxLength: 6 }),
    maxGrowthChars: fc.constantFrom(2000, 30, 4),
    maxBodyBytes: fc.constantFrom(65_536, base.length * 2 + 8),
    unknown: fc.boolean(),
  });
}).chain((scenario) => {
  const placement = placeTemplateOperations(scenario.base, scenario.operations, {
    sanitize: scenario.unknown ? sanitizeUnknown : identity,
    maxGrowthChars: scenario.maxGrowthChars,
    maxBodyBytes: scenario.maxBodyBytes,
  });
  const ids = placement.changes.map((change) => change.id);
  return fc.record({
    base: fc.constant(scenario.base),
    placement: fc.constant(placement),
    accepted: fc.shuffledSubarray(ids),
    maxGrowthChars: fc.constant(scenario.maxGrowthChars),
    maxBodyBytes: fc.constant(scenario.maxBodyBytes),
  });
});

const runs = { numRuns: 1500 };

describe('properties', () => {
  test('R1.2: placed changes always form a valid change set', () => {
    fc.assert(fc.property(scenarioArb, ({ base, placement }) => {
      expect(isTemplateChangeSet(base.length, placement.changes)).toBe(true);
    }), runs);
  });

  test('R1.3: applying a subset is the concatenation of base slices and chosen texts', () => {
    fc.assert(fc.property(scenarioArb, ({ base, placement, accepted }) => {
      const chosen = new Set(accepted);
      let expected = '';
      let cursor = 0;
      for (const change of placement.changes) {
        expected += base.slice(cursor, change.start);
        expected += chosen.has(change.id) ? change.replace : base.slice(change.start, change.end);
        cursor = change.end;
      }
      expected += base.slice(cursor);
      expect(applyTemplateChanges(base, placement.changes, accepted)).toBe(expected);
    }), runs);
  });

  test('R3.10: changes are token-safe or whole, and untouched text keeps its depth', () => {
    fc.assert(fc.property(scenarioArb, ({ base, placement, accepted }) => {
      const whole = (change: TemplateChange): boolean => change.start === 0 && change.end === base.length;
      for (const change of placement.changes) {
        expect(whole(change) || isTokenSafe(base, change)).toBe(true);
      }
      const chosen = new Set(accepted);
      if (placement.changes.some((change) => chosen.has(change.id) && whole(change))) return;
      const result = applyTemplateChanges(base, placement.changes, accepted);
      const before = scanDepths(base);
      const after = scanDepths(result);
      const active = placement.changes.filter((c) => chosen.has(c.id));
      for (let i = 0; i < base.length; i += 1) {
        if (active.some((c) => i >= c.start && i < c.end)) continue;
        // Every accepted change ending at or before `i` (an insertion at `i` included) shifts it.
        const shift = active
          .filter((c) => c.end <= i)
          .reduce((sum, c) => sum + c.replace.length - (c.end - c.start), 0);
        expect([after.depth[i + shift], after.mid[i + shift]]).toEqual([before.depth[i], before.mid[i]]);
      }
    }), runs);
  });

  test('R3.8: every subset is well-formed text within the limits, measured on the result', () => {
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    fc.assert(fc.property(scenarioArb, ({ base, placement, accepted, maxGrowthChars, maxBodyBytes }) => {
      const result = applyTemplateChanges(base, placement.changes, accepted);
      expect(result.isWellFormed()).toBe(true);
      expect(Array.from(result).length).toBeLessThanOrEqual(Array.from(base).length + maxGrowthChars);
      expect(bytes(result)).toBeLessThanOrEqual(Math.max(bytes(base), maxBodyBytes));
    }), runs);
  });

  test('R3.11: accepting none returns the base and order of accepted ids does not matter', () => {
    fc.assert(fc.property(scenarioArb, ({ base, placement, accepted }) => {
      expect(applyTemplateChanges(base, placement.changes, [])).toBe(base);
      const sorted = applyTemplateChanges(base, placement.changes, accepted.toSorted((a, b) => a - b));
      expect(applyTemplateChanges(base, placement.changes, accepted)).toBe(sorted);
      expect(applyTemplateChanges(base, placement.changes, accepted.toReversed())).toBe(sorted);
    }), runs);
  });
});

describe('surrogate pairs', () => {
  const HIGH = '\ud83d';
  const LOW = '\ude00';

  test('a find that holds half of a pair is not placed', () => {
    const base = `a 😀 b`;
    for (const find of [HIGH, LOW, `a ${HIGH}`, `${LOW} b`]) {
      const result = placeTemplateOperations(base, [{ why: '', find, replace: 'x' }], options());
      expect(result.changes).toEqual([]);
      expect(result.unplaced.map((item) => item.reason)).toEqual(['missing']);
    }
  });

  test('a split pair cannot slip past the byte limit', () => {
    const base = `😀${'x'.repeat(40)}`;
    const result = placeTemplateOperations(base, [{ why: '', find: HIGH, replace: '😀' }], options({ maxBodyBytes: 45 }));
    expect(applyTemplateChanges(base, result.changes, result.changes.map((change) => change.id))).toBe(base);
  });

  test('a lone surrogate in a replacement is made well-formed', () => {
    const result = placeTemplateOperations('a b', [{ why: '', find: 'b', replace: `c${HIGH}` }], options());
    expect(result.changes.map((change) => change.replace)).toEqual(['c\ufffd']);
  });

  test('a whole rewrite never cuts a pair', () => {
    const base = 'one 😀 two three four five six seven';
    const result = placeTemplateOperations(base, [{ why: '', find: '', replace: 'one 😁 two three four five six eight' }], options());
    for (const subset of [[], result.changes.map((change) => change.id), result.changes.slice(0, 1).map((change) => change.id)]) {
      expect(applyTemplateChanges(base, result.changes, subset).isWellFormed()).toBe(true);
    }
  });
});
