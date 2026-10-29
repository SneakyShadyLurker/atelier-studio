import { afterEach, expect, test } from 'bun:test';
import type { PromptLibraryResponse, RescueBundle, TemplateConflict, VariableList } from '@atelier/shared';
import { setCliproxyTextProviderForTests } from '../providers/cliproxyText';
import { parseInferDone, parseSse, testRuntime } from '../test/helpers';
import type { RawInferOp } from '../prompts/inferTypes';

afterEach(() => { setCliproxyTextProviderForTests(null); });

function req<T>(value: T | undefined, message = 'expected value'): T {
  if (value === undefined) throw new Error(message);
  return value;
}

async function* emptyEnhance(): AsyncGenerator<never, void, unknown> {
  await Promise.resolve();
  if (Date.now() < 0) yield undefined as never;
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

test('infer -> apply tags Orc=Warhammer / Orion=Star Trek; Human stays wildcard', async () => {
  setCliproxyTextProviderForTests({
    enhance: emptyEnhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [
      { op: 'createDimension', name: 'Franchise', tags: ['Warhammer', 'Star Trek'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Franchise', label: 'Warhammer' }] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 1, tags: [{ dimName: 'Franchise', label: 'Star Trek' }] },
    ] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
  });
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const userId = 'alice';
  await seedPromptUser(app, userId, { lists: [{ name: 'Races', options: ['Orc', 'Orion', 'Human'] }] });
  const inferRes = await app.fetch(new Request('http://local/api/prompts/dimensions/infer', {
    method: 'POST',
    headers: { 'Remote-User': userId },
  }));
  expect(inferRes.status).toBe(200);
  const prop = await parseInferDone<{ proposalId: string }>(inferRes);
  const res = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
    method: 'POST',
    headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: prop.proposalId, acceptedBundleKeys: ['create:Franchise'] }),
  }));
  expect(res.status).toBe(200);
  const lib = await res.json() as PromptLibraryResponse;
  const races = req(lib.variableLists[0]).options;
  const fTags = req(lib.dimensions.find((d) => d.name === 'Franchise')).tags;
  const wh = req(fTags.find((tag) => tag.label === 'Warhammer')).id;
  const st = req(fTags.find((tag) => tag.label === 'Star Trek')).id;
  expect(req(races.find((o) => o.value === 'Orc')).tagIds).toEqual([wh]);
  expect(req(races.find((o) => o.value === 'Orion')).tagIds).toEqual([st]);
  expect(req(races.find((o) => o.value === 'Human')).tagIds).toEqual([]);
});

// ─── Cross-template rescue + apply integration ─────────────────────────────
// Three scenarios covering end-to-end behaviour when the
// AI proposal creates one or more unsatisfiable templates and the user uses
// /rescue + /apply to ship a coherent library.

interface InferShape {
  readonly proposalId: string;
  readonly baseSnapshotHash: string;
  readonly proposal: { bundles: { key: string }[] };
  readonly conflicts: TemplateConflict[];
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

async function inferProposal(
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

test('rescue + apply: single failing template gets bridged and shipped end-to-end', async () => {
  // Roles=[paladin] (Fantasy), Outfits=[bikini] (Modern) → template `Scene`
  // (references both) becomes unsatisfiable under the AI proposal.
  // Rescue produces an addOption on Roles tagged Modern that bridges the
  // conflict. Apply with all bundles + rescue should ship every edit
  // (dimension, tag assignments, new option) to the DB.
  const inferOps: RawInferOp[] = [
    { op: 'createDimension', name: 'Genre', tags: ['Fantasy', 'Modern'] },
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
    { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },
  ];
  const rescueOp: RawInferOp = {
    op: 'addOption',
    listIdx: 0,
    value: 'business consultant',
    tags: [{ dimName: 'Genre', label: 'Modern' }],
  };
  setCliproxyTextProviderForTests({
    enhance: emptyEnhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: inferOps }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: inferOps }),
    rescueDimension: () => Promise.resolve({ type: 'ok', ops: [rescueOp] }),
  });
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const userId = 'alice';
  await seedPromptUser(app, userId, {
    lists: [
      { name: 'Roles', options: ['paladin'] },
      { name: 'Outfits', options: ['bikini'] },
    ],
  });
  await createTemplate(app, userId, 'Scene', 'a {{var::Roles}} wears {{var::Outfits}}');

  // 1) Infer surfaces one conflict on Scene.
  const prop = await inferProposal(app, userId);
  expect(prop.conflicts).toHaveLength(1);
  expect(req(prop.conflicts[0]).templateName).toBe('Scene');
  const culpritBundleKeys = req(prop.conflicts[0]).culpritBundleKeys;
  // The Genre dimension creates the conflict; expect at least one culprit.
  expect(culpritBundleKeys.length).toBeGreaterThan(0);

  // 2) Rescue Scene: bridging addOption appended as rescue:Scene bundle.
  const rescueRes = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
    method: 'POST',
    headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: prop.proposalId, templateName: 'Scene' }),
  }));
  expect(rescueRes.status).toBe(200);
  const rescueFrames = await parseSse(rescueRes);
  const rescueDone = rescueFrames.find((f) => f.event === 'done');
  expect(rescueDone).toBeTruthy();
  const rescueBundle = (rescueDone?.data as { rescueBundle: RescueBundle }).rescueBundle;
  expect(rescueBundle.kind).toBe('rescue');
  expect(rescueBundle.key).toBe('rescue:Scene');
  expect(rescueBundle.listName).toBe('Roles');
  expect(rescueBundle.optionValue).toBe('business consultant');
  expect(rescueBundle.templateName).toBe('Scene');

  // 3) Apply with all bundle keys (including rescue:Scene).
  const applyRes = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
    method: 'POST',
    headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proposalId: prop.proposalId,
      acceptedBundleKeys: [...prop.proposal.bundles.map((b) => b.key), 'rescue:Scene'],
      acceptUnsatisfiableTemplates: [],
    }),
  }));
  expect(applyRes.status).toBe(200);
  const lib = await applyRes.json() as PromptLibraryResponse;

  // 4) DB assertions. Dimension landed.
  const genre = req(lib.dimensions.find((d) => d.name === 'Genre'), 'Genre dim missing');
  const fantasyTag = req(genre.tags.find((t) => t.label === 'Fantasy'), 'Fantasy tag missing');
  const modernTag = req(genre.tags.find((t) => t.label === 'Modern'), 'Modern tag missing');
  // assignOptionTags landed on existing options.
  const roles = req(lib.variableLists.find((l) => l.name === 'Roles'), 'Roles list missing');
  const outfits = req(lib.variableLists.find((l) => l.name === 'Outfits'), 'Outfits list missing');
  expect(req(roles.options.find((o) => o.value === 'paladin')).tagIds).toEqual([fantasyTag.id]);
  expect(req(outfits.options.find((o) => o.value === 'bikini')).tagIds).toEqual([modernTag.id]);
  // Rescue addOption landed with the correct tag wiring.
  const bridge = req(roles.options.find((o) => o.value === 'business consultant'), 'rescue option missing');
  expect(bridge.tagIds).toEqual([modernTag.id]);
});

test('rescue one template + acceptUnsatisfiable another: partial rescue applies cleanly', async () => {
  // Three lists, two templates failing on the same dimension:
  //   Roles=[paladin]    → Genre/Fantasy
  //   Outfits=[bikini]   → Genre/Modern
  //   Era=[1980s]        → Genre/Industrial
  // Both templates reference pairs that disagree on Genre:
  //   Scene  = Roles + Outfits → Fantasy vs Modern     (unsat)
  //   Period = Outfits + Era   → Modern vs Industrial  (unsat)
  // User rescues Scene (server picks Roles as target and adds a Modern-tagged
  // option that bridges to bikini). For Period, the user opts to apply anyway.
  const inferOps: RawInferOp[] = [
    { op: 'createDimension', name: 'Genre', tags: ['Fantasy', 'Modern', 'Industrial'] },
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
    { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },
    { op: 'assignOptionTags', listIdx: 2, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Industrial' }] },
  ];
  // Rescue for Scene: bridges Roles+Outfits on Genre.
  const rescueOp: RawInferOp = {
    op: 'addOption',
    listIdx: 0,
    value: 'business consultant',
    tags: [{ dimName: 'Genre', label: 'Modern' }],
  };
  setCliproxyTextProviderForTests({
    enhance: emptyEnhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: inferOps }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: inferOps }),
    rescueDimension: () => Promise.resolve({ type: 'ok', ops: [rescueOp] }),
  });
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const userId = 'alice';
  await seedPromptUser(app, userId, {
    lists: [
      { name: 'Roles', options: ['paladin'] },
      { name: 'Outfits', options: ['bikini'] },
      { name: 'Era', options: ['1980s'] },
    ],
  });
  await createTemplate(app, userId, 'Scene', 'a {{var::Roles}} wears {{var::Outfits}}');
  await createTemplate(app, userId, 'Period', 'a {{var::Outfits}} from the {{var::Era}}');

  // 1) Infer reports two conflicts.
  const prop = await inferProposal(app, userId);
  const conflictNames = prop.conflicts.map((c) => c.templateName).sort();
  expect(conflictNames).toEqual(['Period', 'Scene']);

  // 2) Rescue only Scene.
  const rescueRes = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
    method: 'POST',
    headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: prop.proposalId, templateName: 'Scene' }),
  }));
  expect(rescueRes.status).toBe(200);
  const rescueFrames = await parseSse(rescueRes);
  const rescueDone = rescueFrames.find((f) => f.event === 'done');
  expect(rescueDone).toBeTruthy();
  expect((rescueDone?.data as { rescueBundle: RescueBundle }).rescueBundle.key).toBe('rescue:Scene');

  // 3) Apply: rescue:Scene + acceptUnsatisfiableTemplates: ['Period'].
  const applyRes = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
    method: 'POST',
    headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proposalId: prop.proposalId,
      acceptedBundleKeys: [...prop.proposal.bundles.map((b) => b.key), 'rescue:Scene'],
      acceptUnsatisfiableTemplates: ['Period'],
    }),
  }));
  expect(applyRes.status).toBe(200);
  const lib = await applyRes.json() as PromptLibraryResponse;

  // 4) DB assertions: every dim + option-tag landed; rescue option appears
  //    in Roles; no `rescue:Period` bundle was ever produced (the user opted
  //    to apply Period anyway, not to rescue it).
  const genre = req(lib.dimensions.find((d) => d.name === 'Genre'), 'Genre missing');
  const fantasyTag = req(genre.tags.find((t) => t.label === 'Fantasy'));
  const modernTag = req(genre.tags.find((t) => t.label === 'Modern'));
  const industrialTag = req(genre.tags.find((t) => t.label === 'Industrial'));
  const roles = req(lib.variableLists.find((l) => l.name === 'Roles'));
  const outfits = req(lib.variableLists.find((l) => l.name === 'Outfits'));
  const era = req(lib.variableLists.find((l) => l.name === 'Era'));
  // Original assignments landed.
  expect(req(roles.options.find((o) => o.value === 'paladin')).tagIds).toEqual([fantasyTag.id]);
  expect(req(outfits.options.find((o) => o.value === 'bikini')).tagIds).toEqual([modernTag.id]);
  expect(req(era.options.find((o) => o.value === '1980s')).tagIds).toEqual([industrialTag.id]);
  // Rescue addOption landed on Roles with Genre/Modern.
  const bridge = req(roles.options.find((o) => o.value === 'business consultant'), 'rescue option missing');
  expect(bridge.tagIds).toEqual([modernTag.id]);
  // Rescue option scoped to Roles only (sanity).
  expect(outfits.options.find((o) => o.value === 'business consultant')).toBeUndefined();
  expect(era.options.find((o) => o.value === 'business consultant')).toBeUndefined();
});

test('rescue + apply: defensive cross-template guard exercised on addOption rescue', async () => {
  // NOTE: the cross-template `templateSatisfiable` guard
  // at /rescue step 13.d is defence-in-depth. Under the current op vocabulary
  // (`addOption` is structurally additive — it only pushes a new option onto
  // a list and ensures any referenced tag labels exist on their dimensions),
  // a successful rescue CANNOT make a previously-satisfiable sibling template
  // unsatisfiable: every prior satisfying combination still exists. The guard
  // exists so that future op kinds capable of removing options/tags would be
  // blocked before they could break a sibling.
  //
  // This test exercises the guard with a real sibling template that stays
  // satisfiable throughout (Period: Outfits+Era, both options wildcards on
  // Genre). It verifies that:
  //   1. The guard runs (the sibling template is satisfiable in `preview`
  //      and remains so in `postRescue`).
  //   2. The rescue succeeds — `rescue:Period` bundle is NOT produced for
  //      Period (no conflict to rescue), and the rescue:Scene bundle ships.
  //   3. Subsequent /rescue on Scene returns 409 (cap consumed by the first
  //      successful rescue).
  //   4. Apply lands all original edits + the rescue option in the DB.
  const inferOps: RawInferOp[] = [
    { op: 'createDimension', name: 'Genre', tags: ['Fantasy', 'Modern'] },
    // Roles → Fantasy; Outfits → Modern; this makes Scene unsat.
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
    { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },
    // Era is wildcard on Genre. Period (Outfits+Era) stays satisfiable
    // because Era carries no Genre tag → no disjoint pair.
  ];
  const rescueOp: RawInferOp = {
    op: 'addOption',
    listIdx: 0,
    value: 'business consultant',
    tags: [{ dimName: 'Genre', label: 'Modern' }],
  };
  setCliproxyTextProviderForTests({
    enhance: emptyEnhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: inferOps }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: inferOps }),
    rescueDimension: () => Promise.resolve({ type: 'ok', ops: [rescueOp] }),
  });
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const userId = 'alice';
  await seedPromptUser(app, userId, {
    lists: [
      { name: 'Roles', options: ['paladin'] },
      { name: 'Outfits', options: ['bikini'] },
      { name: 'Era', options: ['1980s'] },
    ],
  });
  await createTemplate(app, userId, 'Scene', 'a {{var::Roles}} wears {{var::Outfits}}');
  await createTemplate(app, userId, 'Period', 'a {{var::Outfits}} from the {{var::Era}}');

  // 1) Infer: only Scene is unsat. Period is satisfiable (Era is wildcard).
  const prop = await inferProposal(app, userId);
  const conflictNames = prop.conflicts.map((c) => c.templateName);
  expect(conflictNames).toEqual(['Scene']);

  // 2) Rescue Scene — the cross-template guard inspects Period (a 2-list
  //    sibling), sees it was satisfiable in preview, sees it remains
  //    satisfiable in postRescue, and lets the rescue commit.
  const rescueRes = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
    method: 'POST',
    headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: prop.proposalId, templateName: 'Scene' }),
  }));
  expect(rescueRes.status).toBe(200);
  const rescueFrames = await parseSse(rescueRes);
  const rescueDone = rescueFrames.find((f) => f.event === 'done');
  expect(rescueDone).toBeTruthy();
  // 'rescue-would-break-another-template' must NOT have been emitted (Period
  // is wildcard on Genre — the guard fires but the result is fine).
  expect(rescueFrames.find((f) => f.event === 'rescue-failed')).toBeUndefined();
  expect((rescueDone?.data as { rescueBundle: RescueBundle }).rescueBundle.key).toBe('rescue:Scene');

  // 3) Cap consumed: a second /rescue for the same template returns 409.
  const second = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
    method: 'POST',
    headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposalId: prop.proposalId, templateName: 'Scene' }),
  }));
  expect(second.status).toBe(409);
  const secondBody = await second.json() as { code?: string };
  expect(secondBody.code).toBe('rescue-spent');

  // 4) Apply: original edits + rescue land in the DB.
  const applyRes = await app.fetch(new Request('http://local/api/prompts/dimensions/apply', {
    method: 'POST',
    headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proposalId: prop.proposalId,
      acceptedBundleKeys: [...prop.proposal.bundles.map((b) => b.key), 'rescue:Scene'],
      acceptUnsatisfiableTemplates: [],
    }),
  }));
  expect(applyRes.status).toBe(200);
  const lib = await applyRes.json() as PromptLibraryResponse;
  const genre = req(lib.dimensions.find((d) => d.name === 'Genre'), 'Genre missing');
  const modernTag = req(genre.tags.find((t) => t.label === 'Modern'));
  const fantasyTag = req(genre.tags.find((t) => t.label === 'Fantasy'));
  const roles = req(lib.variableLists.find((l) => l.name === 'Roles'));
  const outfits = req(lib.variableLists.find((l) => l.name === 'Outfits'));
  expect(req(roles.options.find((o) => o.value === 'paladin')).tagIds).toEqual([fantasyTag.id]);
  expect(req(outfits.options.find((o) => o.value === 'bikini')).tagIds).toEqual([modernTag.id]);
  expect(req(roles.options.find((o) => o.value === 'business consultant')).tagIds).toEqual([modernTag.id]);
});
