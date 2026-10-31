import { afterEach, describe, expect, test } from 'bun:test';
import { setTextModelProviderForTests } from '../providers/text/registry';
import type { PromptLibraryResponse, VariableList } from '@atelier/shared';
import { type TestTextFeatureProvider } from '../providers/text/featureHelpers';
import { parseInferDone, testRuntime } from '../test/helpers';
import type { RawInferOp } from '../prompts/inferTypes';

afterEach(() => { setTextModelProviderForTests(null); });

async function* emptyEnhance(): AsyncGenerator<never, void, unknown> {
  await Promise.resolve();
  if (Date.now() < 0) yield undefined as never;
}

function fake(ops: RawInferOp[]): TestTextFeatureProvider {
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
  readonly conflicts: { templateName: string; rescueAttempted: boolean }[];
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

async function diagnose(
  app: ReturnType<typeof testRuntime>['app'],
  userId: string,
  body: { proposalId: string; acceptedBundleKeys: string[] },
): Promise<Response> {
  return app.fetch(new Request('http://local/api/prompts/dimensions/diagnose-selection', {
    method: 'POST',
    headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

// Scene fixture: Roles=paladin (Fantasy), Outfits=bikini (Modern) — `Scene`
// template references both lists so the full-bundle scenario is unsat.
// Two top-level bundles: createDimension Genre + two assignOptionTags ops.
// `acceptedBundleKeys` choices: include only `assign:roles:paladin` →
// closure pulls in `create:Genre`; include only `create:Genre` →
// the offending option assignments stay out → SAT recovers.
async function setupSceneUnsat(): Promise<{
  app: ReturnType<typeof testRuntime>['app'];
  userId: string;
  proposalId: string;
  fullBundleKeys: string[];
}> {
  const userId = 'alice';
  const ops: RawInferOp[] = [
    { op: 'createDimension', name: 'Genre', tags: ['Fantasy', 'Modern'] },
    { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
    { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },
  ];
  setTextModelProviderForTests(fake(ops));
  const runtime = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
  const { app } = runtime;
  await seedPromptUser(app, userId, {
    lists: [
      { name: 'Roles', options: ['paladin'] },
      { name: 'Outfits', options: ['bikini'] },
    ],
  });
  await createTemplate(app, userId, 'Scene', 'a {{var::Roles}} wears {{var::Outfits}}');
  const prop = await infer(app, userId);
  return {
    app,
    userId,
    proposalId: prop.proposalId,
    fullBundleKeys: prop.proposal.bundles.map((b) => b.key),
  };
}

describe('POST /api/prompts/dimensions/diagnose-selection', () => {
  test('full bundle set reproduces the infer-time conflict', async () => {
    const { app, userId, proposalId, fullBundleKeys } = await setupSceneUnsat();
    const res = await diagnose(app, userId, { proposalId, acceptedBundleKeys: fullBundleKeys });
    expect(res.status).toBe(200);
    const body = await res.json() as { conflicts: { templateName: string }[] };
    expect(body.conflicts.map((c) => c.templateName)).toContain('Scene');
  });

  test('empty subset selection (no bundles applied) returns empty conflicts', async () => {
    const { app, userId, proposalId, fullBundleKeys } = await setupSceneUnsat();
    // Sanity: full set conflicts on Scene.
    const full = await diagnose(app, userId, { proposalId, acceptedBundleKeys: fullBundleKeys });
    expect(full.status).toBe(200);
    const fullBody = await full.json() as { conflicts: { templateName: string }[] };
    expect(fullBody.conflicts.some((c) => c.templateName === 'Scene')).toBe(true);

    // Dropping all bundles → no tag assignments at all → template is
    // back to its initial wildcard-satisfiable state.
    const res = await diagnose(app, userId, { proposalId, acceptedBundleKeys: [] });
    expect(res.status).toBe(200);
    const body = await res.json() as { conflicts: { templateName: string }[] };
    expect(body.conflicts.some((c) => c.templateName === 'Scene')).toBe(false);
  });

  test('410 on missing proposal', async () => {
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const res = await diagnose(app, 'alice', {
      proposalId: crypto.randomUUID(),
      acceptedBundleKeys: [],
    });
    expect(res.status).toBe(410);
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toContain('proposal');
  });

  test('410 on wrong user (ownership) — leaks as proposal-not-found', async () => {
    // Allow two users so the second's request is gate-passed and the
    // ownership check is the rejection path (otherwise the promptGate
    // would 404 the stranger).
    const userId = 'alice';
    const ops: RawInferOp[] = [
      { op: 'createDimension', name: 'Genre', tags: ['Fantasy'] },
    ];
    setTextModelProviderForTests(fake(ops));
    const runtime = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice,stranger' });
    const { app } = runtime;
    await seedPromptUser(app, userId, { lists: [{ name: 'Roles', options: ['paladin'] }] });
    const prop = await infer(app, userId);
    const res = await diagnose(app, 'stranger', {
      proposalId: prop.proposalId,
      acceptedBundleKeys: [],
    });
    // takeProposalForUser returns null on user mismatch → mirrors /apply's
    // 410 'proposal expired' response.
    expect(res.status).toBe(410);
  });

  test('409 on snapshot drift (list mutation between infer and diagnose)', async () => {
    const { app, userId, proposalId, fullBundleKeys } = await setupSceneUnsat();
    // Add a brand-new list to shift the snapshot hash.
    const drift = await app.fetch(new Request('http://local/api/prompts/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ name: 'Drifter' }),
    }));
    expect(drift.status).toBe(201);
    const res = await diagnose(app, userId, { proposalId, acceptedBundleKeys: fullBundleKeys });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toContain('library changed');
  });

  test('409 on template drift (PATCH template body between infer and diagnose)', async () => {
    const { app, userId, proposalId, fullBundleKeys } = await setupSceneUnsat();
    const lib = await getLibrary(app, userId);
    const scene = lib.templates.find((t) => t.name === 'Scene');
    if (!scene) throw new Error('expected Scene template');
    const patch = await app.fetch(new Request(`http://local/api/prompts/templates/${scene.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify({ body: 'a {{var::Roles}} dramatically wears {{var::Outfits}}' }),
    }));
    expect(patch.status).toBe(200);
    const res = await diagnose(app, userId, { proposalId, acceptedBundleKeys: fullBundleKeys });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toContain('templates changed');
  });

  test('rescueAttempted: true is preserved when stored conflict has it', async () => {
    // Run a rescue that we know will fail (target list cannot rescue) so
    // beginRescueAttempt+commitRescueFailed flips the stored proposal's
    // `Scene` conflict to rescueAttempted:true; then verify diagnose
    // mirrors that flag onto its freshly-computed conflict.
    const userId = 'alice';
    const ops: RawInferOp[] = [
      { op: 'createDimension', name: 'Genre', tags: ['Fantasy', 'Modern'] },
      { op: 'assignOptionTags', listIdx: 0, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Fantasy' }] },
      { op: 'assignOptionTags', listIdx: 1, optionIdx: 0, tags: [{ dimName: 'Genre', label: 'Modern' }] },
    ];
    // Failing rescue: returns an addOption that doesn't bridge (same
    // Fantasy tag as the existing paladin → still unsat).
    const failingRescueOp: RawInferOp = {
      op: 'addOption',
      listIdx: 0,
      value: 'fantasy warrior',
      tags: [{ dimName: 'Genre', label: 'Fantasy' }],
    };
    setTextModelProviderForTests({
      enhance: emptyEnhance,
      draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
      draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
      inferDimensions: () => Promise.resolve({ type: 'ok', ops: [...ops] }),
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [...ops] }),
      rescueDimension: () => Promise.resolve({ type: 'ok', ops: [failingRescueOp] }),
    });
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    await seedPromptUser(app, userId, {
      lists: [
        { name: 'Roles', options: ['paladin'] },
        { name: 'Outfits', options: ['bikini'] },
      ],
    });
    await createTemplate(app, userId, 'Scene', 'a {{var::Roles}} wears {{var::Outfits}}');
    const prop = await infer(app, userId);
    const fullBundleKeys = prop.proposal.bundles.map((b) => b.key);

    // Trigger rescue (will fail — option doesn't bridge).
    const rescueRes = await app.fetch(new Request('http://local/api/prompts/dimensions/rescue', {
      method: 'POST',
      headers: { 'Remote-User': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: prop.proposalId, templateName: 'Scene' }),
    }));
    expect(rescueRes.status).toBe(200);
    await rescueRes.text();

    // Diagnose now: the freshly-computed conflict on `Scene` must carry
    // rescueAttempted:true (merged from the stored proposal).
    const res = await diagnose(app, userId, {
      proposalId: prop.proposalId,
      acceptedBundleKeys: fullBundleKeys,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { conflicts: { templateName: string; rescueAttempted: boolean }[] };
    const scene = body.conflicts.find((c) => c.templateName === 'Scene');
    expect(scene).toBeTruthy();
    expect(scene?.rescueAttempted).toBe(true);
  });

  test('endpoint recomputes per user subset (proves it is not just echoing stored conflicts)', async () => {
    // Stored conflict on `Scene` was diagnosed at infer time against the
    // FULL bundle set. We exercise three different subsets in sequence
    // and verify the response tracks the SAT outcome for THAT subset —
    // not the cached infer-time snapshot.
    const { app, userId, proposalId, fullBundleKeys } = await setupSceneUnsat();

    const full = await diagnose(app, userId, { proposalId, acceptedBundleKeys: fullBundleKeys });
    expect(full.status).toBe(200);
    const fullBody = await full.json() as { conflicts: { templateName: string }[] };
    expect(fullBody.conflicts.some((c) => c.templateName === 'Scene')).toBe(true);

    const empty = await diagnose(app, userId, { proposalId, acceptedBundleKeys: [] });
    expect(empty.status).toBe(200);
    const emptyBody = await empty.json() as { conflicts: { templateName: string }[] };
    expect(emptyBody.conflicts.some((c) => c.templateName === 'Scene')).toBe(false);

    // And back to full again — proves the endpoint is pure and not
    // mutating proposal state with each call.
    const full2 = await diagnose(app, userId, { proposalId, acceptedBundleKeys: fullBundleKeys });
    expect(full2.status).toBe(200);
    const full2Body = await full2.json() as { conflicts: { templateName: string }[] };
    expect(full2Body.conflicts.some((c) => c.templateName === 'Scene')).toBe(true);
  });

  test('DB is unchanged — endpoint is read-only', async () => {
    const { app, userId, proposalId, fullBundleKeys } = await setupSceneUnsat();
    const before = await getLibrary(app, userId);
    const res = await diagnose(app, userId, { proposalId, acceptedBundleKeys: fullBundleKeys });
    expect(res.status).toBe(200);
    const after = await getLibrary(app, userId);
    expect(after).toEqual(before);
  });

  test('non-allowlisted user gets 404 (router gate)', async () => {
    const { app } = testRuntime({ seedLegacyText: true, PROMPT_LIBRARY_USERS: 'alice' });
    const res = await app.fetch(new Request('http://local/api/prompts/dimensions/diagnose-selection', {
      method: 'POST',
      headers: { 'Remote-User': 'stranger', 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: crypto.randomUUID(), acceptedBundleKeys: [] }),
    }));
    expect(res.status).toBe(404);
  });
});
