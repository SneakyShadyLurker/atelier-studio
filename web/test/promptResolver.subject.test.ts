import { describe, expect, test } from 'bun:test';
import type { PromptTemplate, TagDimension, VariableList } from '@atelier/shared';
import { collectVarOccurrences, resolve } from '../src/lib/promptResolver';

// One dimension "era" with two disjoint tags. Two options in `look`, each
// fully tagged on era with disjoint tags → they CONFLICT pairwise.
const dims: TagDimension[] = [
  {
    id: 'era', name: 'Era', tags: [
      { id: 'modern', dimensionId: 'era', label: 'modern', sortOrder: 0 },
      { id: 'retro', dimensionId: 'era', label: 'retro', sortOrder: 1 },
    ],
  },
];
const lists: VariableList[] = [
  {
    id: 'look', name: 'look', sortOrder: 0, createdAt: 0, updatedAt: 0,
    options: [
      { id: 'm', listId: 'look', value: 'MODERN', tagIds: ['modern'], sortOrder: 0, weight: 1 },
      { id: 'r', listId: 'look', value: 'RETRO', tagIds: ['retro'], sortOrder: 1, weight: 1 },
    ],
  },
];

function tpl(body: string): PromptTemplate {
  return { id: 't', name: 't', body, sortOrder: 0, createdAt: 0, updatedAt: 0 };
}

describe('collectVarOccurrences subject parsing', () => {
  test('keys carry subject group', () => {
    const occ = collectVarOccurrences('{{var::look@1}} {{var::look@2}} {{var::look}}');
    expect(occ.map((o) => [o.key, o.listName, o.subject])).toEqual([
      ['look@1#0', 'look', 1],
      ['look@2#0', 'look', 2],
      ['look#0', 'look', null],
    ]);
  });
});

describe('cross-subject coherence is DECOUPLED (the gap @N closes)', () => {
  test('subject 1 and subject 2 can take disjoint-tagged options on the same dimension', () => {
    // Body has @1 and @2 of the same conflicting list. Across many seeds the
    // resolver MUST be able to pick MODERN for @1 and RETRO for @2 (or vice
    // versa) at least once — impossible if cross-subject pairs were coherence-
    // forced (that path can only ever pick the same option for both).
    const t = tpl('{{var::look@1}} :: {{var::look@2}}');
    let sawDivergent = false;
    for (let seed = 0; seed < 64; seed++) {
      const r = resolve(t, lists, dims, { seed, pins: {} });
      const [a, b] = r.text.split(' :: ');
      expect(r.warnings).toEqual([]); // never reports "no coherent combination"
      if (a !== b) sawDivergent = true;
    }
    expect(sawDivergent).toBe(true);
  });
});

describe('intra-subject coherence still HOLDS', () => {
  test('two slots of the SAME subject group are forced coherent (always equal here)', () => {
    // @1 referenced twice — both slots are subject 1, must cohere. With only
    // two mutually-conflicting options, the only coherent assignment is the
    // same option in both slots.
    const t = tpl('{{var::look@1}} :: {{var::look@1}}');
    for (let seed = 0; seed < 64; seed++) {
      const r = resolve(t, lists, dims, { seed, pins: {} });
      const [a, b] = r.text.split(' :: ');
      expect(a).toBe(b);
      expect(r.warnings).toEqual([]);
    }
  });
});

describe('subject-vs-scene coherence still HOLDS', () => {
  test('a scene-level slot is forced coherent with each subject slot', () => {
    // look@1 and bare look (scene) must cohere → equal here. Independently,
    // look@2 must cohere with scene too → so @1, scene, @2 all collapse to one
    // value (transitively) ONLY because scene bridges them. Asserts the bridge.
    const t = tpl('{{var::look@1}} :: {{var::look}} :: {{var::look@2}}');
    for (let seed = 0; seed < 64; seed++) {
      const r = resolve(t, lists, dims, { seed, pins: {} });
      const [a, scene, b] = r.text.split(' :: ');
      expect(a).toBe(scene);
      expect(b).toBe(scene);
      expect(r.warnings).toEqual([]);
    }
  });
});

describe('bare-name pin spans ALL subjects (documented semantics)', () => {
  test('a pin keyed by the bare list name fills every subject slot of that list', () => {
    // DECISION (Finding 5): AxisRow.tsx reads `pins[occurrence.key] ?? pins[occurrence.listName]`.
    // Because `occurrence.listName` is the @N-STRIPPED name (`look`), a pin stored
    // under the bare key `look` is the SELF pin for every `look` row regardless of
    // subject — so look@1, look@2 AND scene look#0 all resolve to it simultaneously.
    // This is INTENTIONAL: a bare-name pin pins the whole list across all subjects;
    // to pin a single subject independently, pin via that subject's own row
    // (occurrence key `look@1#0`, etc.). `replaceVariables` reads `picks.get(key)`
    // with a bare-name fallback identical to AxisRow's `currentPin`.
    const t = tpl('{{var::look@1}} :: {{var::look@2}} :: {{var::look}}');
    for (let seed = 0; seed < 16; seed++) {
      // Pin the whole `look` list (bare name) to RETRO.
      const r = resolve(t, lists, dims, { seed, pins: { look: 'r' } });
      const [a, b, scene] = r.text.split(' :: ');
      expect(a).toBe('RETRO');
      expect(b).toBe('RETRO');
      expect(scene).toBe('RETRO');
      expect(r.warnings).toEqual([]);
    }
  });
});
