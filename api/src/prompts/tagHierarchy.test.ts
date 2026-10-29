import { expect, test } from 'bun:test';
import { assertNoNewTagOverlaps, hierarchyError, inheritTagParent, InvalidTagMutationError } from './tagHierarchy';

test('inherited edges use the route cycle/depth invariant and preserve existing parents', () => {
  const parents = new Map<string, string | null>([['x', null], ['y', null]]);
  expect(inheritTagParent(parents, 'y', 'x')).toBe(true);
  expect(inheritTagParent(parents, 'x', 'y')).toBe(false);
  expect(parents.get('x')).toBeNull();
  expect(inheritTagParent(parents, 'y', 'y')).toBe(false);
  const chain = new Map<string, string | null>(Array.from({ length: 8 }, (_, idx) => [`t${idx}`, idx ? `t${idx - 1}` : null]));
  chain.set('new-root', null);
  expect(inheritTagParent(chain, 't0', 'new-root')).toBe(false);
  expect(hierarchyError([...chain].map(([id, parentId]) => ({ id, parentId })))).toBeNull();
  expect(hierarchyError([{ id: 'x', parentId: 'missing' }])).toBe('unknown-parent');
});

test('conflict identities preserve an untouched old overlap but reject a newly reparented pair', () => {
  const before = new Map<string, string | null>([['oldp', null], ['oldc', 'oldp'], ['p', null], ['c', null]]);
  const memberships = new Map([['option', { require: ['oldc', 'c'], exclude: ['oldp', 'p'] }]]);
  expect(() => { assertNoNewTagOverlaps(before, memberships, before, memberships); }).not.toThrow();
  const after = new Map(before); after.set('c', 'p');
  expect(() => { assertNoNewTagOverlaps(before, memberships, after, memberships); }).toThrow(InvalidTagMutationError);
});

class ParentReadMap extends Map<string, string | null> {
  reads = 0;
  override get(key: string): string | null | undefined {
    this.reads += 1;
    return super.get(key);
  }
}

for (const unrelatedReparent of [false, true]) {
  test(`dense cloned legacy memberships avoid Cartesian ancestor rebuilding (unrelated reparent: ${unrelatedReparent})`, () => {
    const parents = new Map<string, string | null>();
    const required: string[] = []; const excluded: string[] = [];
    for (let dimension = 0; dimension < 20; dimension += 1) {
      const root = `root-${dimension}`;
      parents.set(root, null);
      for (let tag = 0; tag < 28; tag += 1) {
        const id = `tag-${dimension}-${tag}`;
        parents.set(id, root);
        (tag < 14 ? required : excluded).push(id);
      }
    }
    parents.set('unused', null); parents.set('unused-parent', null);
    const beforeParents = new ParentReadMap(parents);
    const afterParents = new ParentReadMap(parents);
    if (unrelatedReparent) afterParents.set('unused', 'unused-parent');
    const before = new Map(Array.from({ length: 100 }, (_, index) => [
      `option-${index}`, { require: required.slice(), exclude: excluded.slice() },
    ]));
    const after = new Map([...before].map(([id, membership]) => [id, {
      require: membership.require.toReversed(), exclude: membership.exclude.toReversed(),
    }]));
    expect(() => { assertNoNewTagOverlaps(beforeParents, before, afterParents, after); }).not.toThrow();
    // Deterministic work bound, independent of wall-clock speed. All options
    // share tags, so expansion must scale with distinct ancestry, not pairs.
    expect(beforeParents.reads + afterParents.reads).toBeLessThan(parents.size * 8);
  });
}

test('an added membership cannot hide behind an unchanged legacy conflicting pair', () => {
  const parents = new Map<string, string | null>([['oldp', null], ['oldc', 'oldp'], ['p', null], ['c', 'p'], ['free', null]]);
  const before = new Map([['option', { require: ['oldc'], exclude: ['oldp', 'p'] }]]);
  const valid = new Map([['option', { require: ['oldc', 'free'], exclude: ['oldp', 'p'] }]]);
  expect(() => { assertNoNewTagOverlaps(parents, before, new Map(parents), valid); }).not.toThrow();
  const invalid = new Map([['option', { require: ['oldc', 'c'], exclude: ['oldp', 'p'] }]]);
  expect(() => { assertNoNewTagOverlaps(parents, before, new Map(parents), invalid); }).toThrow(InvalidTagMutationError);
  const removed = new Map([['option', { require: ['oldc'], exclude: ['oldp'] }]]);
  expect(() => { assertNoNewTagOverlaps(parents, before, new Map(parents), removed); }).not.toThrow();
});

test('changed excluded ancestry is checked even when required membership and its ancestry are unchanged', () => {
  const before = new Map<string, string | null>([['oldp', null], ['oldc', 'oldp'], ['p', null], ['c', 'p'], ['excluded', null]]);
  const memberships = new Map([['option', { require: ['oldc', 'c'], exclude: ['oldp', 'excluded'] }]]);
  const after = new Map(before); after.set('excluded', 'p');
  expect(() => { assertNoNewTagOverlaps(before, memberships, after, memberships); }).toThrow(InvalidTagMutationError);
});
