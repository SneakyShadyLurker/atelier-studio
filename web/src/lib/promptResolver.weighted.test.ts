import { describe, expect, test } from 'bun:test';
import type { PromptTemplate, TagDimension, VariableList } from '@atelier/shared';
import { resolve } from './promptResolver';

function listWith(name: string, options: {
  id: string;
  value: string;
  weight: number;
  tagIds?: string[];
}[]): VariableList {
  return {
    id: `list-${name}`,
    name,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    options: options.map((o, idx) => ({
      id: o.id,
      listId: `list-${name}`,
      value: o.value,
      tagIds: o.tagIds ?? [],
      sortOrder: idx,
      weight: o.weight,
    })),
  };
}

function template(body: string): PromptTemplate {
  return { id: 't', name: 't', body, sortOrder: 0, createdAt: 0, updatedAt: 0 };
}

function distribution(
  templ: PromptTemplate,
  lists: readonly VariableList[],
  dims: readonly TagDimension[],
  iterations: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (let seed = 0; seed < iterations; seed++) {
    const { picks } = resolve(templ, lists, dims, { seed, pins: {} });
    for (const optionId of Object.values(picks)) {
      counts.set(optionId, (counts.get(optionId) ?? 0) + 1);
    }
  }
  return counts;
}

describe('weighted resolver distribution', () => {
  test('weights [1, 3, 6] approximate [0.10, 0.30, 0.60] within 5%', () => {
    const list = listWith('color', [
      { id: 'red', value: 'red', weight: 1 },
      { id: 'green', value: 'green', weight: 3 },
      { id: 'blue', value: 'blue', weight: 6 },
    ]);
    const iterations = 10_000;
    const counts = distribution(template('{{var::color}}'), [list], [], iterations);

    const fraction = (id: string) => (counts.get(id) ?? 0) / iterations;
    expect(fraction('red')).toBeGreaterThan(0.05);
    expect(fraction('red')).toBeLessThan(0.15);
    expect(fraction('green')).toBeGreaterThan(0.25);
    expect(fraction('green')).toBeLessThan(0.35);
    expect(fraction('blue')).toBeGreaterThan(0.55);
    expect(fraction('blue')).toBeLessThan(0.65);
  });

  test('coherence filters an incompatible high-weight option before weighted sampling', () => {
    const dims: TagDimension[] = [{
      id: 'tone',
      name: 'tone',
      tags: [
        { id: 'soft', dimensionId: 'tone', label: 'soft', sortOrder: 0 },
        { id: 'hard', dimensionId: 'tone', label: 'hard', sortOrder: 1 },
      ],
    }];
    const color = listWith('color', [
      { id: 'rare-soft', value: 'rare soft', weight: 1, tagIds: ['soft'] },
      { id: 'common-soft', value: 'common soft', weight: 3, tagIds: ['soft'] },
      { id: 'blocked-hard', value: 'blocked hard', weight: 6, tagIds: ['hard'] },
    ]);
    const anchor = listWith('anchor', [
      { id: 'anchor-soft', value: 'anchor soft', weight: 1, tagIds: ['soft'] },
    ]);
    const iterations = 10_000;
    const counts = distribution(template('{{var::color}} {{var::anchor}}'), [color, anchor], dims, iterations);

    const rare = (counts.get('rare-soft') ?? 0) / iterations;
    const common = (counts.get('common-soft') ?? 0) / iterations;
    expect(counts.get('blocked-hard') ?? 0).toBe(0);
    expect(common).toBeGreaterThan(0.70);
    expect(common).toBeLessThan(0.80);
    expect(rare).toBeGreaterThan(0.20);
    expect(rare).toBeLessThan(0.30);
  });

  test('uniform weights produce uniform distribution', () => {
    const list = listWith('uniform', [
      { id: 'a', value: 'a', weight: 1 },
      { id: 'b', value: 'b', weight: 1 },
      { id: 'c', value: 'c', weight: 1 },
      { id: 'd', value: 'd', weight: 1 },
    ]);
    const iterations = 10_000;
    const counts = distribution(template('{{var::uniform}}'), [list], [], iterations);
    for (const id of ['a', 'b', 'c', 'd']) {
      const fraction = (counts.get(id) ?? 0) / iterations;
      expect(fraction).toBeGreaterThan(0.20);
      expect(fraction).toBeLessThan(0.30);
    }
  });

  test('a weight-0 option is never selected automatically across many seeds', () => {
    const list = listWith('color', [
      { id: 'manual', value: 'manual', weight: 0 },
      { id: 'automatic', value: 'automatic', weight: 1 },
    ]);
    const counts = distribution(template('{{var::color}}'), [list], [], 10_000);

    expect(counts.get('manual') ?? 0).toBe(0);
    expect(counts.get('automatic')).toBe(10_000);
  });

  test('the incoherent fallback never lands on a manual-only first option', () => {
    const dims: TagDimension[] = [{
      id: 'genre',
      name: 'genre',
      tags: [
        { id: 'fantasy', dimensionId: 'genre', label: 'fantasy', sortOrder: 0 },
        { id: 'scifi', dimensionId: 'genre', label: 'science fiction', sortOrder: 1 },
      ],
    }];
    const anchor = listWith('anchor', [
      { id: 'anchor-fantasy', value: 'fantasy anchor', weight: 1, tagIds: ['fantasy'] },
    ]);
    const conflicting = listWith('conflicting', [
      { id: 'manual-fantasy', value: 'manual fantasy', weight: 0, tagIds: ['fantasy'] },
      { id: 'automatic-scifi', value: 'automatic science fiction', weight: 1, tagIds: ['scifi'] },
    ]);

    for (let seed = 0; seed < 1_000; seed++) {
      const result = resolve(
        template('{{var::anchor}} {{var::conflicting}}'),
        [anchor, conflicting],
        dims,
        { seed, pins: {} },
      );
      expect(result.picks['conflicting#0']).toBe('automatic-scifi');
    }
  });

  test('pinning a weight-0 option resolves it despite a weight-99 sibling', () => {
    const list = listWith('color', [
      { id: 'rare', value: 'rare', weight: 0 },
      { id: 'common', value: 'common', weight: 99 },
    ]);
    const iterations = 1_000;
    for (let seed = 0; seed < iterations; seed++) {
      const { picks } = resolve(template('{{var::color}}'), [list], [], {
        seed,
        pins: { color: 'rare' },
      });
      expect(picks['color#0']).toBe('rare');
    }
  });

  test('pinning a weight-1 option always wins over a weight-99 sibling', () => {
    const list = listWith('color', [
      { id: 'rare', value: 'rare', weight: 1 },
      { id: 'common', value: 'common', weight: 99 },
    ]);
    const iterations = 1_000;
    for (let seed = 0; seed < iterations; seed++) {
      const { picks } = resolve(template('{{var::color}}'), [list], [], {
        seed,
        pins: { color: 'rare' },
      });
      expect(picks['color#0']).toBe('rare');
    }
  });

  test('weight-100 vs weight-1 stays inside approximate 0.99 / 0.01 bounds', () => {
    const list = listWith('color', [
      { id: 'always', value: 'always', weight: 100 },
      { id: 'never', value: 'never', weight: 1 },
    ]);
    const iterations = 10_000;
    const counts = distribution(template('{{var::color}}'), [list], [], iterations);
    const alwaysFrac = (counts.get('always') ?? 0) / iterations;
    expect(alwaysFrac).toBeGreaterThan(0.97);
    expect(alwaysFrac).toBeLessThan(1.0);
  });
});
