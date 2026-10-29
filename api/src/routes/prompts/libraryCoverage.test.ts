import { expect, test } from 'bun:test';
import type { LibraryCoverageResponse, VariableList } from '@atelier/shared';
import { testRuntime } from '../../test/helpers';

const ENDPOINT = 'http://local/api/prompts/library-coverage';

function req(userId = 'alice'): Request {
  return new Request(ENDPOINT, { method: 'POST', headers: { 'Remote-User': userId } });
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

async function putOptions(app: ReturnType<typeof testRuntime>['app'], userId: string, listId: string, options: { value: string; sortOrder: number; tagIds: string[] }[]): Promise<void> {
  const res = await app.fetch(new Request(`http://local/api/prompts/lists/${listId}/options`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({ options }),
  }));
  expect(res.status).toBe(200);
}

test('returns empty sections for an empty library', async () => {
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const res = await app.fetch(req());
  expect(res.status).toBe(200);
  const body = await res.json() as LibraryCoverageResponse;
  expect(body.untaggedByList).toEqual([]);
  expect(typeof body.librarySnapshotHash).toBe('string');
});

test('surfaces untagged options on a name-implied list', async () => {
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const userId = 'alice';
  const list = await createList(app, userId, 'fantasy_role');
  await putOptions(app, userId, list.id, [
    { value: 'paladin', sortOrder: 0, tagIds: [] },
    { value: 'rogue', sortOrder: 1, tagIds: [] },
  ]);
  const res = await app.fetch(req());
  expect(res.status).toBe(200);
  const body = await res.json() as LibraryCoverageResponse;
  const group = body.untaggedByList.find((g) => g.listName === 'fantasy_role');
  expect(group?.listId).toBe(list.id);
  expect(group?.untaggedCount).toBe(2);
});

test('non-allowlisted user is rejected by the prompt gate', async () => {
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const res = await app.fetch(req('someone-else'));
  expect(res.status).toBe(404);
});

test('DB is unchanged — endpoint is read-only', async () => {
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  const userId = 'alice';
  await createList(app, userId, 'Things');
  const before = await (await app.fetch(new Request('http://local/api/prompts', { headers: { 'Remote-User': userId } }))).json();
  await app.fetch(req());
  const after = await (await app.fetch(new Request('http://local/api/prompts', { headers: { 'Remote-User': userId } }))).json();
  expect(after).toEqual(before);
});

test('coverage accepts legal prototype-shaped list names', async () => {
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  for (const name of ['constructor', '__proto__', 'toString']) {
    const list = await createList(app, 'alice', name);
    await putOptions(app, 'alice', list.id, [{ value: 'option', sortOrder: 0, tagIds: [] }]);
  }
  const response = await app.fetch(req());
  expect(response.status).toBe(200);
  expect((await response.json() as LibraryCoverageResponse).untaggedByList).toEqual([]);
});
