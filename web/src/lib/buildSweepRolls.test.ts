import { describe, expect, test } from 'bun:test';
import { buildSweepRolls } from './buildSweepRolls';
import { collectVarOccurrences, resolve } from './promptResolver';
import type { VarOccurrence } from './promptResolver';
import type { PromptTemplate, TagDimension, VariableList } from '@atelier/shared';

const tpl = (body: string): PromptTemplate =>
  ({ id: 't', name: 't', body, sortOrder: 0, createdAt: 0, updatedAt: 0 });

function occKey(occs: readonly VarOccurrence[], listName: string): string {
  const match = occs.find((o) => o.listName === listName);
  if (!match) throw new Error(`no occurrence for ${listName}`);
  return match.key;
}

const dims: readonly TagDimension[] = [{
  id: 'd-epoch',
  name: 'epoch',
  tags: [
    { id: 'anc', dimensionId: 'd-epoch', label: 'ancient', sortOrder: 0 },
    { id: 'fut', dimensionId: 'd-epoch', label: 'future', sortOrder: 1 },
  ],
}];

const era: VariableList = {
  id: 'list-era', name: 'era', sortOrder: 0, createdAt: 0, updatedAt: 0,
  options: [
    { id: 'era-anc', listId: 'list-era', value: 'ancient era', tagIds: ['anc'], sortOrder: 0, weight: 1 },
    { id: 'era-fut', listId: 'list-era', value: 'cyber era', tagIds: ['fut'], sortOrder: 1, weight: 1 },
    { id: 'era-manual', listId: 'list-era', value: 'manual era', tagIds: [], sortOrder: 2, weight: 0 },
  ],
};

const wardrobe: VariableList = {
  id: 'list-ward', name: 'wardrobe', sortOrder: 1, createdAt: 0, updatedAt: 0,
  options: [
    { id: 'w-chiton', listId: 'list-ward', value: 'chiton', tagIds: ['anc'], sortOrder: 0, weight: 1 },
    { id: 'w-tech', listId: 'list-ward', value: 'techwear', tagIds: ['fut'], sortOrder: 1, weight: 1 },
  ],
};

// A fully UNTAGGED list with >=3 options — the load-bearing fixture for the
// "non-swept unpinned axis stays constant" test. No tags ⇒ never conflicts ⇒
// always resolved by the random solver (NOT by a pin), so it is the variable
// the freeze approach must hold still.
const mood: VariableList = {
  id: 'list-mood', name: 'mood', sortOrder: 2, createdAt: 0, updatedAt: 0,
  options: [
    { id: 'm-calm', listId: 'list-mood', value: 'calm', tagIds: [], sortOrder: 0, weight: 1 },
    { id: 'm-tense', listId: 'list-mood', value: 'tense', tagIds: [], sortOrder: 1, weight: 1 },
    { id: 'm-eerie', listId: 'list-mood', value: 'eerie', tagIds: [], sortOrder: 2, weight: 1 },
    { id: 'm-wry', listId: 'list-mood', value: 'wry', tagIds: [], sortOrder: 3, weight: 1 },
  ],
};

const lists: readonly VariableList[] = [era, wardrobe, mood];

describe('buildSweepRolls', () => {
  test('one roll per selectable option of the swept axis, excluding manual-only options', () => {
    const template = tpl('{{var::era}} portrait');
    const occs = collectVarOccurrences(template.body);
    const sweepKey = occKey(occs, 'era'); // 'era#0'
    const result = buildSweepRolls(template, lists, dims, {}, sweepKey, 100);
    expect(result.rolls).toHaveLength(2);
    expect(result.count).toBe(2);
  });

  test('every roll uses the SAME baseSeed; all source sweep; unique ids', () => {
    const template = tpl('{{var::era}} portrait');
    const sweepKey = occKey(collectVarOccurrences(template.body), 'era');
    const { rolls } = buildSweepRolls(template, lists, dims, {}, sweepKey, 100);
    // Freeze approach: the seed is held fixed; the swept axis varies via the pin.
    expect(rolls.map((r) => r.seed)).toEqual([100, 100]);
    expect(rolls.every((r) => r.source === 'sweep')).toBe(true);
    expect(new Set(rolls.map((r) => r.id)).size).toBe(rolls.length); // unique ids
  });

  test('each roll pins the swept option, so its value appears in the text', () => {
    const template = tpl('{{var::era}} portrait');
    const sweepKey = occKey(collectVarOccurrences(template.body), 'era');
    const { rolls } = buildSweepRolls(template, lists, dims, {}, sweepKey, 0);
    const texts = rolls.map((r) => r.text).sort();
    expect(texts).toEqual(['ancient era portrait', 'cyber era portrait']);
  });

  test('admissible set respects frozen-base coherence (excludes blocked options)', () => {
    // Pin wardrobe to the ancient-tagged option; sweeping era must drop the
    // future-tagged era option (conflicts on the epoch dimension). frozenBase
    // carries this pin, so admissibility is computed against it.
    const template = tpl('{{var::era}} in {{var::wardrobe}}');
    const occs = collectVarOccurrences(template.body);
    const eraKey = occKey(occs, 'era');
    const wardKey = occKey(occs, 'wardrobe');
    const { rolls, labels } = buildSweepRolls(template, lists, dims, { [wardKey]: 'w-chiton' }, eraKey, 0);
    expect(rolls).toHaveLength(1);
    expect(labels).toEqual(['ancient era']);
    expect(rolls.map((r) => r.text)).toEqual(['ancient era in chiton']);
  });

  test('LOAD-BEARING: an unpinned, non-swept axis is byte-identical across all sweep rolls', () => {
    // mood is untagged + unpinned, so it is chosen by the random solver. Under a
    // naive baseSeed+i scheme its value would drift roll-to-roll. The freeze
    // approach pins it (via frozenBase) to its baseSeed pick, so it MUST be
    // identical in every roll. Two admissible era options ⇒ two rolls.
    const template = tpl('{{var::era}} portrait, {{var::mood}} mood');
    const sweepKey = occKey(collectVarOccurrences(template.body), 'era');
    const { rolls } = buildSweepRolls(template, lists, dims, {}, sweepKey, 42);
    expect(rolls).toHaveLength(2);
    const moodOf = (text: string): string => {
      const m = /portrait, (\w+) mood/.exec(text);
      const captured = m?.[1];
      if (captured === undefined) throw new Error(`no mood in ${text}`);
      return captured;
    };
    const moods = rolls.map((r) => moodOf(r.text));
    expect(new Set(moods).size).toBe(1); // exactly one distinct mood across all rolls
    // And the era value DID vary (the swept axis is the only thing that changes).
    expect(new Set(rolls.map((r) => r.text.split(' portrait')[0])).size).toBe(2);
  });

  test('each roll carries provenance with the swept option pinned', () => {
    const template = tpl('{{var::era}} portrait, {{var::mood}} mood');
    const occs = collectVarOccurrences(template.body);
    const sweepKey = occKey(occs, 'era');
    const moodKey = occKey(occs, 'mood');
    const { rolls } = buildSweepRolls(template, lists, dims, {}, sweepKey, 42);
    for (const roll of rolls) {
      expect(roll.provenance?.templateId).toBe('t');
      expect(roll.provenance?.rollSeed).toBe(42);
      // The swept axis is pinned to this roll's option...
      const sweptId = roll.provenance?.pins[sweepKey];
      expect(['era-anc', 'era-fut'].includes(sweptId ?? '')).toBe(true);
      // ...and the frozen non-swept axis is pinned too (so the batch reproduces).
      expect(roll.provenance?.pins[moodKey]).toBeDefined();
    }
    // The swept pin differs between the two rolls.
    const [first, second] = rolls;
    expect(first?.provenance?.pins[sweepKey]).not.toBe(second?.provenance?.pins[sweepKey]);
  });

  test('unknown sweep key yields zero rolls (no occurrence match)', () => {
    const template = tpl('{{var::era}} portrait');
    const { rolls, count } = buildSweepRolls(template, lists, dims, {}, 'does-not-exist#0', 0);
    expect(rolls).toHaveLength(0);
    expect(count).toBe(0);
  });

  test('labels carry the swept option values in admissible order', () => {
    const template = tpl('{{var::era}} portrait');
    const sweepKey = occKey(collectVarOccurrences(template.body), 'era');
    const { labels } = buildSweepRolls(template, lists, dims, {}, sweepKey, 0);
    expect(labels).toEqual(['ancient era', 'cyber era']);
  });

  // Finding A regression: sweep occurrence keys must be derived from the
  // MACRO-RESOLVED body (the shape resolve() actually pins), not the raw body.
  // When an unpicked {{random::}} branch contains a {{var::X}} token, the later
  // same-list occurrence shifts index in the resolved body. Sweeping the raw
  // key (face#1) against a resolved set that only has face#0 silently dropped
  // the per-option pin and fired N IDENTICAL rolls.
  describe('Finding A — sweep keys from macro-resolved body, not raw body', () => {
    const faceList: VariableList = {
      id: 'list-face', name: 'face', sortOrder: 0, createdAt: 0, updatedAt: 0,
      options: [
        { id: 'face-a', listId: 'list-face', value: 'FACE_A', tagIds: [], sortOrder: 0, weight: 1 },
        { id: 'face-b', listId: 'list-face', value: 'FACE_B', tagIds: [], sortOrder: 1, weight: 1 },
      ],
    };
    const faceLists: readonly VariableList[] = [faceList];
    const noDims: readonly TagDimension[] = [];
    const body = '{{random::{{var::face}}::nothing}} then {{var::face}}';
    const template = tpl(body);

    // Find a seed where the random branch resolves to the "nothing" branch
    // (so the in-branch {{var::face}} occurrence disappears from the resolved
    // body and the surviving occurrence has key face#0, not face#1).
    const seedWhereBranchDropped = (() => {
      for (let s = 1; s < 200; s += 1) {
        const r = resolve(template, faceLists, noDims, { seed: s, pins: {} });
        if (r.text.startsWith('nothing then')) return s;
      }
      throw new Error('no seed found where branch resolves to "nothing"');
    })();

    test('raw-body occurrence keys differ from resolved-body keys (precondition)', () => {
      const rawOccs = collectVarOccurrences(body);
      expect(rawOccs.map((o) => o.key)).toEqual(['face#0', 'face#1']);
      const resolved = resolve(template, faceLists, noDims, { seed: seedWhereBranchDropped, pins: {} });
      // Only the surviving (post-"then") occurrence is in picks, keyed face#0.
      expect(Object.keys(resolved.picks)).toEqual(['face#0']);
    });

    test('sweeping the surviving axis yields DISTINCT rolls, not identical', () => {
      // The user can only sweep an axis present in the resolved picks (face#0).
      const sweepKey = 'face#0';
      const { rolls, labels } = buildSweepRolls(
        template, faceLists, noDims, {}, sweepKey, seedWhereBranchDropped,
      );
      expect(rolls).toHaveLength(2);
      // The two rolls must be DISTINCT (FACE_A, FACE_B) — not identical.
      const texts = rolls.map((r) => r.text).sort();
      expect(texts).toEqual(['nothing then FACE_A', 'nothing then FACE_B']);
      expect(new Set(texts).size).toBe(2);
      expect([...labels].sort()).toEqual(['FACE_A', 'FACE_B']);
      // Each swept pin key must be present in resolve(seed).picks.
      for (const roll of rolls) {
        const sweptKeyInPins = Object.keys(roll.provenance?.pins ?? {}).includes(sweepKey);
        expect(sweptKeyInPins).toBe(true);
      }
    });

    test('sweeping the raw-only key (face#1, in unpicked branch) yields zero rolls', () => {
      // face#1 lives in the unpicked branch / does not survive to the resolved
      // body. It must not be sweepable — zero rolls rather than a silent no-op.
      const { rolls, count } = buildSweepRolls(
        template, faceLists, noDims, {}, 'face#1', seedWhereBranchDropped,
      );
      expect(rolls).toHaveLength(0);
      expect(count).toBe(0);
    });
  });
});
