import { describe, expect, test } from 'bun:test';
import {
  buildDependencyGroups,
  dependenciesMet,
  effectiveSelection,
  toggleGroup,
} from './dependencySelection';

const node = (key: string, dependsOn: string[] = []) => ({ key, dependsOn });

describe('dependencySelection', () => {
  test('groups a three-member cycle, orders it after its dependency and before its dependent', () => {
    const groups = buildDependencyGroups([
      node('dependent', ['a']),
      node('a', ['b']),
      node('b', ['c']),
      node('c', ['a', 'base']),
      node('base'),
    ]);
    const cycle = groups.byKey.get('a');
    expect([...(cycle?.members ?? [])].sort()).toEqual(['a', 'b', 'c']);
    expect(groups.byKey.get('b')).toBe(cycle);
    expect(cycle?.externalDeps).toEqual(['base']);
    const position = (key: string) => groups.ordered.findIndex((group) => group.members.includes(key));
    expect(position('base')).toBeLessThan(position('a'));
    expect(position('a')).toBeLessThan(position('dependent'));

    const all = new Set(['dependent', 'a', 'b', 'c', 'base']);
    expect([...effectiveSelection(groups, all)]).toEqual([...all]);
    const withoutBase = new Set(['dependent', 'a', 'b', 'c']);
    expect(effectiveSelection(groups, withoutBase).size).toBe(0);
    expect(dependenciesMet(groups, effectiveSelection(groups, withoutBase), 'b')).toBe(false);
  });

  test('toggleGroup completes a partial cycle pick and removes a full one', () => {
    const groups = buildDependencyGroups([node('a', ['b']), node('b', ['c']), node('c', ['a'])]);
    const completed = toggleGroup(groups, new Set(['b']), 'c');
    expect([...completed].sort()).toEqual(['a', 'b', 'c']);
    expect(toggleGroup(groups, completed, 'a').size).toBe(0);
  });

  test('a self-dependency is internal and does not block selection', () => {
    const groups = buildDependencyGroups([node('x', ['x'])]);
    expect(groups.byKey.get('x')?.externalDeps).toEqual([]);
    expect([...effectiveSelection(groups, new Set(['x']))]).toEqual(['x']);
  });

  test('deep dependency chains resolve without recursion', () => {
    const size = 20_000;
    // Listed dependent-first so traversal starts at the deepest end.
    const bundles = Array.from({ length: size }, (_, i) => node(`k${i}`, i === 0 ? [] : [`k${i - 1}`])).reverse();
    const groups = buildDependencyGroups(bundles);
    expect(groups.ordered).toHaveLength(size);
    const picked = new Set(bundles.map((bundle) => bundle.key));
    expect(effectiveSelection(groups, picked).size).toBe(size);
    picked.delete('k0');
    expect(effectiveSelection(groups, picked).size).toBe(0);
  });
});
