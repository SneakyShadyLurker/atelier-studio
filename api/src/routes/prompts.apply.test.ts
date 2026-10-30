import { afterEach, describe, expect, test } from 'bun:test';
import { setTextModelProviderForTests } from '../providers/text/registry';
import type { PromptLibraryResponse, VariableList } from '@atelier/shared';
import { type TestCliproxyTextProvider } from '../providers/cliproxyText';
import { parseInferDone, testRuntime } from '../test/helpers';
import type { RawInferOp } from '../prompts/inferTypes';
import { templateSatisfiable } from '../prompts/dimensionCoherence';
import { snapshotHash, templatesDigest, toLibrarySnapshot } from '../prompts/librarySnapshot';
import { putProposal, takeProposalForUser } from '../prompts/proposalStore';
import type { RawBundle } from '../prompts/inferTypes';

afterEach(() => { setTextModelProviderForTests(null); });

function req<T>(value: T | undefined, message = 'expected value'): T {
  if (value === undefined) throw new Error(message);
  return value;
}

async function* emptyEnhance(): AsyncGenerator<never, void, unknown> {
  await Promise.resolve();
  if (Date.now() < 0) yield undefined as never;
}

function fake(ops: RawInferOp[]): TestCliproxyTextProvider {
  return {
    enhance: emptyEnhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops }),
    inferTaxonomy: () => Promise.resolve({ type: 'ok', ops }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
  };
}

async function createList(app: ReturnType<typeof testRuntime>['app'], userId: string, name: string): Promise<VariableList> {
  const res = await app.fetch(new Request('http://local/api/prompts/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({ name }),
  }));
  expect(res.status).toBe(201);
  return await res.json() as VariableList;
}

async function seedPromptUser(
  app: ReturnType<typeof testRuntime>['app'],
  userId: string,
  data: { lists: { name: string; options: string[] }[] },
): Promise<void> {
  for (const list of data.lists) {
    const created = await createList(app, userId, list.name);
    const res = await app.fetch(new Request(`http://local/api/prompts/lists/${created.id}/options`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({
        options: list.options.map((value, sortOrder) => ({ value, sortOrder, tagIds: [] })),
      }),
    }));
    expect(res.status).toBe(200);
  }
}

async function getLibrary(app: ReturnType<typeof testRuntime>['app'], userId: string): Promise<PromptLibraryResponse> {
  const res = await app.fetch(new Request('http://local/api/prompts', {
    headers: { 'Remote-User': userId },
  }));
  expect(res.status).toBe(200);
  return await res.json() as PromptLibraryResponse;
}

interface InferResponseShape {
  proposalId: string;
  baseSnapshotHash: string;
  proposal: { bundles: { key: string }[] };
  warnings: unknown[];
  rejected: unknown[];
}
async function infer(app: ReturnType<typeof testRuntime>['app'], userId: string): Promise<InferResponseShape> {
  const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
    method: 'POST',
    headers: { 'Remote-User': userId },
  }));
  expect(res.status).toBe(200);
  return await parseInferDone<InferResponseShape>(res);
}

describe('POST /api/prompts/dimensions/apply', () => {
  test('invalid final ancestry previews return retryable 409 for apply and diagnosis; later repair is allowed', async () => {
    const { app, db } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    await seedPromptUser(app, 'alice', { lists: [{ name: 'L', options: ['option'] }] });
    const dimensionId = crypto.randomUUID();
    const parent = crypto.randomUUID(); const child = crypto.randomUUID(); const safe = crypto.randomUUID();
    db.query('INSERT INTO tag_dimensions (id,user_id,name,created_at) VALUES (?,?,?,1)').run(dimensionId, 'alice', 'Era');
    for (const [index, [id, label]] of [[parent, 'parent'], [child, 'child'], [safe, 'safe']].entries()) {
      db.query('INSERT INTO dimension_tags (id,user_id,dimension_id,label,sort_order,parent_id) VALUES (?,?,?,?,?,?)')
        .run(req(id), 'alice', dimensionId, req(label), index, id === child ? parent : null);
    }
    const library = await getLibrary(app, 'alice');
    const option = req(req(library.variableLists[0]).options[0]);
    db.query("INSERT INTO option_tags (option_id,tag_id,polarity) VALUES (?,?,'exclude')").run(option.id, parent);
    const before = await getLibrary(app, 'alice');
    const snap = toLibrarySnapshot(before);
    const rawBundles: RawBundle[] = [
      { key: 'change', dependsOn: [], opOrder: [0, 1], ops: [
        { op: 'createDimension', name: 'Scratch', tags: ['tag'] },
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Era', label: 'child' }] },
      ] },
      { key: 'repair', dependsOn: ['change'], opOrder: [2], ops: [
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Era', label: 'safe' }] },
      ] },
    ];
    const proposalId = putProposal({ userId: 'alice', rawBundles,
      baseSnapshotHash: snapshotHash(snap), baseTemplateHash: templatesDigest(before.templates), expiresAt: Date.now() + 600_000 });
    for (const endpoint of ['apply', 'diagnose-selection', 'apply']) {
      const response = await app.fetch(new Request(`http://local/api/prompts/dimensions/${endpoint}`, {
        method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId, acceptedBundleKeys: ['change'], ...(endpoint === 'apply' ? { overrideCoherence: true } : {}) }),
      }));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'the same tag cannot be both require and exclude' });
      expect(takeProposalForUser(proposalId, 'alice')).not.toBeNull();
      expect(await getLibrary(app, 'alice')).toEqual(before);
    }
    const repaired = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, acceptedBundleKeys: ['repair'] }),
    }));
    expect(repaired.status).toBe(200);
    const after = await repaired.json() as PromptLibraryResponse;
    expect(after.variableLists[0]?.options[0]?.tagIds).toEqual([safe]);
    expect(after.variableLists[0]?.options[0]?.excludeTagIds).toEqual([parent]);
  });

  test('unknown assignment references return typed 409 without implicit tag creation or proposal consumption', async () => {
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    await seedPromptUser(app, 'alice', { lists: [{ name: 'L', options: ['option'] }] });
    const before = await getLibrary(app, 'alice');
    const proposalId = putProposal({ userId: 'alice', rawBundles: [{ key: 'invalid', dependsOn: [], ops: [
      { op: 'createDimension', name: 'Era', tags: ['known'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Era', label: 'unknown' }] },
    ] }], baseSnapshotHash: snapshotHash(toLibrarySnapshot(before)),
    baseTemplateHash: templatesDigest(before.templates), expiresAt: Date.now() + 600_000 });
    const response = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, acceptedBundleKeys: ['invalid'] }),
    }));
    expect(response.status).toBe(409);
    expect(await getLibrary(app, 'alice')).toEqual(before);
    expect(takeProposalForUser(proposalId, 'alice')).not.toBeNull();
  });
  for (const commented of [false, true]) {
    test(`${commented ? 'commented' : 'active'} conflicting and missing slots agree with the apply coherence gate`, async () => {
      const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
      await seedPromptUser(app, 'alice', { lists: [
        { name: 'A', options: ['A'] }, { name: 'B', options: ['B'] },
      ] });
      const body = commented
        ? '{{var::A}}{{// nested {{var::B}} {{var::Missing}} }}'
        : '{{var::A}} {{var::B}}';
      const template = await app.fetch(new Request('http://local/api/prompts/templates', {
        method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'T', body }),
      }));
      expect(template.status).toBe(201);
      setTextModelProviderForTests(fake([
        { op: 'createDimension', name: 'Genre', tags: ['Fantasy', 'Modern'] },
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },
        { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
      ]));
      const proposal = await infer(app, 'alice');
      const result = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
        method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId: proposal.proposalId, acceptedBundleKeys: proposal.proposal.bundles.map((b) => b.key) }),
      }));
      expect(result.status).toBe(commented ? 200 : 422);
      if (!commented) expect((await getLibrary(app, 'alice')).dimensions).toEqual([]);
    });
  }

  test('applies accepted bundle; preserves unmentioned options/tags; option UUIDs stable', async () => {
    setTextModelProviderForTests(fake([
      { op: 'createDimension', name: 'Franchise', tags: ['Warhammer'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Franchise', label: 'Warhammer' }] },
    ]));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';
    await seedPromptUser(app, userId, { lists: [{ name: 'Races', options: ['Orc', 'Human'] }] });
    const before = await getLibrary(app, userId);
    const orcIdBefore = req(req(before.variableLists[0]).options.find((o) => o.value === 'Orc')).id;
    const prop = await infer(app, userId);
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: prop.proposalId, acceptedBundleKeys: ['create:Franchise'] }),
    }));
    expect(res.status).toBe(200);
    const after = await res.json() as PromptLibraryResponse;
    expect(after.dimensions.find((d) => d.name === 'Franchise')).toBeTruthy();
    const orc = req(req(after.variableLists[0]).options.find((o) => o.value === 'Orc'));
    expect(orc.id).toBe(orcIdBefore);
    expect(req(after.variableLists[0]).options.find((o) => o.value === 'Human')).toBeTruthy();
    const fTag = req(req(after.dimensions.find((d) => d.name === 'Franchise')).tags[0]).id;
    expect(orc.tagIds).toContain(fTag);
  });

  test('drift -> 409', async () => {
    setTextModelProviderForTests(fake([{ op: 'createDimension', name: 'X', tags: ['a'] }]));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';
    await seedPromptUser(app, userId, { lists: [{ name: 'L', options: ['v'] }] });
    const prop = await infer(app, userId);
    await app.fetch(new Request('http://local/api/prompts/dimensions', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Drifter' }),
    }));
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: prop.proposalId, acceptedBundleKeys: ['create:X'] }),
    }));
    expect(res.status).toBe(409);
  });

  test('unknown/expired proposalId -> 410', async () => {
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';
    await seedPromptUser(app, userId, { lists: [] });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: crypto.randomUUID(), acceptedBundleKeys: ['x'] }),
    }));
    expect(res.status).toBe(410);
  });

  test('dimension-limit guard fires BEFORE any insert (no rollback needed; precondition test)', async () => {
    // Pre-existing test renamed to reflect what it actually exercises: the
    // ApplyLimitError preflight at countDimensions() >= MAX_TAG_DIMENSIONS
    // throws before any INSERT runs, so this is a precondition-guard test,
    // not a rollback test. The real rollback semantics are exercised below.
    setTextModelProviderForTests(fake([{ op: 'createDimension', name: 'X', tags: ['a'] }]));
    const { app, config } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';
    const list = await createList(app, userId, 'L');
    const keepRes = await app.fetch(new Request('http://local/api/prompts/dimensions', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Keep' }),
    }));
    expect(keepRes.status).toBe(201);
    const keep = await keepRes.json() as { id: string };
    const tagRes = await app.fetch(new Request(`http://local/api/prompts/dimensions/${keep.id}/tags`, {
      method: 'PUT',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [{ label: 'tagged', sortOrder: 0 }] }),
    }));
    expect(tagRes.status).toBe(200);
    const keepDim = await tagRes.json() as { tags: { id: string }[] };
    const keepTag = req(keepDim.tags[0]).id;
    const optionRes = await app.fetch(new Request(`http://local/api/prompts/lists/${list.id}/options`, {
      method: 'PUT',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: [{ value: 'v', sortOrder: 0, tagIds: [keepTag] }] }),
    }));
    expect(optionRes.status).toBe(200);
    for (let i = 1; i < config.MAX_TAG_DIMENSIONS; i += 1) {
      const res = await app.fetch(new Request('http://local/api/prompts/dimensions', {
        method: 'POST',
        headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `D${i}` }),
      }));
      expect(res.status).toBe(201);
    }
    const before = await getLibrary(app, userId);
    const beforeTags = req(req(before.variableLists[0]).options[0]).tagIds;
    const prop = await infer(app, userId);
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: prop.proposalId, acceptedBundleKeys: ['create:X'] }),
    }));
    expect(res.status).toBe(409);
    const after = await getLibrary(app, userId);
    expect(after.dimensions.some((d) => d.name === 'X')).toBe(false);
    expect(req(req(after.variableLists[0]).options[0]).tagIds).toEqual(beforeTags);
  });

  test('mid-transaction failure rolls back an already-inserted createDimension (F-J real rollback)', async () => {
    // Two ops, two bundles, both accepted. The createDimension SUCCEEDS first
    // (writing N1 into tag_dimensions). The addTags then exceeds
    // MAX_TAGS_PER_DIMENSION on the pre-seeded dim D and throws
    // ApplyLimitError mid-transaction. db.transaction(...) must roll back
    // the N1 insert — otherwise the user sees a 409 and a half-applied state.
    const { app, config } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';
    // Seed D with MAX_TAGS_PER_DIMENSION - 1 tags so adding two more throws
    // on the SECOND insert (not the first) — guaranteeing one insert has
    // already committed inside the transaction before the throw.
    const dRes = await app.fetch(new Request('http://local/api/prompts/dimensions', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'D' }),
    }));
    expect(dRes.status).toBe(201);
    const dDim = await dRes.json() as { id: string };
    const seedTags = Array.from({ length: config.MAX_TAGS_PER_DIMENSION - 1 }, (_, i) => ({
      label: `t${i}`, sortOrder: i,
    }));
    const seedRes = await app.fetch(new Request(`http://local/api/prompts/dimensions/${dDim.id}/tags`, {
      method: 'PUT',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: seedTags }),
    }));
    expect(seedRes.status).toBe(200);

    setTextModelProviderForTests(fake([
      { op: 'createDimension', name: 'N1', tags: ['only'] },
      { op: 'addTags', dimIdx: 0, tags: ['overflow1', 'overflow2'] },
    ]));
    const prop = await infer(app, userId);
    // The create bundle MUST be accepted alongside extend:D so they execute
    // in one transaction.
    const allKeys = prop.proposal.bundles.map((b) => b.key);
    expect(allKeys).toContain('create:N1');
    expect(allKeys.some((k) => k.startsWith('extend:'))).toBe(true);

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: prop.proposalId, acceptedBundleKeys: allKeys }),
    }));
    expect(res.status).toBe(409); // ApplyLimitError surfaces as 409

    const after = await getLibrary(app, userId);
    // ROLLBACK: N1 must NOT exist — the createDimension insert was committed
    // mid-transaction but the addTags failure rolled the whole thing back.
    expect(after.dimensions.some((d) => d.name === 'N1')).toBe(false);
    // D's tag count is unchanged (no partial overflow tag landed).
    const dAfter = req(after.dimensions.find((d) => d.name === 'D'));
    expect(dAfter.tags.length).toBe(config.MAX_TAGS_PER_DIMENSION - 1);
  });

  test('coherence 422 names the failing templates so the toast is actionable', async () => {
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';
    // Two single-option lists referenced by a template that combines them.
    // Tag the two options on the same dimension with disjoint tags so the
    // template becomes unsatisfiable when the proposal is applied.
    await seedPromptUser(app, userId, {
      lists: [
        { name: 'Roles', options: ['paladin'] },
        { name: 'Outfits', options: ['bikini'] },
      ],
    });
    const templateRes = await app.fetch(new Request('http://local/api/prompts/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ name: 'Scene', body: 'a {{var::Roles}} wears {{var::Outfits}}' }),
    }));
    expect(templateRes.status).toBe(201);

    setTextModelProviderForTests(fake([
      { op: 'createDimension', name: 'Genre', tags: ['Fantasy', 'Modern'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
      { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },
    ]));
    const prop = await infer(app, userId);
    const allKeys = prop.proposal.bundles.map((b) => b.key);

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: prop.proposalId, acceptedBundleKeys: allKeys }),
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; code: string; templates: string[] };
    expect(body.code).toBe('coherence');
    expect(body.templates).toEqual(['Scene']);
    expect(body.error).toContain('Scene');
    expect(body.error.toLowerCase()).toContain('apply anyway');
  });

  // Task 8: per-template apply gate + legacy overrideCoherence compat shim
  async function seedUnsatisfiableScene(
    app: ReturnType<typeof testRuntime>['app'],
    userId: string,
  ): Promise<{ proposalId: string; allKeys: string[] }> {
    // Mirrors the 'coherence 422' setup: two single-option lists joined by a
    // template; the proposal tags them with disjoint Genre tags so the
    // template becomes unsatisfiable.
    await seedPromptUser(app, userId, {
      lists: [
        { name: 'Roles', options: ['paladin'] },
        { name: 'Outfits', options: ['bikini'] },
      ],
    });
    const templateRes = await app.fetch(new Request('http://local/api/prompts/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ name: 'Scene', body: 'a {{var::Roles}} wears {{var::Outfits}}' }),
    }));
    expect(templateRes.status).toBe(201);
    setTextModelProviderForTests(fake([
      { op: 'createDimension', name: 'Genre', tags: ['Fantasy', 'Modern'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
      { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },
    ]));
    const prop = await infer(app, userId);
    return { proposalId: prop.proposalId, allKeys: prop.proposal.bundles.map((b) => b.key) };
  }

  test('apply with acceptUnsatisfiableTemplates ships partial despite a failing template', async () => {
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';
    const { proposalId, allKeys } = await seedUnsatisfiableScene(app, userId);
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId,
        acceptedBundleKeys: allKeys,
        acceptUnsatisfiableTemplates: ['Scene'],
      }),
    }));
    expect(res.status).toBe(200);
    // Apply landed: the new dimension exists in the live library.
    const after = await getLibrary(app, userId);
    expect(after.dimensions.some((d) => d.name === 'Genre')).toBe(true);
  });

  test('apply with legacy overrideCoherence:true expands to all failing templates and warn-logs', async () => {
    const { app, logs } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice', LOG_LEVEL: 'warn' });
    const userId = 'alice';
    const { proposalId, allKeys } = await seedUnsatisfiableScene(app, userId);
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId,
        acceptedBundleKeys: allKeys,
        overrideCoherence: true,
      }),
    }));
    expect(res.status).toBe(200);
    const after = await getLibrary(app, userId);
    expect(after.dimensions.some((d) => d.name === 'Genre')).toBe(true);
    // Warn-level log emitted with the legacy-override event marker.
    const matched = logs.find((line) => line.includes('apply_dimensions_legacy_override'));
    expect(matched).toBeTruthy();
  });

  test('apply 422s when failing template not in acceptUnsatisfiableTemplates', async () => {
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';
    const { proposalId, allKeys } = await seedUnsatisfiableScene(app, userId);
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId,
        acceptedBundleKeys: allKeys,
        acceptUnsatisfiableTemplates: ['Other'],
      }),
    }));
    expect(res.status).toBe(422);
    const body = await res.json() as { code: string; templates: string[] };
    expect(body.code).toBe('coherence');
    expect(body.templates).toEqual(['Scene']);
    const after = await getLibrary(app, userId);
    expect(after.dimensions.some((d) => d.name === 'Genre')).toBe(false);
  });

  test('apply drops free-form template names from acceptUnsatisfiableTemplates and warn-logs', async () => {
    // M2: the acceptUnsat list arrives client-supplied. Names not matching
    // any known conflict (neither stored.conflicts nor live warnings) are
    // dropped before the unaccepted-check so a stale or malicious client
    // cannot bypass the gate by inventing template names. The drop is
    // logged for telemetry; behaviour should match passing only the known
    // entry.
    const { app, logs } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice', LOG_LEVEL: 'warn' });
    const userId = 'alice';
    const { proposalId, allKeys } = await seedUnsatisfiableScene(app, userId);
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId,
        acceptedBundleKeys: allKeys,
        acceptUnsatisfiableTemplates: ['Scene', 'NotARealTemplate'],
      }),
    }));
    // Behaviour matches ['Scene'] only — apply succeeds despite the unknown
    // entry, because the unknown one is dropped before the gate.
    expect(res.status).toBe(200);
    const after = await getLibrary(app, userId);
    expect(after.dimensions.some((d) => d.name === 'Genre')).toBe(true);
    // Warn-log emitted for the dropped name.
    const matched = logs.find((line) => line.includes('apply_dimensions_unknown_template_in_accept'));
    expect(matched).toBeTruthy();
    expect(matched).toContain('NotARealTemplate');
  });

  test('apply ignores overrideCoherence when acceptUnsatisfiableTemplates already covers the template', async () => {
    const { app, logs } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice', LOG_LEVEL: 'warn' });
    const userId = 'alice';
    const { proposalId, allKeys } = await seedUnsatisfiableScene(app, userId);
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalId,
        acceptedBundleKeys: allKeys,
        acceptUnsatisfiableTemplates: ['Scene'],
        overrideCoherence: true,
      }),
    }));
    expect(res.status).toBe(200);
    const after = await getLibrary(app, userId);
    expect(after.dimensions.some((d) => d.name === 'Genre')).toBe(true);
    // Compat shim still warn-logs because legacy boolean was present, but the
    // expansion is a no-op for the already-covered template (no dupes).
    const matched = logs.find((line) => line.includes('apply_dimensions_legacy_override'));
    expect(matched).toBeTruthy();
  });
});

test('single-wave assignment before rename is diagnosed and blocked by the production apply gate', async () => {
  const { app, db } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
  await seedPromptUser(app, 'alice', { lists: [{ name: 'L0', options: ['O'] }, { name: 'L1', options: ['P'] }] });
  const before = await getLibrary(app, 'alice');
  db.query('INSERT INTO tag_dimensions (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run('ordered-axis', 'alice', 'A', 1);
  for (const [index, label] of ['x', 'y'].entries()) {
    db.query('INSERT INTO dimension_tags (id, user_id, dimension_id, label, sort_order) VALUES (?, ?, ?, ?, ?)')
      .run(`ordered-${label}`, 'alice', 'ordered-axis', label, index);
  }
  for (const list of before.variableLists) {
    db.query("INSERT INTO option_tags (option_id, tag_id, polarity) VALUES (?, ?, 'require')").run(req(list.options[0]).id, 'ordered-x');
  }
  expect((await app.fetch(new Request('http://local/api/prompts/templates', {
    method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Scene', body: '{{var::L0}} {{var::L1}}' }),
  }))).status).toBe(201);
  setTextModelProviderForTests(fake([
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'A', label: 'y' }] },
    { op: 'renameDimension', dimIdx: 0, newName: 'X' },
  ]));
  const proposal = await infer(app, 'alice');
  expect(proposal.warnings.length).toBeGreaterThan(0);
  const acceptedBundleKeys = proposal.proposal.bundles.map((bundle) => bundle.key);
  const diagnosis = await app.fetch(new Request('http://local/api/prompts/dimensions/diagnose-selection', {
    method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: proposal.proposalId, acceptedBundleKeys }),
  }));
  expect(diagnosis.status).toBe(200);
  expect((await diagnosis.json() as { conflicts: { templateName: string }[] }).conflicts.map((c) => c.templateName)).toContain('Scene');
  const apply = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
    method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: proposal.proposalId, acceptedBundleKeys }),
  }));
  expect(apply.status).toBe(422);
  const after = await getLibrary(app, 'alice');
  expect(after.dimensions[0]?.name).toBe('A');
  expect(after.variableLists[0]?.options[0]?.tagIds).toEqual(['ordered-x']);
});

for (const spaced of [false, true]) {
  test(`single-wave partial apply preserves ${spaced ? 'spaced tag identities' : 'reciprocal multi-axis dependencies'}`, async () => {
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    await seedPromptUser(app, 'alice', { lists: [{ name: 'L', options: ['O'] }] });
    const first = spaced ? { dimName: 'Hair color', label: 'dark brown' } : { dimName: 'A', label: 'x' };
    const second = spaced ? { dimName: 'Hair', label: 'color dark brown' } : { dimName: 'B', label: 'y' };
    setTextModelProviderForTests(fake([
      { op: 'createDimension', name: first.dimName, tags: [first.label] },
      { op: 'createDimension', name: second.dimName, tags: [second.label] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: spaced ? [first] : [first, second] },
      ...(!spaced ? [{ op: 'assignOptionTags' as const, listIdx: 0, optionIdx: 0, tags: [second, first] }] : []),
    ]));
    const proposal = await infer(app, 'alice');
    expect(proposal.rejected).toEqual([]);
    const response = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
      method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: proposal.proposalId, acceptedBundleKeys: [`create:${first.dimName}`] }),
    }));
    expect(response.status).toBe(200);
    const after = await response.json() as PromptLibraryResponse;
    expect(after.dimensions.map((d) => d.name)).toEqual(spaced ? ['Hair color'] : ['A', 'B']);
    expect(after.variableLists[0]?.options[0]?.tagIds.slice().sort())
      .toEqual(after.dimensions.flatMap((d) => d.tags.map((tag) => tag.id)).sort());
  });
}

test('partial rename selection includes the earlier rename that freed its destination', async () => {
  const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
  await seedPromptUser(app, 'alice', { lists: [{ name: 'L', options: ['O'] }] });
  const ids: string[] = [];
  for (const name of ['A', 'B']) {
    const response = await app.fetch(new Request('http://local/api/prompts/dimensions', {
      method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    }));
    expect(response.status).toBe(201);
    ids.push((await response.json() as { id: string }).id);
  }
  setTextModelProviderForTests(fake([
    { op: 'renameDimension', dimIdx: 0, newName: 'X' },
    { op: 'renameDimension', dimIdx: 1, newName: 'A' },
  ]));
  const proposal = await infer(app, 'alice');
  const response = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
    method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: proposal.proposalId, acceptedBundleKeys: [`rename:${req(ids[1])}`] }),
  }));
  expect(response.status).toBe(200);
  const after = await response.json() as PromptLibraryResponse;
  expect(after.dimensions.find((d) => d.id === ids[0])?.name).toBe('X');
  expect(after.dimensions.find((d) => d.id === ids[1])?.name).toBe('A');
});

test('production merge apply skips collapsed inherited cycles and writes hierarchy accepted by normal tag replacement', async () => {
  const { app, db } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
  await seedPromptUser(app, 'alice', { lists: [{ name: 'L', options: ['O'] }] });
  const source = crypto.randomUUID();
  const target = crypto.randomUUID();
  for (const [id, name] of [[source, 'A'], [target, 'B']]) {
    db.query('INSERT INTO tag_dimensions (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run(id ?? '', 'alice', name ?? '', 1);
  }
  let parentId: string | null = null;
  for (const [index, label] of ['p', 'c', 'g'].entries()) {
    const id = crypto.randomUUID();
    db.query('INSERT INTO dimension_tags (id, user_id, dimension_id, label, sort_order, parent_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'alice', source, label, index, parentId);
    parentId = id;
  }
  setTextModelProviderForTests(fake([{ op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: { p: 'x', c: 'y', g: 'x' } }]));
  const proposal = await infer(app, 'alice');
  const applied = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
    method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: proposal.proposalId, acceptedBundleKeys: [`merge:${source}`] }),
  }));
  expect(applied.status).toBe(200);
  const library = await applied.json() as PromptLibraryResponse;
  const dimension = req(library.dimensions[0]);
  const x = req(dimension.tags.find((t) => t.label === 'x'));
  const y = req(dimension.tags.find((t) => t.label === 'y'));
  expect(x.parentId).toBeUndefined();
  expect(y.parentId).toBe(x.id);
  const replaced = await app.fetch(new Request(`http://local/api/prompts/dimensions/${dimension.id}/tags`, {
    method: 'PUT', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: dimension.tags.map((tag) => ({ id: tag.id, label: tag.label, sortOrder: tag.sortOrder, parentId: tag.parentId ?? null })) }),
  }));
  expect(replaced.status).toBe(200);
});

test('apply gate and persisted SAT agree for gapped tags through chained hierarchy merges', async () => {
  const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
  await seedPromptUser(app, 'alice', { lists: [{ name: 'L0', options: ['O'] }, { name: 'L1', options: ['P'] }] });
  const ids: string[] = [];
  for (const name of ['A', 'B', 'C']) {
    const response = await app.fetch(new Request('http://local/api/prompts/dimensions', {
      method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    }));
    expect(response.status).toBe(201);
    ids.push((await response.json() as { id: string }).id);
  }
  const tagged: PromptLibraryResponse['dimensions'][number][] = [];
  for (const [index, labels] of [['a', 'ca'], ['b', 'cb'], ['Bparent']].entries()) {
    const initial = await app.fetch(new Request(`http://local/api/prompts/dimensions/${req(ids[index])}/tags`, {
      method: 'PUT', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: labels.map((label, position) => ({ label, sortOrder: (index === 1 ? 100 : 0) + position })) }),
    }));
    expect(initial.status).toBe(200);
    const dimension = await initial.json() as PromptLibraryResponse['dimensions'][number];
    // Reuse persisted IDs when supplying the hierarchy through the normal route.
    const parentId = req(dimension.tags[0]).id;
    const nested = await app.fetch(new Request(`http://local/api/prompts/dimensions/${req(ids[index])}/tags`, {
      method: 'PUT', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: dimension.tags.map((tag, position) => ({ id: tag.id, label: tag.label,
        sortOrder: (index === 1 ? 100 : 0) + position, parentId: position ? parentId : null })) }),
    }));
    expect(nested.status).toBe(200);
    tagged.push(await nested.json() as PromptLibraryResponse['dimensions'][number]);
  }
  const library = await getLibrary(app, 'alice');
  for (const [index, list] of library.variableLists.entries()) {
    const tagId = index === 0 ? tagged[1]?.tags[1]?.id : tagged[2]?.tags[0]?.id;
    const response = await app.fetch(new Request(`http://local/api/prompts/lists/${list.id}/options`, {
      method: 'PUT', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ options: list.options.map((option) => ({ id: option.id, value: option.value, sortOrder: option.sortOrder, tagIds: [req(tagId)] })) }),
    }));
    expect(response.status).toBe(200);
  }
  expect((await app.fetch(new Request('http://local/api/prompts/templates', {
    method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Scene', body: '{{var::L0}} {{var::L1}}' }),
  }))).status).toBe(201);
  setTextModelProviderForTests(fake([
    { op: 'mergeDimensions', fromIdx: 0, intoIdx: 1, tagMap: {} },
    { op: 'mergeDimensions', fromIdx: 1, intoIdx: 2, tagMap: { a: 'Aparent', ca: 'child', b: 'Bparent', cb: 'child' } },
  ]));
  const proposal = await infer(app, 'alice');
  expect(proposal.warnings).toEqual([]);
  const applied = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
    method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: proposal.proposalId, acceptedBundleKeys: [`merge:${req(ids[1])}`] }),
  }));
  expect(applied.status).toBe(200);
  const after = await applied.json() as PromptLibraryResponse;
  const surviving = req(after.dimensions[0]);
  expect(surviving.tags.find((tag) => tag.label === 'child')?.parentId).toBe(surviving.tags.find((tag) => tag.label === 'Bparent')?.id);
  expect(templateSatisfiable(['L0', 'L1'], toLibrarySnapshot(after))).toBe(true);
});

test('accepting one costly UNSAT template does not require overriding a later SAT template', async () => {
  const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice', MAX_TAG_DIMENSIONS: '100' });
  await seedPromptUser(app, 'alice', { lists: [
    { name: 'A', options: ['a'] }, { name: 'B', options: ['b'] }, { name: 'Empty', options: [] },
  ] });
  for (const [name, body] of [['Early UNSAT', '{{var::A}}{{var::Empty}}'], ['Later SAT', '{{var::A}}{{var::B}}']]) {
    const created = await app.fetch(new Request('http://local/api/prompts/templates', {
      method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' }, body: JSON.stringify({ name, body }),
    }));
    expect(created.status).toBe(201);
  }
  setTextModelProviderForTests(fake(Array.from({ length: 40 }, (_, index) => ({
    op: 'createDimension', name: `D${index}`, tags: ['a', 'b'],
  }))));
  const proposal = await infer(app, 'alice');
  const applied = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
    method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: proposal.proposalId, acceptedBundleKeys: proposal.proposal.bundles.map((bundle) => bundle.key),
      acceptUnsatisfiableTemplates: ['Early UNSAT'] }),
  }));
  expect(applied.status).toBe(200);
  expect((await applied.json() as PromptLibraryResponse).dimensions).toHaveLength(40);
});
