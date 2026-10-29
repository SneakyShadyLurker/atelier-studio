import { expect, test } from 'bun:test';
import type { LibraryDiagnosisResponse, TagDimension, VariableList } from '@atelier/shared';
import { testRuntime } from '../../test/helpers';

const ENDPOINT = 'http://local/api/prompts/library-diagnosis';

function req(userId = 'alice'): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Remote-User': userId },
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
