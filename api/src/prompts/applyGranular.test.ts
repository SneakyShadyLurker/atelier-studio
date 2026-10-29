import type { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type { Config } from '../config';
import { testRuntime } from '../test/helpers';
import { applyBundlesGranular, ApplyLimitError } from './applyGranular';
import type { LibrarySnapshot, RawBundle } from './inferTypes';
import { applyBundlesToSnapshot, resolveProposal } from './dimensionResolver';
import { toLibrarySnapshot } from './librarySnapshot';
import { promptLibrary } from '../routes/prompts/_shared';
import { templateSatisfiable } from './dimensionCoherence';
import { bundleClosure } from './closureWalk';
import { InvalidTagMutationError } from './tagHierarchy';

interface ApplyTestDb {
  config: Config;
  db: Database;
  listId: string;
  liveSnap: LibrarySnapshot;
  optionId: string;
  userId: string;
}

function makeApplyTestDb(optionValue = 'existing'): ApplyTestDb {
  const { config, db } = testRuntime();
  const now = Date.now();
  const userId = 'test-user';
  const listId = crypto.randomUUID();
  const optionId = crypto.randomUUID();
  db.query('INSERT INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  db.query(
    `INSERT INTO variable_lists (id, user_id, name, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(listId, userId, 'outfits', 0, now, now);
  db.query(
    `INSERT INTO variable_options (id, user_id, list_id, value, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(optionId, userId, listId, optionValue, 0, now);
  return {
    config,
    db,
    listId,
    optionId,
    userId,
    liveSnap: {
      dimensions: [],
      lists: [{
        idx: 0,
        id: listId,
        name: 'outfits',
        options: [{ idx: 0, id: optionId, value: optionValue, weight: 1, tagIdxs: [] }],
      }],
    },
  };
}

function addDimension(
  fixture: ApplyTestDb,
  name: string,
  labels: readonly string[],
): { dimensionId: string; tagIds: string[] } {
  const dimensionId = crypto.randomUUID();
  fixture.db.query(
    'INSERT INTO tag_dimensions (id, user_id, name, created_at) VALUES (?, ?, ?, ?)',
  ).run(dimensionId, fixture.userId, name, Date.now());
  const startIdx = fixture.liveSnap.dimensions.reduce((count, dimension) => count + dimension.tags.length, 0);
  const tags = labels.map((label, index) => {
    const tagId = crypto.randomUUID();
    fixture.db.query(
      'INSERT INTO dimension_tags (id, user_id, dimension_id, label, sort_order) VALUES (?, ?, ?, ?, ?)',
    ).run(tagId, fixture.userId, dimensionId, label, index);
    return { id: tagId, label };
  });
  fixture.liveSnap.dimensions.push({
    idx: fixture.liveSnap.dimensions.length,
    id: dimensionId,
    name,
    tags: tags.map((tag, index) => ({ idx: startIdx + index, id: tag.id, label: tag.label })),
  });
  return { dimensionId, tagIds: tags.map((tag) => tag.id) };
}

function removeVariableOptionWeightDefaultForTest(db: Database): void {
  db.run('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.run(`
        ALTER TABLE variable_options RENAME TO variable_options_with_default;

        CREATE TABLE variable_options (
          id          TEXT PRIMARY KEY,
          user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          list_id     TEXT NOT NULL REFERENCES variable_lists(id) ON DELETE CASCADE,
          value       TEXT NOT NULL,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          weight      INTEGER NOT NULL CHECK(weight BETWEEN 1 AND 100),
          created_at  INTEGER NOT NULL
        );

        INSERT INTO variable_options (id, user_id, list_id, value, sort_order, weight, created_at)
        SELECT id, user_id, list_id, value, sort_order, weight, created_at
          FROM variable_options_with_default;

        DROP TABLE variable_options_with_default;
      `);
    })();
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}

for (const op of ['assignOptionTags', 'addOption'] as const) {
  for (const tags of [[], [{ dimName: 'missing', label: 'missing' }],
    [{ dimName: 'Era', label: 'known' }, { dimName: 'Era', label: 'unknown' }]]) {
    test(`${op} rejects the whole invalid bag ${JSON.stringify(tags)} in preview and SQL with rollback`, () => {
      const fixture = makeApplyTestDb();
      addDimension(fixture, 'Era', ['known']);
      const original = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
      const bundles: RawBundle[] = [{ key: 'invalid', dependsOn: [], ops: [
        { op: 'createDimension', name: 'rolled back', tags: ['new'] },
        op === 'addOption' ? { op, listIdx: 0, value: 'new option', tags }
          : { op, listIdx: 0, optionIdx: 0, tags },
      ] }];
      expect(() => applyBundlesToSnapshot(original, bundles)).toThrow(InvalidTagMutationError);
      expect(() => { fixture.db.transaction(() => { applyBundlesGranular(fixture.db, fixture.userId, fixture.config, original, bundles); })(); })
        .toThrow(InvalidTagMutationError);
      expect(toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId))).toEqual(original);
    });
  }
}

for (const oldContradiction of [false, true]) {
  test(`new ancestor overlap cannot be hidden by old unrelated state (${oldContradiction}); later repair is accepted`, () => {
    const fixture = makeApplyTestDb();
    const target = addDimension(fixture, 'Era', ['parent', 'child', 'safe']);
    const [parent, child] = target.tagIds;
    if (!parent || !child) throw new Error('target tags missing');
    fixture.db.query('UPDATE dimension_tags SET parent_id=? WHERE id=?').run(parent, child);
    fixture.db.query("INSERT INTO option_tags (option_id,tag_id,polarity) VALUES (?,?,'exclude')").run(fixture.optionId, parent);
    if (oldContradiction) {
      const old = addDimension(fixture, 'Old', ['p', 'c']);
      const [oldParent, oldChild] = old.tagIds;
      if (!oldParent || !oldChild) throw new Error('legacy tags missing');
      fixture.db.query('UPDATE dimension_tags SET parent_id=? WHERE id=?').run(oldParent, oldChild);
      fixture.db.query('INSERT INTO option_tags (option_id,tag_id,polarity) VALUES (?,?,?)').run(fixture.optionId, oldParent, 'exclude');
      fixture.db.query('INSERT INTO option_tags (option_id,tag_id,polarity) VALUES (?,?,?)').run(fixture.optionId, oldChild, 'require');
    }
    const original = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
    const bundles: RawBundle[] = [{ key: 'invalid', dependsOn: [], ops: [
      { op: 'createDimension', name: 'rolled back', tags: ['new'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Era', label: 'child' }] },
    ] }];
    expect(() => applyBundlesToSnapshot(original, bundles)).toThrow(InvalidTagMutationError);
    expect(() => { fixture.db.transaction(() => { applyBundlesGranular(fixture.db, fixture.userId, fixture.config, original, bundles); })(); })
      .toThrow(InvalidTagMutationError);
    expect(toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId))).toEqual(original);
    const bundle = bundles[0];
    if (!bundle) throw new Error('repair bundle missing');
    bundle.ops.push({ op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Era', label: 'safe' }] });
    const preview = applyBundlesToSnapshot(original, bundles);
    fixture.db.transaction(() => { applyBundlesGranular(fixture.db, fixture.userId, fixture.config, original, bundles); })();
    expect(snapshotState(toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId)))).toEqual(snapshotState(preview));
  });
}

test('merge-created ancestry rejects a newly contradictory membership with complete rollback', () => {
  const fixture = makeApplyTestDb();
  const source = addDimension(fixture, 'Source', ['parent', 'child']);
  const target = addDimension(fixture, 'Target', ['parent']);
  const [sourceParent, sourceChild] = source.tagIds;
  const [targetParent] = target.tagIds;
  if (!sourceParent || !sourceChild || !targetParent) throw new Error('merge tags missing');
  fixture.db.query('UPDATE dimension_tags SET parent_id=? WHERE id=?').run(sourceParent, sourceChild);
  fixture.db.query('INSERT INTO option_tags (option_id,tag_id,polarity) VALUES (?,?,?)').run(fixture.optionId, sourceChild, 'require');
  fixture.db.query('INSERT INTO option_tags (option_id,tag_id,polarity) VALUES (?,?,?)').run(fixture.optionId, targetParent, 'exclude');
  const original = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
  const bundles: RawBundle[] = [{ key: 'merge', dependsOn: [], ops: [{ op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} }] }];
  expect(() => applyBundlesToSnapshot(original, bundles)).toThrow(InvalidTagMutationError);
  expect(() => { fixture.db.transaction(() => { applyBundlesGranular(fixture.db, fixture.userId, fixture.config, original, bundles); })(); })
    .toThrow(InvalidTagMutationError);
  expect(toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId))).toEqual(original);
});

function snapshotState(snapshot: LibrarySnapshot) {
  const tags = new Map(snapshot.dimensions.flatMap((d) => d.tags.map((t) => [t.idx, `${d.name}:${t.label}`] as const)));
  return {
    dimensions: snapshot.dimensions.map((d) => ({ name: d.name, tags: d.tags.map((t) => ({
      label: t.label, parent: t.parentIdx === undefined ? null : tags.get(t.parentIdx),
    })).sort((a, b) => a.label.localeCompare(b.label)) })).sort((a, b) => a.name.localeCompare(b.name)),
    options: snapshot.lists.flatMap((list) => list.options.map((o) => ({
      list: list.name, value: o.value,
      require: o.tagIdxs.map((idx) => tags.get(idx)).sort(),
      exclude: (o.excludeTagIdxs ?? []).map((idx) => tags.get(idx)).sort(),
    }))),
  };
}

function seedPartner(fixture: ApplyTestDb): string {
  const listId = crypto.randomUUID();
  const optionId = crypto.randomUUID();
  fixture.db.query(`INSERT INTO variable_lists (id, user_id, name, sort_order, created_at, updated_at)
    VALUES (?, ?, 'partner', 1, 1, 1)`).run(listId, fixture.userId);
  fixture.db.query(`INSERT INTO variable_options (id, user_id, list_id, value, sort_order, weight, created_at)
    VALUES (?, ?, ?, 'P', 0, 1, 1)`).run(optionId, fixture.userId, listId);
  return optionId;
}

test('merge consumes a require-wins exclude collision before a later assignment removes that require', () => {
  const fixture = makeApplyTestDb('O');
  const a = addDimension(fixture, 'A', ['x', 'y']);
  const b = addDimension(fixture, 'B', ['x', 'y']);
  const partner = seedPartner(fixture);
  const [ax, ay] = a.tagIds;
  const bx = b.tagIds[0];
  if (!ax || !ay || !bx) throw new Error('missing tags');
  const insert = fixture.db.query('INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, ?)');
  insert.run(fixture.optionId, ax, 'require');
  insert.run(fixture.optionId, bx, 'exclude');
  insert.run(partner, ax, 'require');
  insert.run(partner, ay, 'require');
  const original = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
  const bundles: RawBundle[] = [{ key: 'merge', dependsOn: [], ops: [
    { op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} },
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'B', label: 'y' }] },
  ] }];
  const preview = applyBundlesToSnapshot(original, bundles);
  applyBundlesGranular(fixture.db, fixture.userId, fixture.config, original, bundles);
  const actual = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
  expect(snapshotState(preview)).toEqual(snapshotState(actual));
  expect(preview.lists[0]?.options[0]?.excludeTagIdxs ?? []).toEqual([]);
  expect(templateSatisfiable(['outfits', 'partner'], preview)).toBe(true);
  expect(templateSatisfiable(['outfits', 'partner'], actual)).toBe(true);
});

for (const introduced of [false, true]) {
  test(`multi-hop merge retains ${introduced ? 'new source tags and hierarchy' : 'shared source tags'} in preview and SQL`, () => {
    const fixture = makeApplyTestDb('O');
    const a = addDimension(fixture, 'A', introduced ? ['parent', 'x'] : ['x']);
    addDimension(fixture, 'B', introduced ? ['b'] : ['x']);
    const c = addDimension(fixture, 'C', introduced ? ['y'] : ['x', 'y']);
    const partner = seedPartner(fixture);
    const ax = a.tagIds[introduced ? 1 : 0];
    const cy = c.tagIds[introduced ? 0 : 1];
    if (!ax || !cy) throw new Error('missing tags');
    if (introduced) fixture.db.query('UPDATE dimension_tags SET parent_id = ? WHERE id = ?').run(a.tagIds[0] ?? '', ax);
    fixture.db.query("INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, 'require')").run(fixture.optionId, ax);
    fixture.db.query("INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, 'require')").run(partner, cy);
    const original = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
    const bundles = resolveProposal([
      { op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} },
      { op: 'mergeDimensions', fromIdx: 1, intoIdx: 2, tagMap: {} },
    ], original).rawBundles;
    const preview = applyBundlesToSnapshot(original, bundles);
    applyBundlesGranular(fixture.db, fixture.userId, fixture.config, original, bundles);
    const actual = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
    expect(snapshotState(preview)).toEqual(snapshotState(actual));
    expect(snapshotState(preview).options[0]?.require).toEqual(['C:x']);
    expect(templateSatisfiable(['outfits', 'partner'], preview)).toBe(false);
    expect(templateSatisfiable(['outfits', 'partner'], actual)).toBe(false);
    if (introduced) expect(snapshotState(actual).dimensions[0]?.tags.find((t) => t.label === 'x')?.parent).toBe('C:parent');
  });
}

test('renamed-dimension assignment closure includes rename and added tags with preview/SQL parity', () => {
  const fixture = makeApplyTestDb('O');
  const a = addDimension(fixture, 'A', ['old']);
  const original = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
  const resolved = resolveProposal([
    { op: 'renameDimension', dimIdx: 0, newName: 'X' },
    { op: 'addTags', dimIdx: 0, tags: ['new'] },
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'X', label: 'old' }, { dimName: 'X', label: 'new' }] },
  ], original);
  expect(resolved.rejected).toEqual([]);
  expect(resolved.rawBundles.find((b) => b.key === `extend:${a.dimensionId}`)?.dependsOn).toContain(`rename:${a.dimensionId}`);
  const chosen = bundleClosure(resolved.rawBundles, [`extend:${a.dimensionId}`]);
  const preview = applyBundlesToSnapshot(original, chosen);
  applyBundlesGranular(fixture.db, fixture.userId, fixture.config, original, chosen);
  const actual = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
  expect(snapshotState(preview)).toEqual(snapshotState(actual));
  expect(snapshotState(actual).options[0]?.require).toEqual(['X:new', 'X:old']);
});

for (const renameTarget of [false, true]) {
  test(`rename then merge preserves the ${renameTarget ? 'renamed target' : 'surviving target'} and assignment dependencies`, () => {
    const fixture = makeApplyTestDb('O');
    const a = addDimension(fixture, 'A', ['x']);
    const b = addDimension(fixture, 'B', ['b']);
    const ax = a.tagIds[0];
    if (!ax) throw new Error('missing source tag');
    fixture.db.query("INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, 'require')").run(fixture.optionId, ax);
    const original = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
    const targetName = renameTarget ? 'X' : 'B';
    const resolved = resolveProposal([
      { op: 'renameDimension', dimIdx: renameTarget ? 1 : 0, newName: 'X' },
      { op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: targetName, label: 'x' }] },
    ], original);
    expect(resolved.rejected).toEqual([]);
    const assignmentBundle = resolved.rawBundles.find((bundle) => bundle.ops.some((op) => op.op === 'assignOptionTags'));
    if (!assignmentBundle) throw new Error('missing assignment bundle');
    expect(assignmentBundle.key).toBe(`merge:${a.dimensionId}`);
    expect(assignmentBundle.opOrder).toEqual([1, 2]);
    expect(resolved.display.find((bundle) => bundle.key === assignmentBundle.key)?.kind).toBe('merge');
    const chosen = bundleClosure(resolved.rawBundles, [assignmentBundle.key]);
    expect(chosen.some((bundle) => bundle.key === `merge:${a.dimensionId}`)).toBe(true);
    expect(chosen.some((bundle) => bundle.key === `rename:${renameTarget ? b.dimensionId : a.dimensionId}`)).toBe(true);
    const preview = applyBundlesToSnapshot(original, chosen);
    applyBundlesGranular(fixture.db, fixture.userId, fixture.config, original, chosen);
    const actual = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
    expect(snapshotState(preview)).toEqual(snapshotState(actual));
    expect(snapshotState(actual).options[0]?.require).toEqual([`${targetName}:x`]);
    expect(actual.dimensions).toHaveLength(1);
  });
}

test('ordered repeated assignments preserve preview and SQL parity including prior excludes', () => {
  const fixture = makeApplyTestDb();
  const dim = addDimension(fixture, 'Genre', ['Fantasy', 'Modern', 'Historical']);
  const [fantasy, modern, historical] = dim.tagIds;
  if (!fantasy || !modern || !historical) throw new Error('missing tags');
  fixture.db.query("INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, 'exclude')")
    .run(fixture.optionId, fantasy);
  const option = fixture.liveSnap.lists[0]?.options[0];
  if (!option) throw new Error('missing option');
  option.excludeTagIdxs = [0];
  const bundles: RawBundle[] = [{ key: 'ordered', dependsOn: [], ops: [
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [
      { dimName: 'Genre', label: 'Modern' }, { dimName: 'Genre', label: 'Historical' },
    ] },
  ] }];
  const preview = applyBundlesToSnapshot(fixture.liveSnap, bundles);
  applyBundlesGranular(fixture.db, fixture.userId, fixture.config, fixture.liveSnap, bundles);
  const actual = fixture.db.query<{ tag_id: string; polarity: string }, [string]>(
    'SELECT tag_id, polarity FROM option_tags WHERE option_id = ? ORDER BY tag_id',
  ).all(fixture.optionId);
  const idByIdx = new Map(preview.dimensions.flatMap((d) => d.tags.map((t) => [t.idx, t.id] as const)));
  const previewOption = preview.lists[0]?.options[0];
  expect(previewOption?.excludeTagIdxs ?? []).toEqual([]);
  expect(previewOption?.tagIdxs.map((idx) => idByIdx.get(idx)).sort())
    .toEqual(actual.map((row) => row.tag_id));
  expect(actual).toEqual([modern, historical].sort().map((tag_id) => ({ tag_id, polarity: 'require' })));
});

test('applyBundlesGranular inserts new option for addOption op', () => {
  const fixture = makeApplyTestDb();
  addDimension(fixture, 'Era', ['vintage']);
  const { config, db, listId, liveSnap, userId } = fixture;
  const bundles = [{
    key: 'rescue:portrait',
    ops: [{ op: 'addOption', listIdx: 0, value: 'vintage jacket', tags: [{ dimName: 'Era', label: 'vintage' }] }],
    dependsOn: [],
  }] satisfies RawBundle[];

  applyBundlesGranular(db, userId, config, liveSnap, bundles);

  const opts = db.query<{ value: string }, [string, string]>(
    'SELECT value FROM variable_options WHERE list_id = ? AND user_id = ?',
  ).all(listId, userId);
  expect(opts.map((o) => o.value)).toContain('vintage jacket');
});

test('colon-containing list/value pairs retain independent memberships across successive previews and SQL apply', () => {
  const fixture = makeApplyTestDb();
  fixture.db.query('UPDATE variable_lists SET name = ? WHERE id = ?').run('a:b', fixture.listId);
  const partnerId = seedPartner(fixture);
  fixture.db.query('UPDATE variable_lists SET name = ? WHERE id = (SELECT list_id FROM variable_options WHERE id = ?)')
    .run('a', partnerId);
  addDimension(fixture, 'Era', ['ancient', 'modern']);
  const original = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
  const bundles: RawBundle[] = ['c', 'b:c'].map((value, listIdx) => ({
    key: `rescue:${listIdx}`, dependsOn: [],
    ops: [{ op: 'addOption', listIdx, value, tags: [{ dimName: 'Era', label: listIdx === 0 ? 'ancient' : 'modern' }] }],
  }));
  const firstBundle = bundles[0];
  const secondBundle = bundles[1];
  if (!firstBundle || !secondBundle) throw new Error('expected rescue bundles');
  const first = applyBundlesToSnapshot(original, [firstBundle]);
  const successive = applyBundlesToSnapshot(first, [secondBundle]);
  const together = applyBundlesToSnapshot(original, bundles);
  expect(successive.lists[0]?.options.at(-1)?.id).toBe(first.lists[0]?.options.at(-1)?.id);
  expect(successive.lists[0]?.options.at(-1)?.id).not.toBe(successive.lists[1]?.options.at(-1)?.id);
  expect(successive).toEqual(together);
  expect(snapshotState(successive).options.filter((option) => option.value === 'c' || option.value === 'b:c')).toEqual([
    { list: 'a:b', value: 'c', require: ['Era:ancient'], exclude: [] },
    { list: 'a', value: 'b:c', require: ['Era:modern'], exclude: [] },
  ]);
  applyBundlesGranular(fixture.db, fixture.userId, fixture.config, original, bundles);
  expect(snapshotState(toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId)))).toEqual(snapshotState(successive));
});

test('applyBundlesGranular inserts weight = 1 explicitly for addOption op', () => {
  const fixture = makeApplyTestDb();
  addDimension(fixture, 'Era', ['vintage']);
  const { config, db, liveSnap, userId } = fixture;
  removeVariableOptionWeightDefaultForTest(db);
  const bundles = [{
    key: 'rescue:portrait',
    ops: [{ op: 'addOption', listIdx: 0, value: 'vintage jacket', tags: [{ dimName: 'Era', label: 'vintage' }] }],
    dependsOn: [],
  }] satisfies RawBundle[];

  applyBundlesGranular(db, userId, config, liveSnap, bundles);

  const row = db
    .query<{ weight: number }, [string]>(
      'SELECT weight FROM variable_options WHERE value = ?',
    )
    .get('vintage jacket');
  expect(row?.weight).toBe(1);
});

test('applyBundlesGranular throws ApplyLimitError on duplicate addOption value', () => {
  const fixture = makeApplyTestDb('existing');
  addDimension(fixture, 'Era', ['vintage']);
  const { config, db, liveSnap, userId } = fixture;
  const bundles = [{
    key: 'rescue:x',
    ops: [{ op: 'addOption', listIdx: 0, value: 'existing', tags: [{ dimName: 'Era', label: 'vintage' }] }],
    dependsOn: [],
  }] satisfies RawBundle[];

  expect(() => { applyBundlesGranular(db, userId, config, liveSnap, bundles); })
    .toThrow(ApplyLimitError);
});

test('applyBundlesGranular preserves exclude polarity when merging option tags', () => {
  const fixture = makeApplyTestDb();
  const from = addDimension(fixture, 'From', ['mapped']);
  const into = addDimension(fixture, 'Into', ['mapped']);
  const fromTagId = from.tagIds[0];
  const intoTagId = into.tagIds[0];
  if (!fromTagId || !intoTagId) throw new Error('expected merge tags');
  fixture.db.query(
    'INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, ?)',
  ).run(fixture.optionId, fromTagId, 'exclude');
  const bundles: RawBundle[] = [{
    key: 'merge:From',
    ops: [{ op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: { mapped: 'mapped' } }],
    dependsOn: [],
  }];

  applyBundlesGranular(fixture.db, fixture.userId, fixture.config, fixture.liveSnap, bundles);

  const row = fixture.db.query<{ polarity: string }, [string, string]>(
    'SELECT polarity FROM option_tags WHERE option_id = ? AND tag_id = ?',
  ).get(fixture.optionId, intoTagId);
  expect(row?.polarity).toBe('exclude');
});

test('applyBundlesGranular preserves excludes while replacing required tags in a touched dimension', () => {
  const fixture = makeApplyTestDb();
  const dimension = addDimension(fixture, 'Franchise', ['old requirement', 'blocked', 'new requirement']);
  const [oldRequired, blocked, newRequired] = dimension.tagIds;
  if (!oldRequired || !blocked || !newRequired) throw new Error('expected tags');
  fixture.db.query(
    'INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, ?)',
  ).run(fixture.optionId, oldRequired, 'require');
  fixture.db.query(
    'INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, ?)',
  ).run(fixture.optionId, blocked, 'exclude');
  const liveOption = fixture.liveSnap.lists[0]?.options[0];
  if (!liveOption) throw new Error('expected live option');
  liveOption.tagIdxs = [0];
  liveOption.excludeTagIdxs = [1];
  const bundles: RawBundle[] = [{
    key: 'extend:Franchise',
    ops: [{
      op: 'assignOptionTags',
      listIdx: 0,
      optionIdx: 0,
      tags: [{ dimName: 'Franchise', label: 'new requirement' }],
    }],
    dependsOn: [],
  }];

  applyBundlesGranular(fixture.db, fixture.userId, fixture.config, fixture.liveSnap, bundles);

  const rows = fixture.db.query<{ tag_id: string; polarity: string }, [string]>(
    'SELECT tag_id, polarity FROM option_tags WHERE option_id = ? ORDER BY polarity, tag_id',
  ).all(fixture.optionId);
  expect(rows).toContainEqual({ tag_id: blocked, polarity: 'exclude' });
  expect(rows).toContainEqual({ tag_id: newRequired, polarity: 'require' });
  expect(rows).not.toContainEqual({ tag_id: oldRequired, polarity: 'require' });
});

test('applyBundlesGranular makes assigned require polarity win an existing exclude collision', () => {
  const fixture = makeApplyTestDb();
  const dimension = addDimension(fixture, 'Franchise', ['mapped']);
  const tagId = dimension.tagIds[0];
  if (!tagId) throw new Error('expected tag');
  fixture.db.query(
    'INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, ?)',
  ).run(fixture.optionId, tagId, 'exclude');
  const option = fixture.liveSnap.lists[0]?.options[0];
  if (!option) throw new Error('expected option');
  option.excludeTagIdxs = [0];

  applyBundlesGranular(fixture.db, fixture.userId, fixture.config, fixture.liveSnap, [{
    key: 'extend:Franchise',
    ops: [{
      op: 'assignOptionTags',
      listIdx: 0,
      optionIdx: 0,
      tags: [{ dimName: 'Franchise', label: 'mapped' }],
    }],
    dependsOn: [],
  }]);

  expect(fixture.db.query<{ polarity: string }, [string, string]>(
    'SELECT polarity FROM option_tags WHERE option_id = ? AND tag_id = ?',
  ).get(fixture.optionId, tagId)?.polarity).toBe('require');
});

test('applyBundlesGranular maps a source parent and child onto newly-created target hierarchy', () => {
  const fixture = makeApplyTestDb();
  const from = addDimension(fixture, 'From', ['parent', 'child']);
  const into = addDimension(fixture, 'Into', []);
  const [sourceParentId, sourceChildId] = from.tagIds;
  if (!sourceParentId || !sourceChildId) throw new Error('expected source tags');
  fixture.db.query('UPDATE dimension_tags SET parent_id = ? WHERE id = ?')
    .run(sourceParentId, sourceChildId);
  const sourceDimension = fixture.liveSnap.dimensions[0];
  const sourceParent = sourceDimension?.tags[0];
  const sourceChild = sourceDimension?.tags[1];
  if (!sourceParent || !sourceChild) throw new Error('expected source snapshot tags');
  sourceChild.parentIdx = sourceParent.idx;

  applyBundlesGranular(fixture.db, fixture.userId, fixture.config, fixture.liveSnap, [{
    key: 'merge:From',
    ops: [{
      op: 'mergeDimensions',
      fromIdx: 0,
      intoIdx: 1,
      tagMap: { parent: 'target parent', child: 'target child' },
    }],
    dependsOn: [],
  }]);

  const targetTags = fixture.db.query<{ label: string; parent_id: string | null; id: string }, [string]>(
    'SELECT id, label, parent_id FROM dimension_tags WHERE dimension_id = ? ORDER BY sort_order',
  ).all(into.dimensionId);
  const targetParent = targetTags.find((tag) => tag.label === 'target parent');
  const targetChild = targetTags.find((tag) => tag.label === 'target child');
  expect(targetChild?.parent_id).toBe(targetParent?.id);
});

function applyAndCompare(fixture: ApplyTestDb, ops: Parameters<typeof resolveProposal>[0], selected?: string[]) {
  const resolved = resolveProposal(ops, fixture.liveSnap);
  expect(resolved.rejected).toEqual([]);
  const bundles = selected ? bundleClosure(resolved.rawBundles, selected) : resolved.rawBundles;
  const preview = applyBundlesToSnapshot(fixture.liveSnap, bundles);
  fixture.db.transaction(() => { applyBundlesGranular(fixture.db, fixture.userId, fixture.config, fixture.liveSnap, bundles); })();
  const actual = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
  expect(snapshotState(preview)).toEqual(snapshotState(actual));
  return { preview, actual, bundles };
}

test('assignment before rename preserves its UNSAT membership in preview and SQL', () => {
  const fixture = makeApplyTestDb('O');
  const a = addDimension(fixture, 'A', ['x', 'y']);
  const partner = seedPartner(fixture);
  for (const optionId of [fixture.optionId, partner]) {
    const tagId = a.tagIds[0];
    if (!tagId) throw new Error('expected source tag');
    fixture.db.query("INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, 'require')").run(optionId, tagId);
  }
  fixture.liveSnap = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
  const { preview, actual } = applyAndCompare(fixture, [
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'A', label: 'y' }] },
    { op: 'renameDimension', dimIdx: 0, newName: 'X' },
  ]);
  expect(snapshotState(actual).options[0]?.require).toEqual(['X:y']);
  for (const snapshot of [preview, actual]) expect(templateSatisfiable(['outfits', 'partner'], snapshot)).toBe(false);
});

test('selected multi-axis assignment persists both axes with reciprocal bundle dependencies', () => {
  const fixture = makeApplyTestDb();
  const { actual, bundles } = applyAndCompare(fixture, [
    { op: 'createDimension', name: 'A', tags: ['x'] },
    { op: 'createDimension', name: 'B', tags: ['y'] },
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'A', label: 'x' }, { dimName: 'B', label: 'y' }] },
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'B', label: 'y' }, { dimName: 'A', label: 'x' }] },
  ], ['create:A']);
  expect(bundles.find((b) => b.key === 'create:A')?.dependsOn).toContain('create:B');
  expect(bundles.find((b) => b.key === 'create:B')?.dependsOn).toContain('create:A');
  expect(snapshotState(actual).options[0]?.require).toEqual(['A:x', 'B:y']);
});

test('selecting a rename or create into a freed name includes its vacancy provider', () => {
  for (const create of [false, true]) {
    const fixture = makeApplyTestDb();
    const a = addDimension(fixture, 'A', ['x']);
    const b = addDimension(fixture, 'B', ['y']);
    const selected = create ? 'create:A' : `rename:${b.dimensionId}`;
    const { actual, bundles } = applyAndCompare(fixture, [
      { op: 'renameDimension', dimIdx: 0, newName: 'X' },
      create ? { op: 'createDimension', name: 'A', tags: ['z'] } : { op: 'renameDimension', dimIdx: 1, newName: 'A' },
    ], [selected]);
    expect(bundles.find((bundle) => bundle.key === selected)?.dependsOn).toContain(`rename:${a.dimensionId}`);
    expect(actual.dimensions.map((d) => d.name).sort()).toEqual(create ? ['A', 'B', 'X'] : ['A', 'X']);
  }
});

for (const label of ['constructor', 'toString']) for (const explicit of [false, true]) {
  test(`merge handles ${explicit ? 'explicit own mapping' : 'identity fallback'} for ${label}`, () => {
    const fixture = makeApplyTestDb();
    const a = addDimension(fixture, 'A', [label]);
    addDimension(fixture, 'B', ['y']);
    const tagId = a.tagIds[0];
    if (!tagId) throw new Error('expected source tag');
    fixture.db.query("INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, 'require')").run(fixture.optionId, tagId);
    fixture.liveSnap = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
    const { actual } = applyAndCompare(fixture, [
      { op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: explicit ? { [label]: 'mapped' } : {} },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'A', label }] },
    ]);
    expect(snapshotState(actual).options[0]?.require).toEqual([`B:${explicit ? 'mapped' : label}`]);
  });
}

test('spaced dimension/tag identities select the actual assignment host', () => {
  const fixture = makeApplyTestDb();
  const { actual } = applyAndCompare(fixture, [
    { op: 'createDimension', name: 'Hair color', tags: ['dark brown'] },
    { op: 'createDimension', name: 'Hair', tags: ['color dark brown'] },
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Hair color', label: 'dark brown' }] },
  ], ['create:Hair color']);
  expect(actual.dimensions.map((d) => d.name)).toEqual(['Hair color']);
  expect(snapshotState(actual).options[0]?.require).toEqual(['Hair color:dark brown']);
});

test('addTags before rename and assignment retains the tag provider on partial selection', () => {
  const fixture = makeApplyTestDb();
  const a = addDimension(fixture, 'A', ['x']);
  const { actual } = applyAndCompare(fixture, [
    { op: 'addTags', dimIdx: 0, tags: ['z'] },
    { op: 'renameDimension', dimIdx: 0, newName: 'X' },
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'X', label: 'z' }] },
  ], [`extend:${a.dimensionId}`]);
  expect(snapshotState(actual).options[0]?.require).toEqual(['X:z']);
});

for (const addBeforeMerge of [false, true]) {
  test(`assignment before merge then ${addBeforeMerge ? 'source additions' : 'target rename'} preserves membership`, () => {
    const fixture = makeApplyTestDb();
    addDimension(fixture, 'A', ['x']);
    addDimension(fixture, 'B', ['y']);
    const { actual } = applyAndCompare(fixture, [
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'A', label: 'x' }] },
      ...(addBeforeMerge ? [{ op: 'addTags' as const, dimIdx: 0, tags: ['z'] }] : []),
      { op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} },
      ...(!addBeforeMerge ? [{ op: 'renameDimension' as const, dimIdx: 1, newName: 'X' }] : []),
    ]);
    expect(snapshotState(actual).options[0]?.require).toEqual([`${addBeforeMerge ? 'B' : 'X'}:x`]);
    if (addBeforeMerge) expect(actual.dimensions[0]?.tags.map((t) => t.label)).toContain('z');
  });
}

test('consumed alias follows stable destinations when an intermediate name is reused', () => {
  const fixture = makeApplyTestDb();
  addDimension(fixture, 'A', ['x']); addDimension(fixture, 'B', ['x']); addDimension(fixture, 'C', ['x']);
  const { actual } = applyAndCompare(fixture, [
    { op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} },
    { op: 'mergeDimensions', fromIdx: 1, intoIdx: 2, tagMap: {} },
    { op: 'createDimension', name: 'B', tags: ['x'] },
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'A', label: 'x' }] },
  ]);
  expect(snapshotState(actual).options[0]?.require).toEqual(['C:x']);
});

for (const depth of [false, true]) {
  test(`merge skips inherited ${depth ? 'depth-overflow including target descendants' : 'collapsed-map cycle'} edges`, () => {
    const fixture = makeApplyTestDb();
    const from = addDimension(fixture, 'A', depth ? ['p', 'c'] : ['p', 'c', 'g']);
    const into = addDimension(fixture, 'B', depth ? Array.from({ length: 8 }, (_, idx) => `t${idx}`) : []);
    for (let index = 1; index < from.tagIds.length; index++) {
      fixture.db.query('UPDATE dimension_tags SET parent_id = ? WHERE id = ?').run(from.tagIds[index - 1] ?? null, from.tagIds[index] ?? '');
    }
    for (let index = 1; index < into.tagIds.length; index++) {
      fixture.db.query('UPDATE dimension_tags SET parent_id = ? WHERE id = ?').run(into.tagIds[index - 1] ?? null, into.tagIds[index] ?? '');
    }
    fixture.liveSnap = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
    const { actual } = applyAndCompare(fixture, [{
      op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: depth ? { p: 't7', c: 'new-child' } : { p: 'x', c: 'y', g: 'x' },
    }]);
    const state = snapshotState(actual).dimensions[0];
    if (depth) expect(state?.tags.find((t) => t.label === 'new-child')?.parent).toBeNull();
    else {
      expect(state?.tags.find((t) => t.label === 'x')?.parent).toBeNull();
      expect(state?.tags.find((t) => t.label === 'y')?.parent).toBe('B:x');
    }
  });
}

test('merge skips deepening an existing target subtree when the root was created earlier in the apply', () => {
  const fixture = makeApplyTestDb();
  const source = addDimension(fixture, 'A', ['p', 'c']);
  addDimension(fixture, 'B', []);
  fixture.db.query('UPDATE dimension_tags SET parent_id = ? WHERE id = ?').run(source.tagIds[0] ?? '', source.tagIds[1] ?? '');
  fixture.liveSnap = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
  // Two source subtrees individually have depth <=8. Their collapsed merge
  // must not attach the target subtree under one more inherited ancestor.
  const third = addDimension(fixture, 'C', Array.from({ length: 8 }, (_, idx) => `t${idx}`));
  for (let index = 1; index < third.tagIds.length; index++) {
    fixture.db.query('UPDATE dimension_tags SET parent_id = ? WHERE id = ?').run(third.tagIds[index - 1] ?? null, third.tagIds[index] ?? '');
  }
  fixture.liveSnap = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
  const { actual } = applyAndCompare(fixture, [
    { op: 'mergeDimensions', fromIdx: 2, intoIdx: 1, tagMap: { t0: 'root' } },
    { op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: { p: 'new-parent', c: 'root' } },
  ]);
  expect(snapshotState(actual).dimensions[0]?.tags.find((t) => t.label === 'root')?.parent).toBeNull();
});

test('gapped source ordering preserves first inherited parent and SAT through chained merges', () => {
  const fixture = makeApplyTestDb('O');
  const a = addDimension(fixture, 'A', ['a', 'ca']);
  const b = addDimension(fixture, 'B', ['b', 'cb']);
  const c = addDimension(fixture, 'C', ['Bparent']);
  const partner = seedPartner(fixture);
  for (const dimension of [a, b]) {
    fixture.db.query('UPDATE dimension_tags SET parent_id = ? WHERE id = ?').run(dimension.tagIds[0] ?? '', dimension.tagIds[1] ?? '');
  }
  for (const [index, id] of b.tagIds.entries()) fixture.db.query('UPDATE dimension_tags SET sort_order = ? WHERE id = ?').run(100 + index, id);
  fixture.db.query("INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, 'require')").run(fixture.optionId, b.tagIds[1] ?? '');
  fixture.db.query("INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, 'require')").run(partner, c.tagIds[0] ?? '');
  fixture.liveSnap = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
  const { preview, actual } = applyAndCompare(fixture, [
    { op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} },
    { op: 'mergeDimensions', fromIdx: 1, intoIdx: 2, tagMap: { a: 'Aparent', ca: 'child', b: 'Bparent', cb: 'child' } },
  ]);
  expect(snapshotState(actual).dimensions[0]?.tags.find((tag) => tag.label === 'child')?.parent).toBe('C:Bparent');
  for (const snapshot of [preview, actual]) expect(templateSatisfiable(['outfits', 'partner'], snapshot)).toBe(true);
});

test('tag append normalizes only an exhausted safe-integer dimension preserving canonical order and IDs', () => {
  const fixture = makeApplyTestDb();
  const dimension = addDimension(fixture, 'A', ['root', 'child']);
  const untouched = addDimension(fixture, 'B', ['keep']);
  for (const [index, id] of dimension.tagIds.entries()) {
    fixture.db.query('UPDATE dimension_tags SET sort_order = ? WHERE id = ?').run(Number.MAX_SAFE_INTEGER - 1 + index, id);
  }
  fixture.db.query('UPDATE dimension_tags SET parent_id = ? WHERE id = ?').run(dimension.tagIds[0] ?? '', dimension.tagIds[1] ?? '');
  fixture.db.query('UPDATE dimension_tags SET sort_order = 100 WHERE id = ?').run(untouched.tagIds[0] ?? '');
  fixture.liveSnap = toLibrarySnapshot(promptLibrary(fixture.db, fixture.userId));
  applyAndCompare(fixture, [{ op: 'addTags', dimIdx: 0, tags: ['new1', 'new2'] }]);
  const rows = fixture.db.query<{ id: string; label: string; sort_order: number; parent_id: string | null }, [string]>(
    'SELECT id, label, sort_order, parent_id FROM dimension_tags WHERE dimension_id = ? ORDER BY sort_order, label, id',
  ).all(dimension.dimensionId);
  expect(rows.map((row) => row.label)).toEqual(['root', 'child', 'new1', 'new2']);
  expect(rows.map((row) => row.sort_order)).toEqual([0, 1, 2, 3]);
  expect(rows.slice(0, 2).map((row) => row.id)).toEqual(dimension.tagIds);
  expect(rows[1]?.parent_id).toBe(dimension.tagIds[0]);
  expect(fixture.db.query<{ sort_order: number }, [string]>('SELECT sort_order FROM dimension_tags WHERE id = ?').get(untouched.tagIds[0] ?? '')?.sort_order).toBe(100);
});
