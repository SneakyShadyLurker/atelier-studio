import { describe, expect, test } from 'bun:test';
import {
  resolve,
  evaluateAxis,
  collectVarOccurrences,
  applyPinsToTemplateBody,
  weightedChoice,
  weightedShuffle,
  buildResolveIndex,
  firstConflictDimension,
} from './promptResolver';
import type { VariableList, TagDimension, PromptTemplate } from '@atelier/shared';
import { TAG_COHERENCE_PARITY_FIXTURES } from '../../../shared/src/tagCoherence.fixtures';

const tpl = (body: string): PromptTemplate =>
  ({ id: 't', name: 't', body, sortOrder: 0, createdAt: 0, updatedAt: 0 });

describe('tag coherence v2 parity fixtures', () => {
  const dimensions: TagDimension[] = [{
    id: 'franchise',
    name: 'Franchise',
    tags: [
      { id: 'witcher', dimensionId: 'franchise', label: 'The Witcher', sortOrder: 0 },
      { id: 'witcher-games', dimensionId: 'franchise', label: 'The Witcher games', sortOrder: 1, parentId: 'witcher' },
      { id: 'trek', dimensionId: 'franchise', label: 'Star Trek', sortOrder: 2 },
      { id: 'dune', dimensionId: 'franchise', label: 'Dune', sortOrder: 3 },
    ],
  }];
  for (const fixture of TAG_COHERENCE_PARITY_FIXTURES) {
    test(fixture.name, () => {
      const list: VariableList = {
        id: 'pair',
        name: 'pair',
        sortOrder: 0,
        createdAt: 0,
        updatedAt: 0,
        options: [fixture.a, fixture.b].map((tags, index) => ({
          id: `option-${index}`,
          listId: 'pair',
          value: `option ${index}`,
          tagIds: tags.require,
          excludeTagIds: tags.exclude,
          sortOrder: index,
          weight: 1,
        })),
      };
      const [a, b] = list.options;
      if (!a || !b) throw new Error('expected parity options');
      const index = buildResolveIndex([], dimensions, [list]);
      expect(firstConflictDimension(a, b, index) !== null).toBe(fixture.expectedConflict);
      expect(firstConflictDimension(b, a, index) !== null).toBe(fixture.expectedConflict);
    });
  }
});

test('buildResolveIndex reuses option-independent indexes for stable library arrays', () => {
  const dimensions: TagDimension[] = [{
    id: 'dimension',
    name: 'Dimension',
    tags: [{ id: 'tag', dimensionId: 'dimension', label: 'Tag', sortOrder: 0 }],
  }];
  const lists: VariableList[] = [{
    id: 'list', name: 'list', sortOrder: 0, createdAt: 0, updatedAt: 0,
    options: [{ id: 'option', listId: 'list', value: 'value', tagIds: ['tag'], sortOrder: 0, weight: 1 }],
  }];
  const first = buildResolveIndex([{ key: 'list#0', listName: 'list', subject: null }], dimensions, lists);
  const second = buildResolveIndex([{ key: 'list#1', listName: 'list', subject: null }], dimensions, lists);

  expect(second.tagToDim).toBe(first.tagToDim);
  expect(second.optionTagsById).toBe(first.optionTagsById);
  expect(second.occByKey).not.toBe(first.occByKey);
  expect(second.subjectByKey).not.toBe(first.subjectByKey);
});

describe('grammar', () => {
  test('random picks one option, seeded deterministic', () => {
    const a = resolve(tpl('{{random::x::y::z}}'), [], [], { seed: 1, pins: {} });
    const b = resolve(tpl('{{random::x::y::z}}'), [], [], { seed: 1, pins: {} });
    expect(a.text).toBe(b.text);
    expect(['x', 'y', 'z']).toContain(a.text);
  });
  test('legacy comma form', () => {
    const r = resolve(tpl('{{random:a,b,c}}'), [], [], { seed: 2, pins: {} });
    expect(['a', 'b', 'c']).toContain(r.text);
  });
  test('pick is seeded-random, identical path to random (st_macros.py:216)', () => {
    const a = resolve(tpl('{{pick::first::second::third}}'), [], [], { seed: 9, pins: {} });
    const b = resolve(tpl('{{pick::first::second::third}}'), [], [], { seed: 9, pins: {} });
    expect(a.text).toBe(b.text);
    expect(['first', 'second', 'third']).toContain(a.text);
  });
  test('nested random resolves within {x,y,z}', () => {
    const r = resolve(tpl('{{random::{{random::x::y}}::z}}'), [], [], { seed: 3, pins: {} });
    expect(['x', 'y', 'z']).toContain(r.text);
  });
  test('roll Nd6 in range', () => {
    const n = Number(resolve(tpl('{{roll::1d6}}'), [], [], { seed: 4, pins: {} }).text);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(6);
  });
  test('comment stripped, user substituted', () => {
    expect(resolve(tpl('{{//hi}}A{{user}}'), [], [], { seed: 0, pins: {}, user: 'V' }).text).toBe('AV');
  });
  test('comment containing a single } is fully stripped (no leak)', () => {
    expect(resolve(tpl('{{// note } here}}A'), [], [], { seed: 0, pins: {} }).text).toBe('A');
  });
  test('comment containing a nested {{...}} token is fully stripped', () => {
    expect(resolve(tpl('{{// drop {{random::x::y}} this}}A'), [], [], { seed: 0, pins: {} }).text).toBe('A');
  });
  test('missing variables inside a comment neither resolve nor warn', () => {
    const r = resolve(tpl('A{{// {{var::Missing}} {{random::x::y}} }}B'), [], [], { seed: 0, pins: {} });
    expect(r.text).toBe('AB');
    expect(r.warnings).toEqual([]);
  });
  test('unclosed comment is left literal (no crash)', () => {
    expect(resolve(tpl('A{{// never closes'), [], [], { seed: 0, pins: {} }).text).toBe('A{{// never closes');
  });
  test('max 8 passes — no infinite loop', () => {
    expect(resolve(tpl('{{random::a::a}}'), [], [], { seed: 0, pins: {} }).text).toBe('a');
  });
  test('unknown {{var}} → literal passthrough + warning', () => {
    const r = resolve(tpl('{{var::nope}}'), [], [], { seed: 0, pins: {} });
    expect(r.warnings.length).toBe(1);
  });
});

describe('dice macro bounds', () => {
  const roll = (body: string, seed = 4) => resolve(tpl(body), [], [], { seed, pins: {} });

  test('ordinary rolls stay seeded and in range', () => {
    const a = roll('{{roll::3d6}}');
    const b = roll('{{roll::3d6}}');
    expect(a.text).toBe(b.text);
    expect(Number(a.text)).toBeGreaterThanOrEqual(3);
    expect(Number(a.text)).toBeLessThanOrEqual(18);
    expect(a.warnings).toEqual([]);
  });

  test('zero counts and sides still clamp to one', () => {
    const zeroCount = Number(roll('{{roll::0d6}}').text);
    expect(zeroCount).toBeGreaterThanOrEqual(1);
    expect(zeroCount).toBeLessThanOrEqual(6);
    expect(roll('{{roll::2d0}}').text).toBe('2');
  });

  test('a non-dice spec keeps its literal without a warning', () => {
    const r = roll('{{roll::abc}}');
    expect(r.text).toContain('abc');
    expect(r.text).toContain('{{roll:');
    expect(r.warnings).toEqual([]);
  });

  test('a 309-digit count is rejected with a warning instead of looping', () => {
    const r = roll(`{{roll::${'9'.repeat(309)}d6}}`);
    expect(r.text).toContain('9'.repeat(309));
    expect(r.text).not.toMatch(/Infinity|NaN/);
    expect(r.warnings.some((warning) => warning.startsWith('dice roll too large'))).toBe(true);
  });

  test('non-finite sides never emit Infinity or NaN', () => {
    const r = roll(`{{roll::2d${'9'.repeat(400)}}}`);
    expect(r.text).not.toMatch(/Infinity|NaN/);
    expect(r.warnings.some((warning) => warning.startsWith('dice roll too large'))).toBe(true);
  });

  test('a huge finite count is refused by the per-prompt dice limit', () => {
    const r = roll('{{roll::9000000000000d6}}');
    expect(r.text).toContain('9000000000000d6');
    expect(r.warnings.some((warning) => warning.startsWith('dice limit of 10000 per prompt'))).toBe(true);
  });

  test('the dice limit is shared across many macros', () => {
    const r = roll(Array.from({ length: 200 }, () => '{{roll::100d6}}').join(' '));
    const parts = r.text.split(' ');
    expect(parts.filter((part) => /^\d+$/.test(part))).toHaveLength(100);
    expect(parts.filter((part) => part.includes('100d6'))).toHaveLength(100);
    expect(r.warnings.filter((warning) => warning.startsWith('dice limit'))).toHaveLength(1);
  });

  test('the limit spans the post-pass, and resets for the next resolve', () => {
    const mood: VariableList = {
      id: 'mood', name: 'mood', sortOrder: 0, createdAt: 0, updatedAt: 0,
      options: [{ id: 'm1', listId: 'mood', value: '{{roll::1d6}}', tagIds: [], sortOrder: 0, weight: 1 }],
    };
    const spent = resolve(tpl('{{roll::10000d1}} {{var::mood}}'), [mood], [], { seed: 1, pins: {} });
    expect(spent.text.startsWith('10000 ')).toBe(true);
    expect(spent.text).toContain('1d6');
    expect(spent.warnings.some((warning) => warning.startsWith('dice limit'))).toBe(true);

    const fresh = resolve(tpl('{{var::mood}}'), [mood], [], { seed: 1, pins: {} });
    expect(fresh.text).toMatch(/^[1-6]$/);
    expect(fresh.warnings).toEqual([]);
  });
});

describe('bounded axis solver', () => {
  // List i option c requires its own dimension's colour c and excludes colour c
  // in every other list's dimension: 14 axes cannot take 13 distinct colours.
  function pigeonhole(listCount: number, colourCount: number): { lists: VariableList[]; dims: TagDimension[]; body: string } {
    const dims: TagDimension[] = Array.from({ length: listCount }, (_, i) => ({
      id: `dim-${i}`,
      name: `dim ${i}`,
      tags: Array.from({ length: colourCount }, (_, c) => ({
        id: `tag-${i}-${c}`, dimensionId: `dim-${i}`, label: `colour ${c}`, sortOrder: c,
      })),
    }));
    const lists: VariableList[] = Array.from({ length: listCount }, (_, i) => ({
      id: `list-${i}`,
      name: `list${i}`,
      sortOrder: i,
      createdAt: 0,
      updatedAt: 0,
      options: Array.from({ length: colourCount }, (_, c) => ({
        id: `opt-${i}-${c}`,
        listId: `list-${i}`,
        value: `l${i}c${c}`,
        tagIds: [`tag-${i}-${c}`],
        excludeTagIds: Array.from({ length: listCount }, (_, j) => j)
          .filter((j) => j !== i)
          .map((j) => `tag-${j}-${c}`),
        sortOrder: c,
        weight: 1,
      })),
    }));
    const body = lists.map((list) => `{{var::${list.name}}}`).join(' ');
    return { lists, dims, body };
  }

  test('a pigeonhole library completes with a budget warning, not an unsatisfiable claim', () => {
    const { lists, dims, body } = pigeonhole(14, 13);
    const first = resolve(tpl(body), lists, dims, { seed: 7, pins: {} });
    const second = resolve(tpl(body), lists, dims, { seed: 7, pins: {} });

    expect(first.warnings).toContain('constraint search limit reached - picks may conflict; pin an axis or relax tags');
    expect(first.warnings).not.toContain('no coherent combination - relax tags or unpin an axis');
    expect(Object.keys(first.picks)).toHaveLength(14);
    expect(second.text).toBe(first.text);
  });

  test('a small unsatisfiable library still reports no coherent combination', () => {
    const { lists, dims, body } = pigeonhole(3, 2);
    const r = resolve(tpl(body), lists, dims, { seed: 7, pins: {} });
    expect(r.warnings).toContain('no coherent combination - relax tags or unpin an axis');
  });

  test('a satisfiable constrained library resolves coherently and deterministically', () => {
    const { lists, dims, body } = pigeonhole(4, 5);
    const first = resolve(tpl(body), lists, dims, { seed: 11, pins: {} });
    const second = resolve(tpl(body), lists, dims, { seed: 11, pins: {} });

    expect(first.warnings).toEqual([]);
    expect(second).toEqual(first);
    const colours = Object.values(first.picks).map((optionId) => optionId.split('-')[2]);
    expect(new Set(colours).size).toBe(4);
  });

  test('pins are kept and a manual-only option is still honoured when pinned', () => {
    const { lists, dims, body } = pigeonhole(4, 5);
    const manual = lists.map((list, i) => (i === 0
      ? { ...list, options: list.options.map((option) => (option.id === 'opt-0-4' ? { ...option, weight: 0 } : option)) }
      : list));
    const r = resolve(tpl(body), manual, dims, { seed: 11, pins: { list0: 'opt-0-4' } });

    expect(r.picks['list0#0']).toBe('opt-0-4');
    expect(r.warnings).toEqual([]);
    const colours = Object.values(r.picks).map((optionId) => optionId.split('-')[2]);
    expect(new Set(colours).size).toBe(4);
  });

  test('a large repeated-axis body bounds its fallback and still fills every slot', () => {
    // 1000 slots over a 500-option tagless list: the depth limit skips the
    // search, so nothing backtracks, and the greedy fallback used to charge
    // every slot against every earlier pick.
    const wide: VariableList = {
      id: 'wide', name: 'wide', sortOrder: 0, createdAt: 0, updatedAt: 0,
      options: Array.from({ length: 500 }, (_, i) => ({
        id: `w${i}`, listId: 'wide', value: `v${i}`, tagIds: [], sortOrder: i, weight: i === 0 ? 0 : 1,
      })),
    };
    const body = Array.from({ length: 1000 }, () => '{{var::wide}}').join(' ');
    const started = performance.now();
    const first = resolve(tpl(body), [wide], [], { seed: 3, pins: { 'wide#0': 'w0' } });
    const elapsed = performance.now() - started;
    const second = resolve(tpl(body), [wide], [], { seed: 3, pins: { 'wide#0': 'w0' } });

    expect(elapsed).toBeLessThan(2_000);
    expect(first.text).not.toContain('{{var::');
    expect(Object.keys(first.picks)).toHaveLength(1000);
    expect(first.picks['wide#0']).toBe('w0');
    // Unpinned slots keep manual-only options out on both sides of the limit.
    expect(Object.entries(first.picks).filter(([key, id]) => key !== 'wide#0' && id === 'w0')).toEqual([]);
    expect(first.warnings).toContain('constraint search limit reached - picks may conflict; pin an axis or relax tags');
    expect(first.warnings.filter((w) => w.startsWith('coherence check limit reached'))).toHaveLength(1);
    expect(first.warnings).not.toContain('no coherent combination - relax tags or unpin an axis');
    expect(second.text).toBe(first.text);
  });
});

describe('bounded pinned-conflict check', () => {
  const dims: TagDimension[] = [{
    id: 'd',
    name: 'epoch',
    tags: [
      { id: 'anc', dimensionId: 'd', label: 'ancient', sortOrder: 0 },
      { id: 'fut', dimensionId: 'd', label: 'future', sortOrder: 1 },
    ],
  }];
  const era: VariableList = {
    id: 'e', name: 'era', sortOrder: 0, createdAt: 0, updatedAt: 0,
    options: [
      { id: 'e1', listId: 'e', value: 'a', tagIds: ['anc'], sortOrder: 0, weight: 1 },
      { id: 'e2', listId: 'e', value: 'b', tagIds: ['fut'], sortOrder: 1, weight: 1 },
    ],
  };
  const ward: VariableList = {
    id: 'w', name: 'wardrobe', sortOrder: 1, createdAt: 0, updatedAt: 0,
    options: [
      { id: 'w1', listId: 'w', value: 'chiton', tagIds: ['anc'], sortOrder: 0, weight: 1 },
      { id: 'w2', listId: 'w', value: 'techwear', tagIds: ['fut'], sortOrder: 1, weight: 1 },
    ],
  };

  test('6000 repeated axes pinned to one tagged option resolve quickly with every pick kept', () => {
    const body = '{{var::era}}'.repeat(6000);
    const started = performance.now();
    const r = resolve(tpl(body), [era], dims, { seed: 5, pins: { era: 'e1' } });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(r.text).toBe('a'.repeat(6000));
    const picks = Object.values(r.picks);
    expect(picks).toHaveLength(6000);
    expect(picks.every((id) => id === 'e1')).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  test('a small conflict still names every conflicting pinned pair', () => {
    const r = resolve(tpl('{{var::era}} {{var::era}} {{var::wardrobe}}'), [era, ward], dims, {
      seed: 1,
      pins: { era: 'e1', wardrobe: 'w2' },
    });
    expect(r.text).toBe('a a techwear');
    expect(r.warnings).toEqual([
      'pinned options conflict: era · 1 / 2 and wardrobe on dimension d',
      'pinned options conflict: era · 2 / 2 and wardrobe on dimension d',
    ]);
  });

  test('a huge conflicting pinned body lists a bounded set of pairs and counts the rest', () => {
    const body = `${'{{var::era}}'.repeat(3000)}${'{{var::wardrobe}}'.repeat(3000)}`;
    const started = performance.now();
    const r = resolve(tpl(body), [era, ward], dims, { seed: 1, pins: { era: 'e1', wardrobe: 'w2' } });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(Object.keys(r.picks)).toHaveLength(6000);
    expect(r.text).toBe(`${'a'.repeat(3000)}${'techwear'.repeat(3000)}`);
    const named = r.warnings.filter((w) => w.startsWith('pinned options conflict: era'));
    expect(named).toHaveLength(20);
    expect(named[0]).toBe('pinned options conflict: era · 1 / 3000 and wardrobe · 1 / 3000 on dimension d');
    expect(r.warnings).toContain(`pinned options conflict: ${3000 * 3000 - 20} more conflicting pinned pairs not listed`);
    expect(r.warnings.length).toBe(21);
  });

  test('past its budget the check reports itself incomplete and keeps every pin', () => {
    // 700 distinct pinned options make 244650 group pairs, over the budget.
    const wide: VariableList = {
      id: 'wide', name: 'wide', sortOrder: 0, createdAt: 0, updatedAt: 0,
      options: Array.from({ length: 700 }, (_, i) => ({
        id: `w${i}`, listId: 'wide', value: `v${i}`, tagIds: [], sortOrder: i, weight: i === 0 ? 0 : 1,
      })),
    };
    const pins = Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`wide#${i}`, `w${i}`] as const));
    const started = performance.now();
    const r = resolve(tpl('{{var::wide}} '.repeat(700)), [wide], [], { seed: 2, pins });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(r.picks['wide#0']).toBe('w0');
    expect(Object.entries(r.picks).every(([key, id]) => id === `w${key.split('#')[1] ?? ''}`)).toBe(true);
    expect(r.warnings).toEqual([
      'pinned conflict check limit reached - some pinned picks may conflict; unpin an axis or relax tags',
    ]);
  });
});

describe('weighted helper boundaries', () => {
  test('weightedChoice returns undefined on empty input', () => {
    const rng = () => 0.5;
    const items: readonly { weight: number }[] = [];
    const result = weightedChoice(items, rng);
    expect(result).toBeUndefined();
  });

  test('weightedChoice returns the only item on length-1 input', () => {
    const rng = () => 0.5;
    const item = { id: 'x', weight: 1 };
    expect(weightedChoice([item], rng)).toBe(item);
  });

  test('weightedShuffle returns same length as input', () => {
    const rng = () => 0.5;
    const items = [{ id: 'a', weight: 1 }, { id: 'b', weight: 2 }, { id: 'c', weight: 3 }];
    expect(weightedShuffle(items, rng)).toHaveLength(3);
  });

  test('weightedShuffle returns the input verbatim on length-1', () => {
    const rng = () => 0.5;
    const item = { id: 'x', weight: 1 };
    expect(weightedShuffle([item], rng)).toEqual([item]);
  });
});

describe('constraints', () => {
  const dims: TagDimension[] = [{
    id: 'd',
    name: 'epoch',
    tags: [
      { id: 'anc', dimensionId: 'd', label: 'ancient', sortOrder: 0 },
      { id: 'fut', dimensionId: 'd', label: 'future', sortOrder: 1 },
    ],
  }];
  const era: VariableList = {
    id: 'e',
    name: 'era',
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    options: [
      { id: 'e1', listId: 'e', value: 'ancient era', tagIds: ['anc'], sortOrder: 0, weight: 1 },
      { id: 'e2', listId: 'e', value: 'cyber era', tagIds: ['fut'], sortOrder: 1, weight: 1 },
    ],
  };
  const ward: VariableList = {
    id: 'w',
    name: 'wardrobe',
    sortOrder: 1,
    createdAt: 0,
    updatedAt: 0,
    options: [
      { id: 'w1', listId: 'w', value: 'chiton', tagIds: ['anc'], sortOrder: 0, weight: 1 },
      { id: 'w2', listId: 'w', value: 'techwear', tagIds: ['fut'], sortOrder: 1, weight: 1 },
      { id: 'w3', listId: 'w', value: 'plain', tagIds: [], sortOrder: 2, weight: 1 },
    ],
  };
  test('pinned era=ancient → wardrobe never resolves to techwear', () => {
    for (let s = 0; s < 50; s++) {
      const r = resolve(tpl('{{var::era}} / {{var::wardrobe}}'), [era, ward], dims, {
        seed: s,
        pins: { era: 'e1' },
      });
      expect(r.text.includes('techwear')).toBe(false);
      expect(r.warnings).toHaveLength(0);
    }
  });
  test('evaluateAxis: pin era=ancient disables techwear, keeps plain (untagged)', () => {
    const occ = { key: 'wardrobe#0', listName: 'wardrobe', subject: null };
    const occurrences = [{ key: 'era#0', listName: 'era', subject: null }, occ];
    const ids = evaluateAxis(occ, occurrences, { era: 'e1' }, [era, ward], dims)
      .filter((evaluation) => evaluation.admissible)
      .map((evaluation) => evaluation.option.id);
    expect(ids).toContain('w1');
    expect(ids).toContain('w3');
    expect(ids).not.toContain('w2');
  });
  test('over-constrained surfaces a warning, no throw', () => {
    const only: VariableList = {
      id: 'o',
      name: 'only',
      sortOrder: 2,
      createdAt: 0,
      updatedAt: 0,
      options: [{ id: 'o1', listId: 'o', value: 'futureonly', tagIds: ['fut'], sortOrder: 0, weight: 1 }],
    };
    const r = resolve(tpl('{{var::era}} {{var::only}}'), [era, only], dims, {
      seed: 0,
      pins: { era: 'e1' },
    });
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  test('unknown pinned optionId is dropped + warned, not thrown', () => {
    const r = resolve(tpl('{{var::era}}'), [era], dims, { seed: 1, pins: { era: 'GONE' } });
    expect(['ancient era', 'cyber era']).toContain(r.text);
    expect(r.warnings.some((w) => w.includes('era'))).toBe(true);
  });
  test('conflicting explicit pins surface a warning, no throw', () => {
    const r = resolve(tpl('{{var::era}} / {{var::wardrobe}}'), [era, ward], dims, {
      seed: 1,
      pins: { era: 'e1', wardrobe: 'w2' },
    });
    expect(r.text).toBe('ancient era / techwear');
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('evaluateAxis (reason contract — single source for picker gating)', () => {
  const dims: TagDimension[] = [{
    id: 'd',
    name: 'epoch',
    tags: [
      { id: 'anc', dimensionId: 'd', label: 'ancient', sortOrder: 0 },
      { id: 'fut', dimensionId: 'd', label: 'future', sortOrder: 1 },
    ],
  }];
  const era: VariableList = {
    id: 'e',
    name: 'era',
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    options: [{ id: 'e1', listId: 'e', value: 'ancient era', tagIds: ['anc'], sortOrder: 0, weight: 1 }],
  };
  const ward: VariableList = {
    id: 'w',
    name: 'wardrobe',
    sortOrder: 1,
    createdAt: 0,
    updatedAt: 0,
    options: [
      { id: 'w1', listId: 'w', value: 'chiton', tagIds: ['anc'], sortOrder: 0, weight: 1 },
      { id: 'w2', listId: 'w', value: 'techwear', tagIds: ['fut'], sortOrder: 1, weight: 1 },
    ],
  };
  test('per-option admissibility + blocking pin + dimension', () => {
    const occ = { key: 'wardrobe#0', listName: 'wardrobe', subject: null };
    const occurrences = [{ key: 'era#0', listName: 'era', subject: null }, occ];
    const rows = evaluateAxis(occ, occurrences, { era: 'e1' }, [era, ward], dims);
    const w2 = rows.find((r) => r.option.id === 'w2');
    expect(w2?.admissible).toBe(false);
    expect(w2?.blockedBy).toEqual({
      occurrenceKey: 'era', listName: 'era', optionId: 'e1', dimensionId: 'd', label: 'era',
    });
    expect(rows.find((r) => r.option.id === 'w1')?.admissible).toBe(true);
  });
});

describe('real Obsidian-shaped template resolves end to end', () => {
  const dims: TagDimension[] = [{
    id: 'd',
    name: 'epoch',
    tags: [{ id: 'anc', dimensionId: 'd', label: 'ancient', sortOrder: 0 }],
  }];
  const era: VariableList = {
    id: 'e',
    name: 'era',
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    options: [{ id: 'e1', listId: 'e', value: 'an ancient setting', tagIds: ['anc'], sortOrder: 0, weight: 1 }],
  };
  const eth: VariableList = {
    id: 'x',
    name: 'ethnicity',
    sortOrder: 1,
    createdAt: 0,
    updatedAt: 0,
    options: [{ id: 'x1', listId: 'x', value: 'Levantine', tagIds: [], sortOrder: 0, weight: 1 }],
  };
  test('all tokens resolve, no leftover braces, deterministic, no warnings', () => {
    const body = 'Scene: a colonnade in {{var::era}}. Subject: {{var::ethnicity}} features. '
      + 'Wardrobe: {{random::a draped chiton::a woven himation}}. '
      + 'Constraints: no watermark, no text, photorealistic.';
    const r = resolve(tpl(body), [era, eth], dims, { seed: 7, pins: {} });
    expect(r.text).not.toMatch(/\{\{|\}\}/);
    expect(r.text).toContain('an ancient setting');
    expect(r.text).toContain('Levantine');
    expect(r.warnings).toHaveLength(0);
    expect(resolve(tpl(body), [era, eth], dims, { seed: 7, pins: {} }).text).toBe(r.text);
  });
});

describe('per-occurrence', () => {
  const dims: TagDimension[] = [{
    id: 'd',
    name: 'epoch',
    tags: [
      { id: 'anc', dimensionId: 'd', label: 'ancient', sortOrder: 0 },
      { id: 'fut', dimensionId: 'd', label: 'future', sortOrder: 1 },
    ],
  }];
  const era: VariableList = {
    id: 'e', name: 'era', sortOrder: 0, createdAt: 0, updatedAt: 0,
    options: [
      { id: 'e1', listId: 'e', value: 'ancient era', tagIds: ['anc'], sortOrder: 0, weight: 1 },
      { id: 'e2', listId: 'e', value: 'cyber era', tagIds: ['fut'], sortOrder: 1, weight: 1 },
    ],
  };
  const ward: VariableList = {
    id: 'w', name: 'wardrobe', sortOrder: 1, createdAt: 0, updatedAt: 0,
    options: [
      { id: 'w1', listId: 'w', value: 'chiton', tagIds: ['anc'], sortOrder: 0, weight: 1 },
      { id: 'w2', listId: 'w', value: 'techwear', tagIds: ['fut'], sortOrder: 1, weight: 1 },
    ],
  };
  const colors: VariableList = {
    id: 'c', name: 'C', sortOrder: 0, createdAt: 0, updatedAt: 0,
    options: [
      { id: 'c1', listId: 'c', value: 'red', tagIds: [], sortOrder: 0, weight: 1 },
      { id: 'c2', listId: 'c', value: 'green', tagIds: [], sortOrder: 1, weight: 1 },
      { id: 'c3', listId: 'c', value: 'blue', tagIds: [], sortOrder: 2, weight: 1 },
    ],
  };

  test('collectVarOccurrences uses findClose grammar; per-name index', () => {
    expect(collectVarOccurrences('{{var::a{{var::b}}}}')).toEqual([
      { key: 'a{{var::b}}#0', listName: 'a{{var::b}}', subject: null },
    ]);
    expect(collectVarOccurrences('{{var::X}}{{var::X}}{{var::Y}}')).toEqual([
      { key: 'X#0', listName: 'X', subject: null },
      { key: 'X#1', listName: 'X', subject: null },
      { key: 'Y#0', listName: 'Y', subject: null },
    ]);
  });

  test('same untagged list ×3 rolls independently, deterministic per seed', () => {
    const body = '{{var::C}}|{{var::C}}|{{var::C}}';
    let sawDifferent = false;
    for (let s = 0; s < 30; s++) {
      const r = resolve(tpl(body), [colors], [], { seed: s, pins: {} });
      const parts = r.text.split('|');
      expect(parts).toHaveLength(3);
      for (const p of parts) expect(['red', 'green', 'blue']).toContain(p);
      if (new Set(parts).size > 1) sawDifferent = true;
      expect(resolve(tpl(body), [colors], [], { seed: s, pins: {} }).text).toBe(r.text);
    }
    expect(sawDifferent).toBe(true);
  });

  test('pinning one occurrence locks only that occurrence', () => {
    const body = '{{var::C}}|{{var::C}}|{{var::C}}';
    const pins = { 'C#1': 'c2' };
    const siblings = new Set<string>();
    for (let s = 0; s < 20; s++) {
      const r = resolve(tpl(body), [colors], [], { seed: s, pins });
      const parts = r.text.split('|');
      expect(parts[1]).toBe('green');
      siblings.add(`${parts[0]}/${parts[2]}`);
    }
    expect(siblings.size).toBeGreaterThan(1);
  });

  test('bare-name pin locks every occurrence of that list (legacy consistency)', () => {
    const r = resolve(tpl('{{var::C}}|{{var::C}}|{{var::C}}'), [colors], [], { seed: 5, pins: { C: 'c3' } });
    expect(r.text).toBe('blue|blue|blue');
  });

  test('adjacent occurrences map 1:1 in scan order', () => {
    const r = resolve(tpl('{{var::C}}{{var::C}}'), [colors], [], { seed: 3, pins: { 'C#0': 'c1', 'C#1': 'c2' } });
    expect(r.text).toBe('redgreen');
  });

  test('dimension-tagged self-repetition stays coherent (documented caveat)', () => {
    for (let s = 0; s < 20; s++) {
      const r = resolve(tpl('{{var::era}}|{{var::era}}'), [era], dims, { seed: s, pins: {} });
      const [a, b] = r.text.split('|');
      expect(a).toBe(b);
      expect(r.warnings).toHaveLength(0);
    }
  });

  test('sibling occurrence-key pin blocks another sibling, label disambiguated', () => {
    const occ1 = { key: 'wardrobe#1', listName: 'wardrobe', subject: null };
    const occurrences = [{ key: 'wardrobe#0', listName: 'wardrobe', subject: null }, occ1];
    const rows = evaluateAxis(occ1, occurrences, { 'wardrobe#0': 'w2' }, [ward], dims);
    const w1 = rows.find((r) => r.option.id === 'w1');
    expect(w1?.admissible).toBe(false);
    expect(w1?.blockedBy?.occurrenceKey).toBe('wardrobe#0');
    expect(w1?.blockedBy?.label).toBe('wardrobe · 1 / 2');
  });

  test('list name colliding with an occurrence key does not cross-contaminate pins; warns', () => {
    const c: VariableList = {
      id: 'c', name: 'C', sortOrder: 0, createdAt: 0, updatedAt: 0,
      options: [
        { id: 'c1', listId: 'c', value: 'red', tagIds: [], sortOrder: 0, weight: 1 },
        { id: 'c2', listId: 'c', value: 'green', tagIds: [], sortOrder: 1, weight: 1 },
      ],
    };
    const collide: VariableList = {
      id: 'k', name: 'C#0', sortOrder: 1, createdAt: 0, updatedAt: 0,
      options: [{ id: 'k1', listId: 'k', value: 'KAY', tagIds: [], sortOrder: 0, weight: 1 }],
    };
    // A bare-name pin for the collidably-named list "C#0" must apply ONLY to
    // that list, never be read as C's occurrence-#0 pin (key "C#0").
    const r = resolve(tpl('{{var::C}} {{var::C#0}}'), [c, collide], [], { seed: 1, pins: { 'C#0': 'k1' } });
    expect(r.text).toMatch(/^(red|green) KAY$/);
    expect(r.warnings.some((w) => w.includes('collides with a variable list name'))).toBe(true);
  });
});

describe('Object.prototype-named lists', () => {
  const reserved = ['__proto__', 'constructor', 'toString'] as const;
  const lists: VariableList[] = reserved.map((name, i) => ({
    id: `r${i}`, name, sortOrder: i, createdAt: 0, updatedAt: 0,
    options: [
      { id: `${name}-a`, listId: `r${i}`, value: `${name} A`, tagIds: [], sortOrder: 0, weight: 1 },
      { id: `${name}-b`, listId: `r${i}`, value: `${name} B`, tagIds: [], sortOrder: 1, weight: 0 },
    ],
  }));
  const body = reserved.map((name) => `{{var::${name}}}`).join('|');

  test('unpinned reserved names resolve without reading inherited members as pins', () => {
    const r = resolve(tpl(body), lists, [], { seed: 2, pins: {} });
    expect(r.text).toBe('__proto__ A|constructor A|toString A');
    expect(r.warnings).toEqual([]);
    expect(applyPinsToTemplateBody(body, lists, { seed: 2, pins: { 'other#0': 'x' } })).toBe(body);
  });

  test('bare-name and occurrence pins on reserved names are honoured', () => {
    const pins = Object.fromEntries([
      ['__proto__', '__proto__-b'],
      ['constructor#0', 'constructor-b'],
      ['toString', 'toString-b'],
    ]);
    expect(Object.getPrototypeOf(pins)).toBe(Object.prototype);
    const r = resolve(tpl(body), lists, [], { seed: 2, pins });
    expect(r.text).toBe('__proto__ B|constructor B|toString B');
    expect(r.warnings).toEqual([]);
    expect(applyPinsToTemplateBody(body, lists, { seed: 2, pins })).toBe('__proto__ B|constructor B|toString B');
  });

  test('evaluateAxis on a reserved name ignores inherited members', () => {
    const occurrences = collectVarOccurrences(body);
    const proto = occurrences[0];
    if (!proto) throw new Error('expected an occurrence');
    const rows = evaluateAxis(proto, occurrences, {}, lists, []);
    expect(rows.map((row) => row.admissible)).toEqual([true, true]);
  });
});

describe('lazy macro evaluation (random before var)', () => {
  const tagDimensions: TagDimension[] = [
    {
      id: 'dim-weather',
      name: 'Weather scope',
      tags: [
        { id: 'tag-outdoor', dimensionId: 'dim-weather', label: 'outdoor-exposed', sortOrder: 0 },
        { id: 'tag-indoor', dimensionId: 'dim-weather', label: 'indoor-sheltered', sortOrder: 1 },
      ],
    },
  ];

  const lists: VariableList[] = [
    {
      id: 'list-interior',
      name: 'interior_location',
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
      options: [
        { id: 'opt-bedroom', listId: 'list-interior', value: 'her bedroom', weight: 1, tagIds: ['tag-indoor'], sortOrder: 0 },
      ],
    },
    {
      id: 'list-exterior',
      name: 'exterior_location',
      sortOrder: 1,
      createdAt: 0,
      updatedAt: 0,
      options: [
        { id: 'opt-rooftop', listId: 'list-exterior', value: 'urban rooftop', weight: 1, tagIds: ['tag-outdoor'], sortOrder: 0 },
      ],
    },
    {
      id: 'list-weather',
      name: 'weather_anchor',
      sortOrder: 2,
      createdAt: 0,
      updatedAt: 0,
      options: [
        { id: 'opt-rain', listId: 'list-weather', value: 'after light rain', weight: 1, tagIds: ['tag-outdoor'], sortOrder: 0 },
      ],
    },
  ];

  test('does not collect {{var::X}} from un-picked random branches', () => {
    const template = tpl(
      'Setting: {{random::{{var::interior_location}}::{{var::exterior_location}}, {{var::weather_anchor}}}}.',
    );
    // Seed 7 picks the FIRST branch (interior) deterministically.
    // With lazy semantics, the SAT solver should never see exterior_location or
    // weather_anchor, so the indoor/outdoor pairwise conflict cannot trip.
    const result = resolve(template, lists, tagDimensions, { seed: 7, pins: {}, user: 'u' });
    expect(result.warnings).toEqual([]);
    expect(result.text).toBe('Setting: her bedroom.');
    expect(result.picks).toEqual({ 'interior_location#0': 'opt-bedroom' });
  });

  test('does not error on full-disjoint branches when only one is picked', () => {
    // Same setup as above with a seed that picks branch 2 (exterior + weather).
    // Both must satisfy outdoor-exposed; that works because they share the tag.
    const template = tpl(
      'Setting: {{random::{{var::interior_location}}::{{var::exterior_location}}, {{var::weather_anchor}}}}.',
    );
    // Find a seed where branch 2 is picked. Probe seeds 1..32 if needed.
    let pickedBranch2 = false;
    for (let s = 1; s < 64 && !pickedBranch2; s++) {
      const r = resolve(template, lists, tagDimensions, { seed: s, pins: {}, user: 'u' });
      if (r.text === 'Setting: urban rooftop, after light rain.') pickedBranch2 = true;
    }
    expect(pickedBranch2).toBe(true);
  });

  test('applies pins to live occurrences, ignores pins for un-picked branches', () => {
    const template = tpl(
      '{{random::{{var::interior_location}}::{{var::exterior_location}}}}',
    );
    // Seed 7 picks branch 1 (interior). Pin exterior_location to opt-rooftop —
    // that pin is silently ignored (no warning), because exterior is not live.
    const result = resolve(template, lists, tagDimensions,
      { seed: 7, pins: { exterior_location: 'opt-rooftop' }, user: 'u' });
    // Outcome assertion: no "pinned option no longer exists" warning and
    // text resolves to one of the two branches (no error).
    expect(result.warnings.filter((w) => w.includes('pinned'))).toEqual([]);
  });
});

describe('applyPinsToTemplateBody (partial resolution for Use prompt)', () => {
  const hair: VariableList = {
    id: 'h', name: 'hair', sortOrder: 0, createdAt: 0, updatedAt: 0,
    options: [
      { id: 'h1', listId: 'h', value: 'red', tagIds: [], sortOrder: 0, weight: 1 },
      { id: 'h2', listId: 'h', value: 'blonde', tagIds: [], sortOrder: 1, weight: 1 },
    ],
  };
  const setting: VariableList = {
    id: 's', name: 'setting', sortOrder: 1, createdAt: 0, updatedAt: 0,
    options: [
      { id: 's1', listId: 's', value: 'a forest', tagIds: [], sortOrder: 0, weight: 1 },
    ],
  };
  const lists = [hair, setting];

  const opts = (pins: Record<string, string>, seed = 7) => ({ seed, pins });

  test('pinned var becomes literal, unpinned var stays a token', () => {
    const body = 'A {{var::hair}} woman in {{var::setting}}';
    const out = applyPinsToTemplateBody(body, lists, opts({ 'hair#0': 'h1' }));
    expect(out).toBe('A red woman in {{var::setting}}');
  });

  test('no pins leaves the body untouched', () => {
    const body = 'A {{var::hair}} woman in {{var::setting}}';
    expect(applyPinsToTemplateBody(body, lists, opts({}))).toBe(body);
  });

  test('bare list-name pin substitutes every occurrence of that list', () => {
    const body = '{{var::hair}} and {{var::hair}}';
    expect(applyPinsToTemplateBody(body, lists, opts({ hair: 'h2' }))).toBe('blonde and blonde');
  });

  test('positional pin substitutes only the matching occurrence', () => {
    const body = '{{var::hair}} then {{var::hair}}';
    expect(applyPinsToTemplateBody(body, lists, opts({ 'hair#1': 'h1' })))
      .toBe('{{var::hair}} then red');
  });

  test('non-var grammar (random, ai-fill) is left untouched', () => {
    const body = '{{random::x::y}} {{var::hair}} {{ai-fill: a thing}}';
    expect(applyPinsToTemplateBody(body, lists, opts({ 'hair#0': 'h1' })))
      .toBe('{{random::x::y}} red {{ai-fill: a thing}}');
  });

  test('pin to a missing option leaves the token literal', () => {
    const body = 'A {{var::hair}} woman';
    expect(applyPinsToTemplateBody(body, lists, opts({ 'hair#0': 'nope' })))
      .toBe('A {{var::hair}} woman');
  });

  test('subject-scoped pin (@N) targets only its subject occurrence', () => {
    const body = '{{var::hair@1}} and {{var::hair@2}}';
    expect(applyPinsToTemplateBody(body, lists, opts({ 'hair@1#0': 'h1' })))
      .toBe('red and {{var::hair@2}}');
  });

  // The regression: pins used to be substituted into the MACRO-RESOLVED body, so
  // any pin froze every {{random::}} / {{roll::}} in the template to that roll's
  // pick instead of leaving it live for the composer's next Generate.
  test('{{random::}} stays live next to a pinned var', () => {
    const body = 'A {{var::hair}} woman on a {{random::rooftop::beach}}';
    expect(applyPinsToTemplateBody(body, lists, opts({ 'hair#0': 'h1' })))
      .toBe('A red woman on a {{random::rooftop::beach}}');
  });

  test('{{roll::}} and {{user}} stay live next to a pinned var', () => {
    const body = '{{var::hair}} {{roll::2d6}} {{user}}';
    expect(applyPinsToTemplateBody(body, lists, opts({ 'hair#0': 'h2' })))
      .toBe('blonde {{roll::2d6}} {{user}}');
  });

  test('occurrence keys skip un-picked {{random::}} branches, so later pins still land', () => {
    // Seed 7 picks the FIRST branch, so the branch-2 hair token is not live and
    // the trailing token is hair#1 in the resolved shape (it would be hair#2 if
    // keys were counted naively over the raw body).
    const body = '{{random::{{var::hair}}::{{var::hair}}}} then {{var::hair}}';
    const result = resolve(tpl(body), lists, [], { seed: 7, pins: {} });
    expect(collectVarOccurrences(result.resolvedBody).map((o) => o.key)).toEqual(['hair#0', 'hair#1']);
    expect(applyPinsToTemplateBody(body, lists, opts({ 'hair#1': 'h1' })))
      .toBe('{{random::{{var::hair}}::{{var::hair}}}} then red');
  });

  test('a pin inside the picked branch keeps the surrounding macro live', () => {
    const body = '{{random::{{var::hair}}::{{var::setting}}}}';
    const result = resolve(tpl(body), lists, [], { seed: 7, pins: {} });
    expect(collectVarOccurrences(result.resolvedBody).map((o) => o.key)).toEqual(['hair#0']);
    expect(applyPinsToTemplateBody(body, lists, opts({ 'hair#0': 'h2' })))
      .toBe('{{random::blonde::{{var::setting}}}}');
  });
});
