import { afterEach, describe, expect, test } from 'bun:test';
import { setTextModelProviderForTests } from '../providers/text/registry';
import type { PromptLibraryResponse, VariableList } from '@atelier/shared';
import { type RescueDimensionArgs, type TestCliproxyTextProvider } from '../providers/cliproxyText';
import { parseInferDone, parseSse, testRuntime } from '../test/helpers';
import type { RawInferOp } from '../prompts/inferTypes';
import { putProposal, takeProposalForUser } from '../prompts/proposalStore';
import { snapshotHash, templatesDigest, toLibrarySnapshot } from '../prompts/librarySnapshot';
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

interface RescueProviderShape {
  readonly infer: readonly RawInferOp[];
  readonly rescueOp?: RawInferOp;
  readonly rescueFailed?: { kind: 'transient' | 'permanent'; detail: string };
  readonly captured?: RescueDimensionArgs[];
  readonly rescueCallCount?: { n: number };
}

function fakeProvider(shape: RescueProviderShape): TestCliproxyTextProvider {
  return {
    enhance: emptyEnhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [...shape.infer] }),
    inferTaxonomy: () => Promise.resolve({ type: 'ok', ops: [...shape.infer] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [...shape.infer] }),
    rescueDimension: (args: RescueDimensionArgs) => {
      if (shape.captured) shape.captured.push(args);
      if (shape.rescueCallCount) shape.rescueCallCount.n += 1;
      if (shape.rescueFailed) {
        return Promise.resolve({ type: 'failed', kind: shape.rescueFailed.kind, status: null, detail: shape.rescueFailed.detail });
      }
      return Promise.resolve({ type: 'ok', ops: shape.rescueOp ? [shape.rescueOp] : [] });
    },
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

async function createTemplate(
  app: ReturnType<typeof testRuntime>['app'],
  userId: string,
  name: string,
  body: string,
): Promise<void> {
  const res = await app.fetch(new Request('http://local/api/prompts/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({ name, body }),
  }));
  expect(res.status).toBe(201);
}

async function getLibrary(
  app: ReturnType<typeof testRuntime>['app'],
  userId: string,
): Promise<PromptLibraryResponse> {
  const res = await app.fetch(new Request('http://local/api/prompts', {
    headers: { 'Remote-User': userId },
  }));
  expect(res.status).toBe(200);
  return await res.json() as PromptLibraryResponse;
}

interface InferShape {
  readonly proposalId: string;
  readonly baseSnapshotHash: string;
  readonly proposal: { bundles: { key: string }[] };
  readonly conflicts: { templateName: string }[];
}

async function infer(
  app: ReturnType<typeof testRuntime>['app'],
  userId: string,
): Promise<InferShape> {
  const res = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
    method: 'POST',
    headers: { 'Remote-User': userId },
  }));
  expect(res.status).toBe(200);
  return await parseInferDone<InferShape>(res);
}

// Reusable scene fixture: a `Scene` template references two single-option lists
// (Roles + Outfits); the AI proposal tags them on disjoint Genre tags so the
// template becomes unsatisfiable. This produces a single conflict on `Scene`.
async function setupUnsatisfiableScene(
  appFactory: () => ReturnType<typeof testRuntime>,
  rescueOp?: RawInferOp,
  options?: { extraLists?: { name: string; options: string[] }[]; extraTemplate?: { name: string; body: string } },
): Promise<{
  app: ReturnType<typeof testRuntime>['app'];
  userId: string;
  proposalId: string;
  conflictTemplate: string;
  captured: RescueDimensionArgs[];
  rescueCallCount: { n: number };
}> {
  const userId = 'alice';
  const captured: RescueDimensionArgs[] = [];
  const rescueCallCount = { n: 0 };
  const ops: RawInferOp[] = [
    { op: 'createDimension', name: 'Genre', tags: ['Fantasy', 'Modern'] },
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
    { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },
  ];
  setTextModelProviderForTests(fakeProvider({
    infer: ops,
    ...(rescueOp ? { rescueOp } : {}),
    captured,
    rescueCallCount,
  }));
  const runtime = appFactory();
  const { app } = runtime;
  await seedPromptUser(app, userId, {
    lists: [
      { name: 'Roles', options: ['paladin'] },
      { name: 'Outfits', options: ['bikini'] },
      ...(options?.extraLists ?? []),
    ],
  });
  await createTemplate(app, userId, 'Scene', 'a {{var::Roles}} wears {{var::Outfits}}');
  if (options?.extraTemplate) {
    await createTemplate(app, userId, options.extraTemplate.name, options.extraTemplate.body);
  }
  const prop = await infer(app, userId);
  return { app, userId, proposalId: prop.proposalId, conflictTemplate: 'Scene', captured, rescueCallCount };
}

describe('POST /api/prompts/dimensions/rescue', () => {
  for (const tags of [[], [{ dimName: 'Unknown', label: 'Unknown' }],
    [{ dimName: 'Genre', label: 'Modern' }, { dimName: 'Genre', label: 'Unknown' }],
    [{ dimName: '', label: 'Modern' }]]) {
    test(`rejects an invalid whole rescue tag bag ${JSON.stringify(tags)} and commits spent state`, async () => {
      const { app, userId, proposalId } = await setupUnsatisfiableScene(
        () => testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' }),
        { op: 'addOption', listIdx: 0, value: 'bridge', tags },
      );
      const response = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
        method: 'POST', headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId, templateName: 'Scene' }),
      }));
      expect(response.status).toBe(200);
      const frames = await parseSse(response);
      expect(frames.some((frame) => frame.event === 'done')).toBe(false);
      expect(frames.at(-1)).toMatchObject({ event: 'rescue-failed', data: { reason: 'upstream-error' } });
      const stored = takeProposalForUser(proposalId, userId);
      if (!stored) throw new Error('proposal missing');
      expect(stored.conflicts[0]?.rescueAttempted).toBe(true);
      expect(stored.rawBundles.some((bundle) => bundle.key.startsWith('rescue:'))).toBe(false);
      expect((await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
        method: 'POST', headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId, templateName: 'Scene' }),
      }))).status).toBe(409);
    });
  }

  for (const supplier of ['create', 'add', 'rename', 'merge'] as const) {
    test(`accepting only rescue closes over its non-culprit ${supplier} supplier with actual keys`, async () => {
      const { app, db } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
      await seedPromptUser(app, 'alice', { lists: [{ name: 'Roles', options: ['paladin'] }, { name: 'Outfits', options: ['bikini'] }] });
      await createTemplate(app, 'alice', 'Scene', '{{var::Roles}} {{var::Outfits}}');
      const seedDim = (name: string, labels: string[]) => {
        const id = crypto.randomUUID();
        db.query('INSERT INTO tag_dimensions (id,user_id,name,created_at) VALUES (?,\'alice\',?,1)').run(id, name);
        for (const [index, label] of labels.entries()) db.query('INSERT INTO dimension_tags (id,user_id,dimension_id,label,sort_order) VALUES (?,\'alice\',?,?,?)')
          .run(crypto.randomUUID(), id, label, index);
      };
      if (supplier === 'add') seedDim('Aux', ['old']);
      if (supplier === 'rename' || supplier === 'merge') seedDim('Source', ['x']);
      if (supplier === 'merge') seedDim('Aux', []);
      const before = await getLibrary(app, 'alice');
      const snap = toLibrarySnapshot(before);
      const supplyOp: RawInferOp = supplier === 'create' ? { op: 'createDimension', name: 'Aux', tags: ['x'] }
        : supplier === 'add' ? { op: 'addTags', dimIdx: snap.dimensions.findIndex((d) => d.name === 'Aux'), tags: ['x'] }
          : supplier === 'rename' ? { op: 'renameDimension', dimIdx: snap.dimensions.findIndex((d) => d.name === 'Source'), newName: 'Aux' }
            : { op: 'mergeDimensions', fromIdx: snap.dimensions.findIndex((d) => d.name === 'Source'), intoIdx: snap.dimensions.findIndex((d) => d.name === 'Aux'), tagMap: {} };
      const rawBundles: RawBundle[] = [
        { key: 'actual culprit', dependsOn: [], opOrder: [0, 1, 2], ops: [
          { op: 'createDimension', name: 'Genre', tags: ['Fantasy', 'Modern'] },
          { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
          { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },
        ] },
        { key: `actual supplier ${supplier}`, dependsOn: [], opOrder: [3], ops: [supplyOp] },
        { key: 'unrelated', dependsOn: [], opOrder: [4], ops: [{ op: 'createDimension', name: 'Unrelated', tags: ['other'] }] },
      ];
      const proposalId = putProposal({ userId: 'alice', rawBundles, baseSnapshotHash: snapshotHash(snap),
        baseTemplateHash: templatesDigest(before.templates), expiresAt: Date.now() + 600_000,
        conflicts: [{ templateName: 'Scene', reason: 'disjoint Genre', culpritBundleKeys: ['actual culprit'], culpritKind: 'local', rescueAttempted: false }] });
      setTextModelProviderForTests(fakeProvider({ infer: [], rescueOp: { op: 'addOption', listIdx: 0,
        value: 'bridge', tags: [{ dimName: 'Genre', label: 'Modern' }, { dimName: 'Aux', label: 'x' }] } }));
      const frames = await parseSse(await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
        method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId, templateName: 'Scene' }),
      })));
      const done = frames.find((frame) => frame.event === 'done');
      if (!done) throw new Error('rescue result missing');
      const data = done.data as { rescueBundle: { key: string; dependsOn: string[] } };
      expect(data.rescueBundle.dependsOn).toContain(`actual supplier ${supplier}`);
      expect(data.rescueBundle.dependsOn).not.toContain('unrelated');
      const applied = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
        method: 'POST', headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId, acceptedBundleKeys: [data.rescueBundle.key] }),
      }));
      expect(applied.status).toBe(200);
      const library = await applied.json() as PromptLibraryResponse;
      const bridge = library.variableLists.find((list) => list.name === 'Roles')?.options.find((option) => option.value === 'bridge');
      expect(bridge?.tagIds).toHaveLength(2);
      expect(library.dimensions.find((dimension) => dimension.name === 'Aux')?.tags.some((tag) => tag.label === 'x')).toBe(true);
      expect(library.dimensions.some((dimension) => dimension.name === 'Unrelated')).toBe(false);
    });
  }
  test('returns rescue bundle on LLM success', async () => {
    // Roles=paladin (Fantasy), Outfits=bikini (Modern). pickRescueTargetList
    // picks Roles on tiebreak (both single-option, both viable, Roles first).
    // A bridging addOption on Roles tagged Modern pairs with bikini-Modern.
    // The route overrides `listIdx` to the picked target's idx, so the test's
    // listIdx field is irrelevant — we only care about value + tags.
    const rescueOp: RawInferOp = {
      op: 'addOption',
      listIdx: 0,
      value: 'business consultant',
      tags: [{ dimName: 'Genre', label: 'Modern' }],
    };
    const { app, userId, proposalId, conflictTemplate, captured } = await setupUnsatisfiableScene(
      () => testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' }),
      rescueOp,
    );
    const libBefore = await getLibrary(app, userId);
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, templateName: conflictTemplate }),
    }));
    expect(res.status).toBe(200);
    const frames = await parseSse(res);
    const done = frames.find((f) => f.event === 'done');
    expect(done).toBeTruthy();
    const data = done?.data as {
      rescueBundle: {
        kind: string;
        templateName: string;
        listName: string;
        optionValue: string;
        dependsOn: string[];
      };
      conflicts: { templateName: string; rescueAttempted: boolean }[];
    };
    expect(data.rescueBundle.kind).toBe('rescue');
    expect(data.rescueBundle.templateName).toBe('Scene');
    expect(data.rescueBundle.listName).toBe('Roles');
    expect(data.rescueBundle.optionValue).toBe('business consultant');
    // Conflict carries rescueAttempted flag flipped.
    expect(data.conflicts.find((c) => c.templateName === 'Scene')?.rescueAttempted).toBe(true);
    // DB is NOT mutated by rescue (the apply route does that).
    const libAfter = await getLibrary(app, userId);
    expect(libAfter).toEqual(libBefore);
    // Verify provider received the post-bundle preview snapshot (not the live DB).
    const seen = req(captured[0]);
    expect(seen.previewSnapshot.dimensions.find((d) => d.name === 'Genre')).toBeTruthy();
    expect(seen.targetListName).toBe('Roles');
  });

  test('409 on repeated call for same template (cap-spent)', async () => {
    const rescueOp: RawInferOp = {
      op: 'addOption',
      listIdx: 0,
      value: 'business consultant',
      tags: [{ dimName: 'Genre', label: 'Modern' }],
    };
    const { app, userId, proposalId, conflictTemplate, rescueCallCount } = await setupUnsatisfiableScene(
      () => testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' }),
      rescueOp,
    );
    const first = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, templateName: conflictTemplate }),
    }));
    expect(first.status).toBe(200);
    await first.text();
    const countAfterFirst = rescueCallCount.n;
    expect(countAfterFirst).toBe(1);

    const second = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, templateName: conflictTemplate }),
    }));
    expect(second.status).toBe(409);
    const body = await second.json() as { error: string; code?: string };
    expect(body.code).toBe('rescue-spent');
    // Verify no second LLM call.
    expect(rescueCallCount.n).toBe(countAfterFirst);
  });

  test('rescue-failed when LLM produces no satisfying option (cap consumed)', async () => {
    // Target list is Roles. Tag the new role as Fantasy — same as paladin —
    // so Roles is now [paladin (Fantasy), new (Fantasy)] but bikini is still
    // Modern, so paladin×bikini and new×bikini are both Fantasy↔Modern
    // conflicts → still unsat.
    const rescueOp: RawInferOp = {
      op: 'addOption',
      listIdx: 0,
      value: 'fantasy warrior',
      tags: [{ dimName: 'Genre', label: 'Fantasy' }],
    };
    const { app, userId, proposalId, conflictTemplate } = await setupUnsatisfiableScene(
      () => testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' }),
      rescueOp,
    );
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, templateName: conflictTemplate }),
    }));
    expect(res.status).toBe(200);
    const frames = await parseSse(res);
    const failed = frames.find((f) => f.event === 'rescue-failed');
    expect(failed).toBeTruthy();
    const failedData = failed?.data as { reason: string; conflicts: { templateName: string; rescueAttempted: boolean }[] };
    expect(failedData.reason).toBe('option-does-not-bridge-conflict');
    // Fix 3: rescue-failed payload propagates spent-cap state — conflicts
    // are included and the matching template has rescueAttempted:true.
    expect(failedData.conflicts).toBeTruthy();
    expect(failedData.conflicts.find((c) => c.templateName === conflictTemplate)?.rescueAttempted).toBe(true);

    // Cap consumed: second rescue call → 409.
    const second = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, templateName: conflictTemplate }),
    }));
    expect(second.status).toBe(409);
  });

  test('branch-aware: a {{random}} conflict in ONE branch is rescued (flat union would falsely reject)', async () => {
    // Mixed = {{random:: a Roles wears Outfits :: just a Capes}}.
    //   Branch 0 (Roles×Outfits): paladin(Fantasy) × bikini(Modern) → conflict.
    //   Branch 1 (Capes alone): <2 occurrences → never conflicts.
    // The rescue adds a Modern role, satisfying branch 0. The FLAT occurrence
    // union [Roles, Outfits, Capes] stays UNSAT after the rescue because
    // cape(Fantasy) conflicts with the now-forced Modern role — so the pre-fix
    // flat path reported option-does-not-bridge-conflict and burned the one-shot
    // cap. Branch-scoping to inBranch=0 checks only [Roles, Outfits] → rescue lands.
    const userId = 'alice';
    const captured: RescueDimensionArgs[] = [];
    const rescueCallCount = { n: 0 };
    const ops: RawInferOp[] = [
      { op: 'createDimension', name: 'Genre', tags: ['Fantasy', 'Modern'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] }, // paladin
      { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },  // bikini
      { op: 'assignOptionTags', listIdx: 2, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] }, // cape
    ];
    const rescueOp: RawInferOp = {
      op: 'addOption', listIdx: 0, value: 'consultant', tags: [{ dimName: 'Genre', label: 'Modern' }],
    };
    setTextModelProviderForTests(fakeProvider({ infer: ops, rescueOp, captured, rescueCallCount }));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    await seedPromptUser(app, userId, {
      lists: [
        { name: 'Roles', options: ['paladin'] },
        { name: 'Outfits', options: ['bikini'] },
        { name: 'Capes', options: ['cape'] },
      ],
    });
    await createTemplate(app, userId, 'Mixed', '{{random::a {{var::Roles}} wears {{var::Outfits}}::just a {{var::Capes}}}}');
    const prop = await infer(app, userId);
    expect(prop.conflicts.some((c) => c.templateName === 'Mixed')).toBe(true);

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: prop.proposalId, templateName: 'Mixed' }),
    }));
    expect(res.status).toBe(200);
    const frames = await parseSse(res);
    const done = frames.find((f) => f.event === 'done');
    expect(done).toBeTruthy();
    const data = done?.data as { rescueBundle: { listName: string; optionValue: string; templateName: string } };
    expect(data.rescueBundle.templateName).toBe('Mixed');
    expect(data.rescueBundle.listName).toBe('Roles');
    expect(data.rescueBundle.optionValue).toBe('consultant');
    // pickRescueTargetList saw only the branch-0 occurrences (Roles, Outfits).
    expect(req(captured[0]).targetListName).toBe('Roles');
  });

  test('branch-aware: a {{random}} with TWO broken branches is NOT falsely accepted when only one is fixed', async () => {
    // Double = {{random:: Roles×Outfits :: Hats×Boots}} — BOTH branches conflict
    // (Fantasy×Modern each). Diagnosis records only the first failing branch
    // (inBranch=0), so target selection aims at branch 0 (Roles/Outfits). The
    // LLM bridges branch 0 only. A branch-SCOPED 13.c would pass (branch 0 now
    // satisfiable) and emit `done` — falsely claiming a fix while branch 1 stays
    // broken AND spending the one-shot cap. The whole-template branch-aware 13.c
    // check must reject this → rescue-failed.
    const userId = 'alice';
    const captured: RescueDimensionArgs[] = [];
    const rescueCallCount = { n: 0 };
    const ops: RawInferOp[] = [
      { op: 'createDimension', name: 'Genre', tags: ['Fantasy', 'Modern'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] }, // paladin
      { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },  // bikini
      { op: 'assignOptionTags', listIdx: 2, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] }, // fedora
      { op: 'assignOptionTags', listIdx: 3, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },  // clogs
    ];
    const rescueOp: RawInferOp = {
      op: 'addOption', listIdx: 0, value: 'consultant', tags: [{ dimName: 'Genre', label: 'Modern' }],
    };
    setTextModelProviderForTests(fakeProvider({ infer: ops, rescueOp, captured, rescueCallCount }));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    await seedPromptUser(app, userId, {
      lists: [
        { name: 'Roles', options: ['paladin'] },
        { name: 'Outfits', options: ['bikini'] },
        { name: 'Hats', options: ['fedora'] },
        { name: 'Boots', options: ['clogs'] },
      ],
    });
    await createTemplate(app, userId, 'Double', '{{random::a {{var::Roles}} wears {{var::Outfits}}::a {{var::Hats}} with {{var::Boots}}}}');
    const prop = await infer(app, userId);
    expect(prop.conflicts.some((c) => c.templateName === 'Double')).toBe(true);

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: prop.proposalId, templateName: 'Double' }),
    }));
    expect(res.status).toBe(200);
    const frames = await parseSse(res);
    const failed = frames.find((f) => f.event === 'rescue-failed');
    expect(failed).toBeTruthy();
    expect((failed?.data as { reason: string }).reason).toBe('option-does-not-bridge-conflict');
    // Cap is spent even on this honest rejection (consumed before the LLM call).
    const second = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: prop.proposalId, templateName: 'Double' }),
    }));
    expect(second.status).toBe(409);
  });

  test('409 on snapshot drift', async () => {
    const rescueOp: RawInferOp = {
      op: 'addOption',
      listIdx: 0,
      value: 'business consultant',
      tags: [{ dimName: 'Genre', label: 'Modern' }],
    };
    const { app, userId, proposalId, conflictTemplate } = await setupUnsatisfiableScene(
      () => testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' }),
      rescueOp,
    );
    // Mutate the library: add a brand-new dimension to shift the snapshot hash.
    const drift = await app.fetch(new Request('http://local/api/prompts/dimensions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ name: 'Drifter' }),
    }));
    expect(drift.status).toBe(201);
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, templateName: conflictTemplate }),
    }));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toContain('library changed');
  });

  test('409 on template drift (body edit between infer and rescue)', async () => {
    // Fix 4: snapshotHash only fingerprints dimensions + lists. A template
    // rename or body edit between infer and rescue must also invalidate
    // the proposal — otherwise the stored conflict (diagnosed against the
    // OLD body) is wired to the NEW template state, producing mixed
    // old/new reasoning. Verified via parallel `templatesDigest` drift
    // guard.
    const rescueOp: RawInferOp = {
      op: 'addOption',
      listIdx: 0,
      value: 'business consultant',
      tags: [{ dimName: 'Genre', label: 'Modern' }],
    };
    const { app, userId, proposalId, conflictTemplate } = await setupUnsatisfiableScene(
      () => testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' }),
      rescueOp,
    );
    // Find the template id and PATCH its body. The body change must not
    // touch any list reference (still references {{var::Roles}} +
    // {{var::Outfits}}) so the conflict diagnosis would still be valid —
    // but we DEFENSIVELY refuse to serve the rescue because the template
    // state moved on.
    const libBefore = await getLibrary(app, userId);
    const template = libBefore.templates.find((t) => t.name === conflictTemplate);
    if (!template) throw new Error('expected Scene template in library');
    const patch = await app.fetch(new Request(`http://local/api/prompts/templates/${template.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ body: 'a {{var::Roles}} dramatically wears {{var::Outfits}}' }),
    }));
    expect(patch.status).toBe(200);
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, templateName: conflictTemplate }),
    }));
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toContain('templates changed');
  });

  test('cross-template check is non-blocking for a clean addOption', async () => {
    // addOption is structurally ADDITIVE — it cannot make a previously-
    // satisfiable template unsatisfiable (any existing combination still
    // works). The cross-template guard at step 13.d exists as defence in
    // depth: if a future op kind COULD destabilise a sibling template, the
    // guard would block it. This test exercises the code path with a
    // sibling template and verifies the rescue still succeeds.
    const rescueOp: RawInferOp = {
      op: 'addOption',
      listIdx: 0,
      value: 'business consultant',
      tags: [{ dimName: 'Genre', label: 'Modern' }],
    };
    const { app, userId, proposalId, conflictTemplate } = await setupUnsatisfiableScene(
      () => testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' }),
      rescueOp,
      {
        extraLists: [{ name: 'Era', options: ['1980s'] }],
        extraTemplate: { name: 'Period', body: 'a {{var::Outfits}} from the {{var::Era}}' },
      },
    );
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, templateName: conflictTemplate }),
    }));
    expect(res.status).toBe(200);
    const frames = await parseSse(res);
    expect(frames.find((f) => f.event === 'done')).toBeTruthy();
  });

  test('rescue-failed with reason no-target when no candidate list survives wildcard viability', async () => {
    // Three single-option lists A, B, C with two dimensions D1 and D2:
    //   A: D1=x, D2=p
    //   B: D1=y, D2=p  → conflicts with A on D1
    //   C: D1=x, D2=q  → conflicts with A on D2 and with B on both
    // No list-wildcard removes BOTH pairwise conflicts → pickRescueTargetList
    // returns { ok: false, reason: 'no-target' }. The route surfaces this as
    // SSE rescue-failed { reason: 'no-target' } and the cap is consumed.
    const userId = 'alice';
    setTextModelProviderForTests(fakeProvider({
      infer: [
        { op: 'createDimension', name: 'D1', tags: ['x', 'y'] },
        { op: 'createDimension', name: 'D2', tags: ['p', 'q'] },
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [
          { dimName: 'D1', label: 'x' }, { dimName: 'D2', label: 'p' },
        ] },
        { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [
          { dimName: 'D1', label: 'y' }, { dimName: 'D2', label: 'p' },
        ] },
        { op: 'assignOptionTags', listIdx: 2, optionIdx: 0, tags: [
          { dimName: 'D1', label: 'x' }, { dimName: 'D2', label: 'q' },
        ] },
      ],
      rescueOp: {
        op: 'addOption',
        listIdx: 0,
        value: 'should-not-be-applied',
        tags: [{ dimName: 'D1', label: 'x' }],
      },
    }));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    await seedPromptUser(app, userId, {
      lists: [
        { name: 'A', options: ['a'] },
        { name: 'B', options: ['b'] },
        { name: 'C', options: ['c'] },
      ],
    });
    await createTemplate(app, userId, 'Three', '{{var::A}} + {{var::B}} + {{var::C}}');
    const prop = await infer(app, userId);
    const threeConflict = prop.conflicts.find((c) => c.templateName === 'Three');
    expect(threeConflict).toBeTruthy();

    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: prop.proposalId, templateName: 'Three' }),
    }));
    expect(res.status).toBe(200);
    const frames = await parseSse(res);
    const failed = frames.find((f) => f.event === 'rescue-failed');
    expect(failed).toBeTruthy();
    const failedData = failed?.data as { reason: string; conflicts: { templateName: string; rescueAttempted: boolean }[] };
    expect(failedData.reason).toBe('no-target');
    // Fix 3: payload carries updated conflicts with rescueAttempted flipped.
    expect(failedData.conflicts.find((c) => c.templateName === 'Three')?.rescueAttempted).toBe(true);
  });

  test('rescue-failed when LLM returns an existing option value (duplicate guard)', async () => {
    // The model returns an addOption whose value is already on the picked
    // target list (Roles). The route MUST reject and emit option-already-exists.
    const rescueOp: RawInferOp = {
      op: 'addOption',
      listIdx: 0,
      value: 'paladin',
      tags: [{ dimName: 'Genre', label: 'Modern' }],
    };
    const { app, userId, proposalId, conflictTemplate } = await setupUnsatisfiableScene(
      () => testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' }),
      rescueOp,
    );
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, templateName: conflictTemplate }),
    }));
    expect(res.status).toBe(200);
    const frames = await parseSse(res);
    const failed = frames.find((f) => f.event === 'rescue-failed');
    expect(failed).toBeTruthy();
    const failedData = failed?.data as { reason: string; conflicts: { templateName: string; rescueAttempted: boolean }[] };
    expect(failedData.reason).toBe('option-already-exists');
    // Fix 3: payload carries updated conflicts with rescueAttempted flipped.
    expect(failedData.conflicts.find((c) => c.templateName === conflictTemplate)?.rescueAttempted).toBe(true);
  });

  test('rescue-failed when provider returns upstream error', async () => {
    setTextModelProviderForTests(fakeProvider({
      infer: [
        { op: 'createDimension', name: 'Genre', tags: ['Fantasy', 'Modern'] },
        { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
        { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },
      ],
      rescueFailed: { kind: 'transient', detail: 'upstream 503' },
    }));
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const userId = 'alice';
    await seedPromptUser(app, userId, {
      lists: [
        { name: 'Roles', options: ['paladin'] },
        { name: 'Outfits', options: ['bikini'] },
      ],
    });
    await createTemplate(app, userId, 'Scene', 'a {{var::Roles}} wears {{var::Outfits}}');
    const prop = await infer(app, userId);
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: prop.proposalId, templateName: 'Scene' }),
    }));
    expect(res.status).toBe(200);
    const frames = await parseSse(res);
    const failed = frames.find((f) => f.event === 'rescue-failed');
    expect(failed).toBeTruthy();
    const failedData = failed?.data as { reason: string; conflicts: { templateName: string; rescueAttempted: boolean }[] };
    expect(failedData.reason).toBe('upstream-error');
    // Fix 3: payload carries updated conflicts with rescueAttempted flipped.
    expect(failedData.conflicts.find((c) => c.templateName === 'Scene')?.rescueAttempted).toBe(true);
  });

  test('404 on unknown templateName for a valid proposal', async () => {
    const { app, userId, proposalId } = await setupUnsatisfiableScene(
      () => testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' }),
    );
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, templateName: 'no-such-template' }),
    }));
    // beginRescueAttempt succeeds (cap is spent on the unknown template) but
    // there's no recorded conflict — the route surfaces 404. This is a
    // deliberate cost: an attacker probing template names spends the cap
    // each try (per-user MAX_PROPOSALS_PER_USER ≪ enumeration target).
    expect(res.status).toBe(404);
  });

  test('pre-stream rescue validation failures do not keep proposals protected from cap eviction', async () => {
    const { MAX_PROPOSALS_PER_USER } = await import('../prompts/proposalStore');
    const { app, userId, proposalId } = await setupUnsatisfiableScene(
      () => testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' }),
    );
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId, templateName: 'no-such-template' }),
    }));
    expect(res.status).toBe(404);

    for (let i = 0; i < MAX_PROPOSALS_PER_USER; i++) {
      putProposal({ userId, rawBundles: [], baseSnapshotHash: `fresh-${i}`, expiresAt: 0 });
    }

    expect(takeProposalForUser(proposalId, userId)).toBeNull();
  });

  test('404 on unknown proposalId', async () => {
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: crypto.randomUUID(), templateName: 'Scene' }),
    }));
    expect(res.status).toBe(404);
  });

  test('non-allowlisted user gets 404 (gate)', async () => {
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': 'stranger', 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: crypto.randomUUID(), templateName: 'Scene' }),
    }));
    expect(res.status).toBe(404);
  });
});
