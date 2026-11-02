import { expect, test } from 'bun:test';
import { DIAGNOSIS_VERSION, DIAGNOSIS_VERSION_HEADER, SESSION_SCOPE_HEADER, type LibraryDiagnosisResponse, type TagDimension, type VariableList } from '@atelier/shared';
import { _setDiagnosisNodeBudgetForTests } from '../../prompts/libraryDiagnosis';
import { testRuntime } from '../../test/helpers';
import { inferPool } from '../../orchestrator/llmAdmission';

const ENDPOINT = 'http://local/api/prompts/library-diagnosis';

function req(userId = 'alice', version?: string): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Remote-User': userId, ...(version === undefined ? {} : { [DIAGNOSIS_VERSION_HEADER]: version }) },
  });
}

async function createList(
  app: ReturnType<typeof testRuntime>['app'],
  userId: string,
  name: string,
): Promise<VariableList> {
  const res = await app.fetch(new Request('http://local/api/prompts/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({ name }),
  }));
  expect(res.status).toBe(201);
  return await res.json() as VariableList;
}

async function putOptions(
  app: ReturnType<typeof testRuntime>['app'],
  userId: string,
  listId: string,
  options: { value: string; sortOrder: number; tagIds: string[] }[],
): Promise<void> {
  const res = await app.fetch(new Request(`http://local/api/prompts/lists/${listId}/options`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({ options }),
  }));
  expect(res.status).toBe(200);
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

async function createDimension(
  app: ReturnType<typeof testRuntime>['app'],
  userId: string,
  name: string,
  tags: string[],
): Promise<TagDimension> {
  const dimRes = await app.fetch(new Request('http://local/api/prompts/dimensions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({ name }),
  }));
  expect(dimRes.status).toBe(201);
  const dim = await dimRes.json() as TagDimension;

  const tagsRes = await app.fetch(new Request(`http://local/api/prompts/dimensions/${dim.id}/tags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({
      tags: tags.map((label, sortOrder) => ({ label, sortOrder })),
    }),
  }));
  expect(tagsRes.status).toBe(200);
  return await tagsRes.json() as TagDimension;
}

test('returns satisfiable=true for an empty library', async () => {
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const res = await app.fetch(req());
  expect(res.status).toBe(200);
  const body = await res.json() as LibraryDiagnosisResponse;
  expect(body.templates).toEqual([]);
  expect(typeof body.librarySnapshotHash).toBe('string');
  expect(typeof body.templatesDigest).toBe('string');
  expect(body.incompleteTemplateNames).toBeUndefined();
  const modern = await app.fetch(req('alice', DIAGNOSIS_VERSION));
  expect(await modern.json()).toEqual(body);
});

test('modern diagnosis exposes unknown verdicts while legacy clients receive proven booleans and omitted names', async () => {
  const { app, db } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const dimension = await createDimension(app, 'alice', 'D', ['A', 'B']);
  const tagA = dimension.tags.find((tag) => tag.label === 'A');
  const tagB = dimension.tags.find((tag) => tag.label === 'B');
  if (!tagA || !tagB) throw new Error('missing fixture tags');
  for (const [name, count, tag] of [
    ['HardA', 50, tagA.id], ['HardB', 50, tagB.id], ['BrokenA', 1, tagA.id], ['BrokenB', 1, tagB.id],
  ] as const) {
    const list = await createList(app, 'alice', name);
    await putOptions(app, 'alice', list.id, Array.from({ length: count }, (_, i) => ({ value: `option-${i}`, sortOrder: i, tagIds: [tag] })));
  }
  await createTemplate(app, 'alice', 'Hard', '{{var::HardA}} {{var::HardB}}');
  await createTemplate(app, 'alice', 'Broken', '{{var::BrokenA}} {{var::BrokenB}}');
  await createTemplate(app, 'alice', 'Healthy', '{{var::HardA}}');
  const before = db.query('SELECT total_changes() AS n').get();
  _setDiagnosisNodeBudgetForTests(60);
  try {
    const response = await app.fetch(req('alice', DIAGNOSIS_VERSION));
    const modern = await response.json() as LibraryDiagnosisResponse;
    expect(modern.templates.find((entry) => entry.templateName === 'Hard')?.satisfiable).toBeNull();
    expect(modern.templates.find((entry) => entry.templateName === 'Broken')?.satisfiable).toBe(false);
    expect(modern.templates.find((entry) => entry.templateName === 'Healthy')?.satisfiable).toBe(true);
    for (const version of [undefined, '1']) {
      const legacyResponse = await app.fetch(req('alice', version));
      const legacy = await legacyResponse.json() as LibraryDiagnosisResponse;
      // This is the old bundle's boolean guard; extra response metadata is ignored.
      expect(legacy.templates.every((entry) => typeof entry.templateName === 'string' && typeof entry.satisfiable === 'boolean')).toBe(true);
      expect(legacy.templates).toEqual(modern.templates.filter((entry) => entry.satisfiable !== null));
      expect(legacy.incompleteTemplateNames).toEqual(['Hard']);
      expect(legacy.librarySnapshotHash).toBe(modern.librarySnapshotHash);
      expect(legacy.templatesDigest).toBe(modern.templatesDigest);
      expect(legacyResponse.headers.get('Cache-Control')).toBe('private, no-store');
      const vary = legacyResponse.headers.get('Vary')?.toLowerCase().split(/\s*,\s*/);
      expect(vary).toContain(DIAGNOSIS_VERSION_HEADER.toLowerCase());
      expect(vary).toContain(SESSION_SCOPE_HEADER.toLowerCase());
    }
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(db.query('SELECT total_changes() AS n').get()).toEqual(before);
  } finally { _setDiagnosisNodeBudgetForTests(null); }
});

test('flags a known-broken library with a conflicting pair', async () => {
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const userId = 'alice';

  // Two lists, each with one option.
  const listA = await createList(app, userId, 'Roles');
  const listB = await createList(app, userId, 'Outfits');

  // Template referencing both — creates a two-list constraint.
  await createTemplate(app, userId, 'Scene', 'a {{var::Roles}} wears {{var::Outfits}}');

  // Create dimension D with two disjoint tags.
  const dim = await createDimension(app, userId, 'D', ['Fantasy', 'Modern']);
  const tagFantasy = dim.tags.find((t) => t.label === 'Fantasy');
  const tagModern = dim.tags.find((t) => t.label === 'Modern');
  if (!tagFantasy || !tagModern) throw new Error('expected both tags');

  // Assign Fantasy to Roles option, Modern to Outfits option — fully disjoint.
  await putOptions(app, userId, listA.id, [
    { value: 'paladin', sortOrder: 0, tagIds: [tagFantasy.id] },
  ]);
  await putOptions(app, userId, listB.id, [
    { value: 'bikini', sortOrder: 0, tagIds: [tagModern.id] },
  ]);

  const res = await app.fetch(req());
  expect(res.status).toBe(200);
  const body = await res.json() as LibraryDiagnosisResponse;

  const scene = body.templates.find((t) => t.templateName === 'Scene');
  expect(scene).toBeTruthy();
  expect(scene?.satisfiable).toBe(false);
  expect(scene?.conflictingPairs?.[0]?.dimensionName).toBe('D');
  expect(typeof body.librarySnapshotHash).toBe('string');
  expect(typeof body.templatesDigest).toBe('string');
});

test('non-allowlisted user is rejected by the prompt gate', async () => {
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const res = await app.fetch(req('someone-else'));
  // The prompt gate returns 404 for non-listed users (leak-safe).
  expect(res.status).toBe(404);
});

test('bounded deterministic diagnosis remains available while inference is admitted', async () => {
  const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', MAX_CONCURRENT_LLM_INFER_PER_USER: '1' });
  await runtime.fetch('/api/session', { headers: { 'Remote-User': 'alice' } });
  const held = inferPool.acquire('alice');
  if (!held.ok) throw new Error('could not reserve inference slot');
  try {
    const response = await runtime.app.fetch(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ templates: [] });
  } finally { held.release(); }
});

test('DB is unchanged — endpoint is read-only', async () => {
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const userId = 'alice';
  await createList(app, userId, 'Things');
  await createTemplate(app, userId, 'T1', 'pick {{var::Things}}');

  const libBefore = await app.fetch(new Request('http://local/api/prompts', {
    headers: { 'Remote-User': userId },
  }));
  expect(libBefore.status).toBe(200);
  const before = await libBefore.json();

  await app.fetch(req());

  const libAfter = await app.fetch(new Request('http://local/api/prompts', {
    headers: { 'Remote-User': userId },
  }));
  expect(libAfter.status).toBe(200);
  const after = await libAfter.json();

  expect(after).toEqual(before);
});
