import { describe, expect, test } from 'bun:test';
import type {
  PromptLibraryResponse,
  PromptTemplate,
  TagDimension,
  VariableList,
  VariableOption,
} from '@atelier/shared';
import { testRuntime } from '../test/helpers';

type Runtime = ReturnType<typeof testRuntime>;

function jsonReq(path: string, body: unknown, method = 'POST', userId = 'alice'): Request {
  return new Request(`http://local${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify(body),
  });
}

function authedReq(path: string, method = 'GET', userId = 'alice'): Request {
  return new Request(`http://local${path}`, { method, headers: { 'Remote-User': userId } });
}

async function expectJson<T>(res: Response, status: number): Promise<T> {
  expect(res.status).toBe(status);
  return await res.json() as T;
}

async function createTemplate(
  app: Runtime['app'],
  body: { name?: string; body?: string; notes?: string } = {},
  userId = 'alice',
): Promise<PromptTemplate> {
  return await expectJson<PromptTemplate>(
    await app.fetch(jsonReq('/api/prompts/templates', { name: 'Template', body: 'A {{var::subject}}', ...body }, 'POST', userId)),
    201,
  );
}

async function createList(app: Runtime['app'], name = 'subject', userId = 'alice'): Promise<VariableList> {
  return await expectJson<VariableList>(
    await app.fetch(jsonReq('/api/prompts/lists', { name }, 'POST', userId)),
    201,
  );
}

async function createDimension(app: Runtime['app'], name = 'era', userId = 'alice'): Promise<TagDimension> {
  return await expectJson<TagDimension>(
    await app.fetch(jsonReq('/api/prompts/dimensions', { name }, 'POST', userId)),
    201,
  );
}

async function replaceTags(
  app: Runtime['app'],
  dimensionId: string,
  tags: { id?: string; label: string; sortOrder: number; parentId?: string | null }[],
  userId = 'alice',
): Promise<TagDimension> {
  return await expectJson<TagDimension>(
    await app.fetch(jsonReq(`/api/prompts/dimensions/${dimensionId}/tags`, { tags }, 'PUT', userId)),
    200,
  );
}

async function replaceOptions(
  app: Runtime['app'],
  listId: string,
  options: { value: string; tagIds: string[]; excludeTagIds?: string[]; sortOrder: number; weight?: number }[],
  userId = 'alice',
): Promise<VariableList> {
  return await expectJson<VariableList>(
    await app.fetch(jsonReq(`/api/prompts/lists/${listId}/options`, { options }, 'PUT', userId)),
    200,
  );
}

const AUTO_SELECTION_REQUIRED = 'at least one option must remain available for automatic selection';

describe('prompt library routes', () => {
  for (const mode of ['swap', 'removed-label', 'new-row-label'] as const) {
    test(`tag replacement supports ${mode} while preserving retained identity and membership`, async () => {
      const { app, db } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
      const dimension = await createDimension(app);
      const original = await replaceTags(app, dimension.id, [{ label: 'A', sortOrder: 0 }, { label: 'B', sortOrder: 1 }]);
      const [a, b] = original.tags;
      if (!a || !b) throw new Error('original tags missing');
      const list = await createList(app);
      await replaceOptions(app, list.id, [{ value: 'tagged', tagIds: [a.id], sortOrder: 0 }]);
      const tags = mode === 'swap'
        ? [{ ...a, label: 'B', parentId: b.id }, { ...b, label: 'A', parentId: null }]
        : mode === 'removed-label' ? [{ ...a, label: 'B', parentId: null }]
          : [{ ...a, label: 'A', parentId: null }, { label: 'B', sortOrder: 1, parentId: a.id }];
      const replaced = await replaceTags(app, dimension.id, tags);
      expect(replaced.tags.find((tag) => tag.id === a.id)?.label).toBe(mode === 'new-row-label' ? 'A' : 'B');
      expect(db.query('SELECT tag_id FROM option_tags WHERE option_id=?').all(list.options[0]?.id ??
        (db.query<{ id: string }, [string]>('SELECT id FROM variable_options WHERE list_id=?').get(list.id)?.id ?? '')))
        .toEqual([{ tag_id: a.id }]);
      if (mode !== 'swap') expect(replaced.tags.some((tag) => tag.id === b.id)).toBe(false);
      if (mode === 'swap') expect(replaced.tags.find((tag) => tag.id === a.id)?.parentId).toBe(b.id);
      if (mode === 'new-row-label') expect(replaced.tags.find((tag) => tag.label === 'B')?.parentId).toBe(a.id);
    });
  }

  test('duplicate final labels reject atomically without leaking staged labels or hierarchy changes', async () => {
    const { app, db } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const dimension = await createDimension(app);
    const original = await replaceTags(app, dimension.id, [{ label: 'A', sortOrder: 0 }, { label: 'B', sortOrder: 1 }]);
    const before = db.query('SELECT * FROM dimension_tags ORDER BY id').all();
    const response = await app.fetch(jsonReq(`/api/prompts/dimensions/${dimension.id}/tags`, {
      tags: original.tags.map((tag) => ({ ...tag, label: 'same', parentId: null })),
    }, 'PUT'));
    expect(response.status).toBe(409);
    expect(db.query('SELECT * FROM dimension_tags ORDER BY id').all()).toEqual(before);
  });

  for (const oldContradiction of [false, true]) {
    test(`reparent rejects a new membership contradiction atomically (unrelated old contradiction: ${oldContradiction})`, async () => {
      const { app, db } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
      const dimension = await createDimension(app);
      const original = await replaceTags(app, dimension.id, [{ label: 'parent', sortOrder: 0 }, { label: 'child', sortOrder: 1 }]);
      const [parent, child] = original.tags;
      if (!parent || !child) throw new Error('original tags missing');
      const list = await createList(app);
      const saved = await replaceOptions(app, list.id, [{ value: 'valid', tagIds: [child.id], excludeTagIds: [parent.id], sortOrder: 0 }]);
      const option = saved.options[0];
      if (!option) throw new Error('option missing');
      if (oldContradiction) {
        const old = await createDimension(app, 'old');
        const oldTags = await replaceTags(app, old.id, [{ label: 'old-parent', sortOrder: 0 }, { label: 'old-child', sortOrder: 1 }]);
        const [p, c] = oldTags.tags;
        if (!p || !c) throw new Error('legacy tags missing');
        db.query('UPDATE dimension_tags SET parent_id=? WHERE id=?').run(p.id, c.id);
        db.query('INSERT INTO option_tags (option_id,tag_id,polarity) VALUES (?,?,?)').run(option.id, p.id, 'exclude');
        db.query('INSERT INTO option_tags (option_id,tag_id,polarity) VALUES (?,?,?)').run(option.id, c.id, 'require');
      }
      const before = db.query('SELECT * FROM dimension_tags ORDER BY id').all();
      const response = await app.fetch(jsonReq(`/api/prompts/dimensions/${dimension.id}/tags`, {
        tags: [{ ...parent, label: 'renamed parent', parentId: null }, { ...child, parentId: parent.id }],
      }, 'PUT'));
      expect(response.status).toBe(409);
      expect(db.query('SELECT * FROM dimension_tags ORDER BY id').all()).toEqual(before);
      // Untouched old contradictions are retained, not used as a blanket veto.
      await replaceTags(app, dimension.id, [{ ...parent, label: 'renamed parent', parentId: null }, { ...child, parentId: null }]);
      if (!oldContradiction) {
        expect((await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options/${option.id}`, { value: 'editable' }, 'PATCH'))).status).toBe(204);
        expect((await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options/${option.id}`, { excludeTagIds: [] }, 'PATCH'))).status).toBe(204);
        await replaceTags(app, dimension.id, [{ ...parent, parentId: null }, { ...child, parentId: parent.id }]);
      }
      // Removing a tag also clears its membership and may resolve a contradiction.
      await replaceTags(app, dimension.id, [{ ...child, parentId: null }]);
      expect(db.query('SELECT tag_id FROM option_tags WHERE option_id=? AND tag_id=?').get(option.id, parent.id)).toBeNull();
    });
  }
  for (const invalid of ['duplicate', 'unknown', 'foreign'] as const) {
    test(`tag replacement rejects ${invalid} IDs before any update or insertion`, async () => {
      const { app, db } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice,bob' });
      const dimension = await createDimension(app);
      const original = await replaceTags(app, dimension.id, [{ label: 'original', sortOrder: 0 }]);
      const tag = original.tags[0];
      if (!tag) throw new Error('missing original tag');
      const foreignDimension = await createDimension(app, 'foreign', 'bob');
      const foreign = await replaceTags(app, foreignDimension.id, [{ label: 'foreign', sortOrder: 0 }], 'bob');
      const invalidId = invalid === 'duplicate' ? tag.id
        : invalid === 'foreign' ? foreign.tags[0]?.id : crypto.randomUUID();
      const beforeTags = db.query('SELECT * FROM dimension_tags WHERE user_id = ? ORDER BY id').all('alice');
      const beforeRevision = db.query('SELECT revision FROM prompt_library_revisions WHERE user_id = ?').get('alice');
      const response = await app.fetch(jsonReq(`/api/prompts/dimensions/${dimension.id}/tags`, { tags: [
        { id: tag.id, label: 'changed', sortOrder: 0 },
        { label: 'new-before-invalid', sortOrder: 1 },
        { id: invalidId, label: 'invalid', sortOrder: 2 },
      ] }, 'PUT'));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'unknown tagId' });
      expect(db.query('SELECT * FROM dimension_tags WHERE user_id = ? ORDER BY id').all('alice')).toEqual(beforeTags);
      expect(db.query('SELECT revision FROM prompt_library_revisions WHERE user_id = ?').get('alice')).toEqual(beforeRevision);
    });
  }

  test('library validators at equal revisions are scoped to the authenticated user', async () => {
    const { app, db } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice,bob' });
    await createTemplate(app, { name: 'Alice', body: 'alice-only' }, 'alice');
    await createTemplate(app, { name: 'Bob', body: 'bob-only' }, 'bob');
    expect(db.query('SELECT revision FROM prompt_library_revisions WHERE user_id = ?').get('alice'))
      .toEqual(db.query('SELECT revision FROM prompt_library_revisions WHERE user_id = ?').get('bob'));
    const alice = await app.fetch(authedReq('/api/prompts', 'GET', 'alice'));
    const aliceTag = alice.headers.get('etag');
    const bob = await app.fetch(new Request('http://local/api/prompts', {
      headers: { 'Remote-User': 'bob', 'If-None-Match': aliceTag ?? '' },
    }));
    expect(bob.status).toBe(200);
    expect((await bob.json() as PromptLibraryResponse).templates.map((t) => t.body)).toEqual(['bob-only']);
    expect(bob.headers.get('etag')).not.toBe(aliceTag);
    const own = await app.fetch(new Request('http://local/api/prompts', {
      headers: { 'Remote-User': 'bob', 'If-None-Match': bob.headers.get('etag') ?? '' },
    }));
    expect(own.status).toBe(304);
  });

  test('round-trips dimension descriptions, tag parents, and polarity', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const dimension = await expectJson<TagDimension>(
      await app.fetch(jsonReq('/api/prompts/dimensions', {
        name: 'Franchise',
        description: 'The fictional universe this option belongs to.',
      })),
      201,
    );
    expect(dimension.description).toBe('The fictional universe this option belongs to.');
    const seeded = await replaceTags(app, dimension.id, [
      { label: 'The Witcher', sortOrder: 0 },
      { label: 'The Witcher games', sortOrder: 1 },
      { label: 'Star Trek', sortOrder: 2 },
    ]);
    const witcher = seeded.tags.find((tag) => tag.label === 'The Witcher');
    const games = seeded.tags.find((tag) => tag.label === 'The Witcher games');
    const trek = seeded.tags.find((tag) => tag.label === 'Star Trek');
    if (!witcher || !games || !trek) throw new Error('expected tags');
    const nested = await replaceTags(app, dimension.id, [
      { id: witcher.id, label: witcher.label, sortOrder: 0 },
      { id: games.id, label: games.label, sortOrder: 1, parentId: witcher.id },
      { id: trek.id, label: trek.label, sortOrder: 2 },
    ]);
    expect(nested.tags.find((tag) => tag.id === games.id)?.parentId).toBe(witcher.id);

    const list = await createList(app, 'role');
    const saved = await expectJson<VariableList>(
      await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, {
        options: [{
          value: 'monster hunter',
          tagIds: [games.id],
          excludeTagIds: [trek.id],
          sortOrder: 0,
        }],
      }, 'PUT')),
      200,
    );
    expect(saved.options[0]).toMatchObject({
      tagIds: [games.id],
      excludeTagIds: [trek.id],
    });
  });

  test('PUT options preserves exclude tags across multi-option rename and reorder through stable ids', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const dimension = await createDimension(app, 'Franchise');
    const seededTags = await replaceTags(app, dimension.id, [
      { label: 'The Witcher', sortOrder: 0 },
      { label: 'Star Trek', sortOrder: 1 },
    ]);
    const witcher = seededTags.tags[0];
    const trek = seededTags.tags[1];
    if (!witcher || !trek) throw new Error('expected tags');
    const list = await createList(app, 'role');
    const initial = await expectJson<VariableList>(
      await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, {
        options: [
          { value: 'monster hunter', tagIds: [witcher.id], excludeTagIds: [trek.id], sortOrder: 0 },
          { value: 'starship captain', tagIds: [trek.id], excludeTagIds: [witcher.id], sortOrder: 1 },
        ],
      }, 'PUT')),
      200,
    );
    const hunter = initial.options.find((option) => option.value === 'monster hunter');
    const captain = initial.options.find((option) => option.value === 'starship captain');
    if (!hunter || !captain) throw new Error('expected options');

    const saved = await expectJson<VariableList>(
      await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, {
        options: [
          { id: captain.id, value: 'renamed captain', tagIds: [trek.id], sortOrder: 0 },
          { id: hunter.id, value: 'renamed hunter', tagIds: [witcher.id], sortOrder: 1 },
        ],
      }, 'PUT')),
      200,
    );
    expect(saved.options).toEqual([
      expect.objectContaining({ id: captain.id, value: 'renamed captain', excludeTagIds: [witcher.id] }),
      expect.objectContaining({ id: hunter.id, value: 'renamed hunter', excludeTagIds: [trek.id] }),
    ]);
  });

  test('PUT options rejects ambiguous legacy rename and reorder instead of guessing metadata identity', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const dimension = await createDimension(app, 'Franchise');
    const seededTags = await replaceTags(app, dimension.id, [
      { label: 'The Witcher', sortOrder: 0 },
      { label: 'Star Trek', sortOrder: 1 },
    ]);
    const [witcher, trek] = seededTags.tags;
    if (!witcher || !trek) throw new Error('expected tags');
    const list = await createList(app, 'role');
    await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, {
      options: [
        { value: 'A', tagIds: [], excludeTagIds: [witcher.id], sortOrder: 0 },
        { value: 'B', tagIds: [], excludeTagIds: [trek.id], sortOrder: 1 },
      ],
    }, 'PUT'));

    const response = await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, {
      options: [
        { value: 'renamed B', tagIds: [], sortOrder: 0 },
        { value: 'renamed A', tagIds: [], sortOrder: 1 },
      ],
    }, 'PUT'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'ambiguous option identity; include option ids' });
  });

  test('PUT tags with the legacy payload preserves omitted parents while explicit null clears them', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const dimension = await createDimension(app, 'Franchise');
    const seeded = await replaceTags(app, dimension.id, [
      { label: 'The Witcher', sortOrder: 0 },
      { label: 'The Witcher games', sortOrder: 1 },
    ]);
    const parent = seeded.tags[0];
    const child = seeded.tags[1];
    if (!parent || !child) throw new Error('expected tags');
    await replaceTags(app, dimension.id, [
      { id: parent.id, label: parent.label, sortOrder: 0 },
      { id: child.id, label: child.label, sortOrder: 1, parentId: parent.id },
    ]);

    const preserved = await replaceTags(app, dimension.id, [
      { id: parent.id, label: parent.label, sortOrder: 0 },
      { id: child.id, label: 'The Witcher video games', sortOrder: 1 },
      { label: 'Star Trek', sortOrder: 2 },
    ]);
    expect(preserved.tags.find((tag) => tag.id === child.id)?.parentId).toBe(parent.id);

    const cleared = await replaceTags(app, dimension.id, preserved.tags.map((tag) => ({
      id: tag.id,
      label: tag.label,
      sortOrder: tag.sortOrder,
      ...(tag.id === child.id ? { parentId: null } : {}),
    })));
    expect(cleared.tags.find((tag) => tag.id === child.id)?.parentId).toBeUndefined();
  });

  test('rejects require/exclude overlap through tag ancestry at write time', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);
    const dimension = await createDimension(app);
    const tags = await replaceTags(app, dimension.id, [
      { label: 'parent', sortOrder: 0 },
      { label: 'child', sortOrder: 1 },
    ]);
    const [parent, child] = tags.tags;
    if (!parent || !child) throw new Error('expected tags');
    await replaceTags(app, dimension.id, [
      { id: parent.id, label: parent.label, sortOrder: 0 },
      { id: child.id, label: child.label, sortOrder: 1, parentId: parent.id },
    ]);

    const overlap = await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, {
      options: [{ value: 'bad', tagIds: [child.id], excludeTagIds: [parent.id], sortOrder: 0 }],
    }, 'PUT'));
    expect(overlap.status).toBe(400);
  });

  test('rejects tag hierarchy cycles and depth greater than 8 at write time', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const dimension = await createDimension(app);
    const seeded = await replaceTags(app, dimension.id, Array.from({ length: 9 }, (_value, index) => ({
      label: `level-${index + 1}`,
      sortOrder: index,
    })));
    const cycle = await app.fetch(jsonReq(`/api/prompts/dimensions/${dimension.id}/tags`, {
      tags: seeded.tags.map((tag, index) => ({
        id: tag.id,
        label: tag.label,
        sortOrder: tag.sortOrder,
        parentId: index === 0 ? seeded.tags[1]?.id : (index === 1 ? seeded.tags[0]?.id : null),
      })),
    }, 'PUT'));
    expect(cycle.status).toBe(400);
    expect(await cycle.json()).toEqual({ error: 'tag hierarchy cycle' });

    const tooDeep = await app.fetch(jsonReq(`/api/prompts/dimensions/${dimension.id}/tags`, {
      tags: seeded.tags.map((tag, index) => ({
        id: tag.id,
        label: tag.label,
        sortOrder: tag.sortOrder,
        parentId: index === 0 ? null : seeded.tags[index - 1]?.id,
      })),
    }, 'PUT'));
    expect(tooDeep.status).toBe(400);
    expect(await tooDeep.json()).toEqual({ error: 'tag hierarchy exceeds depth 8' });
  });

  test('supports the full template lifecycle', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });

    const created = await createTemplate(app, { name: 'Portrait', body: 'portrait', notes: 'draft' });
    expect(created).toMatchObject({ name: 'Portrait', body: 'portrait', notes: 'draft', sortOrder: 0 });

    const list = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts')), 200);
    expect(list.templates.map((template) => template.id)).toEqual([created.id]);

    const patched = await expectJson<PromptTemplate>(
      await app.fetch(jsonReq(`/api/prompts/templates/${created.id}`, { name: 'Portrait v2', body: 'updated', notes: null }, 'PATCH')),
      200,
    );
    expect(patched).toMatchObject({ id: created.id, name: 'Portrait v2', body: 'updated' });
    expect(patched.notes).toBeUndefined();
    expect(patched.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    const deleted = await app.fetch(authedReq(`/api/prompts/templates/${created.id}`, 'DELETE'));
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');

    const empty = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts')), 200);
    expect(empty.templates).toEqual([]);
  });

  test('PATCH without notes preserves a previously-set notes value', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });

    const created = await createTemplate(app, { name: 'Portrait', body: 'portrait', notes: 'keep me' });
    expect(created.notes).toBe('keep me');

    const patched = await expectJson<PromptTemplate>(
      await app.fetch(jsonReq(`/api/prompts/templates/${created.id}`, { name: 'Portrait v2', body: 'updated' }, 'PATCH')),
      200,
    );
    expect(patched).toMatchObject({ id: created.id, name: 'Portrait v2', body: 'updated', notes: 'keep me' });

    const list = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts')), 200);
    expect(list.templates.find((template) => template.id === created.id)?.notes).toBe('keep me');
  });

  test('returns not-found JSON for every /api/prompts path when user is not allowlisted', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });

    for (const req of [
      authedReq('/api/prompts', 'GET', 'bob'),
      jsonReq('/api/prompts/templates', { name: 'T', body: 'x' }, 'POST', 'bob'),
      jsonReq(`/api/prompts/templates/${crypto.randomUUID()}`, { name: 'T' }, 'PATCH', 'bob'),
      authedReq(`/api/prompts/templates/${crypto.randomUUID()}`, 'DELETE', 'bob'),
      jsonReq('/api/prompts/templates/order', { orderedIds: [crypto.randomUUID()] }, 'PUT', 'bob'),
      jsonReq('/api/prompts/lists', { name: 'L' }, 'POST', 'bob'),
      jsonReq(`/api/prompts/lists/${crypto.randomUUID()}/options`, { options: [] }, 'PUT', 'bob'),
      jsonReq('/api/prompts/dimensions', { name: 'D' }, 'POST', 'bob'),
      jsonReq(`/api/prompts/dimensions/${crypto.randomUUID()}/tags`, { tags: [] }, 'PUT', 'bob'),
    ]) {
      const res = await app.fetch(req);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
  });

  test('rejects duplicate template names with 409', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    await createTemplate(app, { name: 'Portrait', body: 'one' });

    const duplicate = await app.fetch(jsonReq('/api/prompts/templates', { name: 'Portrait', body: 'two' }));

    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'name already used' });
  });

  test('hides cross-user template PATCH and DELETE targets', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice,bob' });
    const template = await createTemplate(app, { name: 'Alice', body: 'x' }, 'alice');

    const patch = await app.fetch(jsonReq(`/api/prompts/templates/${template.id}`, { name: 'Bob' }, 'PATCH', 'bob'));
    expect(patch.status).toBe(404);

    const del = await app.fetch(authedReq(`/api/prompts/templates/${template.id}`, 'DELETE', 'bob'));
    expect(del.status).toBe(204);

    const aliceList = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts', 'GET', 'alice')), 200);
    expect(aliceList.templates).toHaveLength(1);
  });

  test('rejects template count cap with 409', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', MAX_PROMPT_TEMPLATES: '1' });
    await createTemplate(app, { name: 'One', body: 'x' });

    const capped = await app.fetch(jsonReq('/api/prompts/templates', { name: 'Two', body: 'x' }));

    expect(capped.status).toBe(409);
    expect(await capped.json()).toEqual({ error: 'template limit reached' });
  });

  test('rejects template body over MAX_TEMPLATE_BODY_BYTES with 409', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', MAX_TEMPLATE_BODY_BYTES: '4' });

    const create = await app.fetch(jsonReq('/api/prompts/templates', { name: 'Too large', body: '12345' }));
    expect(create.status).toBe(409);
    expect(await create.json()).toEqual({ error: 'template body too large' });

    const template = await createTemplate(app, { name: 'Fits', body: '1234' });
    const patch = await app.fetch(jsonReq(`/api/prompts/templates/${template.id}`, { body: '12345' }, 'PATCH'));
    expect(patch.status).toBe(409);
    expect(await patch.json()).toEqual({ error: 'template body too large' });
  });

  test('accepts template bodies above the old schema literal when config allows them', async () => {
    const raisedLimit = 65_538;
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      MAX_TEMPLATE_BODY_BYTES: String(raisedLimit),
    });
    const withinRaisedLimit = 'x'.repeat(65_537);

    const created = await app.fetch(jsonReq('/api/prompts/templates', {
      name: 'Large template',
      body: withinRaisedLimit,
    }));
    expect(created.status).toBe(201);

    const overRaisedLimit = await app.fetch(jsonReq('/api/prompts/templates', {
      name: 'Too large',
      body: 'x'.repeat(raisedLimit + 1),
    }));
    expect(overRaisedLimit.status).toBe(409);
    expect(await overRaisedLimit.json()).toEqual({ error: 'template body too large' });
  });

  test('rejects options over MAX_OPTIONS_PER_LIST with 409', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', MAX_OPTIONS_PER_LIST: '1' });
    const list = await createList(app);

    const res = await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, {
      options: [
        { value: 'one', tagIds: [], sortOrder: 0 },
        { value: 'two', tagIds: [], sortOrder: 1 },
      ],
    }, 'PUT'));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'option limit reached' });
  });

  test('rejects option replacement payloads above the transport array cap before writing', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', MAX_OPTIONS_PER_LIST: '2000' });
    const list = await createList(app);
    const options = Array.from({ length: 2001 }, (_value, index) => ({
      value: `option ${index}`,
      tagIds: [],
      sortOrder: index,
    }));

    const res = await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, { options }, 'PUT'));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'validation failed' });
  });

  test('rejects tags over MAX_TAGS_PER_DIMENSION with 409', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', MAX_TAGS_PER_DIMENSION: '1' });
    const dimension = await createDimension(app);

    const res = await app.fetch(jsonReq(`/api/prompts/dimensions/${dimension.id}/tags`, {
      tags: [
        { label: 'ancient', sortOrder: 0 },
        { label: 'modern', sortOrder: 1 },
      ],
    }, 'PUT'));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'tag limit reached' });
  });

  test('rejects duplicate tagIds within one option with 400', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);
    const dimension = await createDimension(app);
    const tags = await replaceTags(app, dimension.id, [{ label: 'ancient', sortOrder: 0 }]);
    const tag = tags.tags[0];
    if (!tag) throw new Error('expected tag');

    const res = await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, {
      options: [{ value: 'priestess', tagIds: [tag.id, tag.id], sortOrder: 0 }],
    }, 'PUT'));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; issues: unknown[] };
    expect(body.error).toBe('validation failed');
    expect(body.issues.length).toBeGreaterThan(0);
  });

  test('PUT /prompts/lists/:id/options accepts weight per option and round-trips it', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);

    const res = await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, {
      options: [
        { value: 'common', tagIds: [], sortOrder: 0, weight: 5 },
        { value: 'rare', tagIds: [], sortOrder: 1, weight: 1 },
        { value: 'default', tagIds: [], sortOrder: 2 },
      ],
    }, 'PUT'));
    expect(res.status).toBe(200);

    const lib = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts')), 200);
    const updated = lib.variableLists.find((variableList) => variableList.id === list.id);
    expect(updated?.options.map((option) => [option.value, option.weight])).toEqual([
      ['common', 5],
      ['rare', 1],
      ['default', 1],
    ]);
  });

  test('weight 0 round-trips through bulk replace and PATCH while another option remains automatic', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);

    const bulkSaved = await expectJson<VariableList>(
      await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, {
        options: [
          { value: 'bulk manual', tagIds: [], sortOrder: 0, weight: 0 },
          { value: 'patch manual', tagIds: [], sortOrder: 1, weight: 1 },
          { value: 'automatic', tagIds: [], sortOrder: 2, weight: 5 },
        ],
      }, 'PUT')),
      200,
    );
    expect(bulkSaved.options.find((option) => option.value === 'bulk manual')?.weight).toBe(0);

    const patchTarget = bulkSaved.options.find((option) => option.value === 'patch manual');
    if (!patchTarget) throw new Error('expected patch target');
    const patch = await app.fetch(jsonReq(
      `/api/prompts/lists/${list.id}/options/${patchTarget.id}`,
      { weight: 0 },
      'PATCH',
    ));
    expect(patch.status).toBe(204);

    const library = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts')), 200);
    const saved = library.variableLists.find((variableList) => variableList.id === list.id);
    expect(saved?.options.map((option) => [option.value, option.weight])).toEqual([
      ['bulk manual', 0],
      ['patch manual', 0],
      ['automatic', 5],
    ]);
  });

  test('PUT /prompts/lists/:id/options rejects an all-manual replacement', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);

    const res = await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, {
      options: [
        { value: 'manual one', tagIds: [], sortOrder: 0, weight: 0 },
        { value: 'manual two', tagIds: [], sortOrder: 1, weight: 0 },
      ],
    }, 'PUT'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: AUTO_SELECTION_REQUIRED });
  });

  test('bulk option removal cannot strand only manual options', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);
    const seeded = await replaceOptions(app, list.id, [
      { value: 'manual', tagIds: [], sortOrder: 0, weight: 0 },
      { value: 'automatic', tagIds: [], sortOrder: 1, weight: 1 },
    ]);
    const manual = seeded.options.find((option) => option.value === 'manual');
    if (!manual) throw new Error('expected manual option');

    const res = await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, {
      options: [{ id: manual.id, value: manual.value, tagIds: [], sortOrder: 0, weight: 0 }],
    }, 'PUT'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: AUTO_SELECTION_REQUIRED });
    const library = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts')), 200);
    expect(library.variableLists.find((variableList) => variableList.id === list.id)?.options).toHaveLength(2);
  });

  test('clearing a list entirely is still allowed', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);
    await replaceOptions(app, list.id, [
      { value: 'manual', tagIds: [], sortOrder: 0, weight: 0 },
      { value: 'automatic', tagIds: [], sortOrder: 1, weight: 1 },
    ]);

    const res = await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, { options: [] }, 'PUT'));

    expect(res.status).toBe(200);
    const library = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts')), 200);
    expect(library.variableLists.find((variableList) => variableList.id === list.id)?.options).toHaveLength(0);
  });

  test('PUT /prompts/lists/:id/options rejects out-of-range weight', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);

    const res = await app.fetch(jsonReq(`/api/prompts/lists/${list.id}/options`, {
      options: [{ value: 'too-heavy', tagIds: [], sortOrder: 0, weight: 101 }],
    }, 'PUT'));

    expect(res.status).toBe(400);
  });

  test('PATCH /prompts/lists/:listId/options/:optionId updates weight and preserves option id', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);
    const seeded = await replaceOptions(app, list.id, [
      { value: 'opt', tagIds: [], sortOrder: 0 },
    ]);
    const beforeOption = seeded.options[0];
    if (!beforeOption) throw new Error('expected option');

    const patch = await app.fetch(jsonReq(
      `/api/prompts/lists/${list.id}/options/${beforeOption.id}`,
      { weight: 7 },
      'PATCH',
    ));
    expect(patch.status).toBe(204);

    const after = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts')), 200);
    const afterOption = after.variableLists
      .find((variableList) => variableList.id === list.id)?.options[0];
    expect(afterOption?.id).toBe(beforeOption.id);
    expect(afterOption?.weight).toBe(7);
    expect(afterOption?.value).toBe('opt');
  });

  test('PATCH /prompts/lists/:listId/options/:optionId rejects making the last automatic option manual-only', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);
    const seeded = await replaceOptions(app, list.id, [
      { value: 'only option', tagIds: [], sortOrder: 0, weight: 1 },
    ]);
    const option = seeded.options[0];
    if (!option) throw new Error('expected option');

    const res = await app.fetch(jsonReq(
      `/api/prompts/lists/${list.id}/options/${option.id}`,
      { weight: 0 },
      'PATCH',
    ));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: AUTO_SELECTION_REQUIRED });
    const library = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts')), 200);
    expect(library.variableLists.find((variableList) => variableList.id === list.id)?.options[0]?.weight).toBe(1);
  });

  test('PATCH /prompts/lists/:listId/options/:optionId returns 404 for unknown option', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);

    const res = await app.fetch(jsonReq(
      `/api/prompts/lists/${list.id}/options/00000000-0000-0000-0000-000000000000`,
      { weight: 5 },
      'PATCH',
    ));

    expect(res.status).toBe(404);
  });

  test('PATCH /prompts/lists/:listId/options/:optionId rejects empty body', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);
    const seeded = await replaceOptions(app, list.id, [
      { value: 'opt', tagIds: [], sortOrder: 0 },
    ]);
    const option = seeded.options[0];
    if (!option) throw new Error('expected option');

    const res = await app.fetch(jsonReq(
      `/api/prompts/lists/${list.id}/options/${option.id}`,
      {},
      'PATCH',
    ));

    expect(res.status).toBe(400);
  });

  test('PATCH /prompts/lists/:listId/options/:optionId rejects weight outside 0..100 and non-integer', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);
    const seeded = await replaceOptions(app, list.id, [
      { value: 'opt', tagIds: [], sortOrder: 0 },
    ]);
    const option = seeded.options[0];
    if (!option) throw new Error('expected option');

    for (const badWeight of [-1, 101, 1.5]) {
      const res = await app.fetch(jsonReq(
        `/api/prompts/lists/${list.id}/options/${option.id}`,
        { weight: badWeight },
        'PATCH',
      ));
      expect(res.status).toBe(400);
    }
  });

  test('PATCH /prompts/lists/:listId/options/:optionId rejects tagIds the user does not own', async () => {
    // Single runtime, two PROMPT_LIBRARY_USERS. Alice has the list+option; Bob
    // owns his own dimension+tag. Alice cannot reference Bob's tagId.
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice,bob' });
    const aliceList = await createList(app, 'alice-list', 'alice');
    const aliceSeeded = await replaceOptions(app, aliceList.id, [
      { value: 'opt', tagIds: [], sortOrder: 0 },
    ], 'alice');
    const aliceOption = aliceSeeded.options[0];
    if (!aliceOption) throw new Error('expected option');

    const bobDimension = await createDimension(app, 'foreign-dim', 'bob');
    const bobTags = await replaceTags(app, bobDimension.id, [{ label: 'foreign', sortOrder: 0 }], 'bob');
    const bobTag = bobTags.tags[0];
    if (!bobTag) throw new Error('expected bob tag');

    const res = await app.fetch(jsonReq(
      `/api/prompts/lists/${aliceList.id}/options/${aliceOption.id}`,
      { tagIds: [bobTag.id] },
      'PATCH',
      'alice',
    ));
    expect(res.status).toBe(400);
  });

  test('set-replacing options rewrites options and option_tags atomically', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);
    const dimension = await createDimension(app);
    const tags = await replaceTags(app, dimension.id, [
      { label: 'ancient', sortOrder: 0 },
      { label: 'modern', sortOrder: 1 },
    ]);
    const ancient = tags.tags.find((tag) => tag.label === 'ancient');
    const modern = tags.tags.find((tag) => tag.label === 'modern');
    if (!ancient || !modern) throw new Error('expected tags');

    const first = await replaceOptions(app, list.id, [
      { value: 'priestess', tagIds: [ancient.id], sortOrder: 0 },
      { value: 'astronaut', tagIds: [modern.id], sortOrder: 1 },
    ]);
    expect(first.options.map((option) => ({ value: option.value, tagIds: option.tagIds }))).toEqual([
      { value: 'priestess', tagIds: [ancient.id] },
      { value: 'astronaut', tagIds: [modern.id] },
    ]);

    const second = await replaceOptions(app, list.id, [
      { value: 'archivist', tagIds: [ancient.id, modern.id], sortOrder: 0 },
    ]);
    expect(second.options.map((option) => ({ value: option.value, tagIds: option.tagIds }))).toEqual([
      { value: 'archivist', tagIds: [ancient.id, modern.id] },
    ]);

    const library = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts')), 200);
    const fetched = library.variableLists[0];
    expect(fetched?.options.map((option: VariableOption) => ({ value: option.value, tagIds: option.tagIds }))).toEqual([
      { value: 'archivist', tagIds: [ancient.id, modern.id] },
    ]);
  });

  test('set-replacing tags preserves option tag links for retained tag ids and drops removed tag links', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const list = await createList(app);
    const dimension = await createDimension(app);
    const tags = await replaceTags(app, dimension.id, [
      { label: 'ancient', sortOrder: 0 },
      { label: 'modern', sortOrder: 1 },
    ]);
    const ancient = tags.tags.find((tag) => tag.label === 'ancient');
    const modern = tags.tags.find((tag) => tag.label === 'modern');
    if (!ancient || !modern) throw new Error('expected tags');

    await replaceOptions(app, list.id, [
      { value: 'priestess', tagIds: [ancient.id, modern.id], sortOrder: 0 },
    ]);

    const reordered = await replaceTags(app, dimension.id, [
      { id: modern.id, label: 'modern', sortOrder: 0 },
      { id: ancient.id, label: 'ancient', sortOrder: 1 },
    ]);
    expect(reordered.tags.map((tag) => tag.id)).toEqual([modern.id, ancient.id]);

    const afterReorder = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts')), 200);
    const reorderedOption = afterReorder.variableLists[0]?.options[0];
    expect(reorderedOption?.tagIds).toEqual([modern.id, ancient.id]);

    await replaceTags(app, dimension.id, [
      { id: modern.id, label: 'modern', sortOrder: 0 },
    ]);

    const afterRemove = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts')), 200);
    const remainingOption = afterRemove.variableLists[0]?.options[0];
    expect(remainingOption?.tagIds).toEqual([modern.id]);
  });

  test('does not expose cross-user option_tags rows in prompt list responses', async () => {
    const { app, db } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice,bob' });
    const aliceList = await createList(app, 'subject', 'alice');
    const bobDimension = await createDimension(app, 'era', 'bob');
    const bobTags = await replaceTags(app, bobDimension.id, [{ label: 'modern', sortOrder: 0 }], 'bob');
    const bobTag = bobTags.tags[0];
    if (!bobTag) throw new Error('expected tag');
    const aliceOptions = await replaceOptions(app, aliceList.id, [
      { value: 'priestess', tagIds: [], sortOrder: 0 },
    ], 'alice');
    const aliceOption = aliceOptions.options[0];
    if (!aliceOption) throw new Error('expected option');
    db.run('INSERT INTO option_tags (option_id, tag_id) VALUES (?, ?)', [aliceOption.id, bobTag.id]);

    const library = await expectJson<PromptLibraryResponse>(await app.fetch(authedReq('/api/prompts', 'GET', 'alice')), 200);

    expect(library.variableLists[0]?.options[0]?.tagIds).toEqual([]);
  });

  test('rejects option set-replace with a tagId not owned by the user', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice,bob' });
    const aliceList = await createList(app, 'subject', 'alice');
    const bobDimension = await createDimension(app, 'era', 'bob');
    const bobTags = await replaceTags(app, bobDimension.id, [{ label: 'modern', sortOrder: 0 }], 'bob');
    const bobTag = bobTags.tags[0];
    if (!bobTag) throw new Error('expected tag');

    const res = await app.fetch(jsonReq(`/api/prompts/lists/${aliceList.id}/options`, {
      options: [{ value: 'astronaut', tagIds: [bobTag.id], sortOrder: 0 }],
    }, 'PUT', 'alice'));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown tagId' });
  });

  test('rejects mismatched template order id set with 409', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const one = await createTemplate(app, { name: 'One', body: '1' });
    await createTemplate(app, { name: 'Two', body: '2' });

    const res = await app.fetch(jsonReq('/api/prompts/templates/order', { orderedIds: [one.id] }, 'PUT'));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'orderedIds must match current templates' });
  });

  test('returns 400 with issues on validation failure', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });

    const res = await app.fetch(jsonReq('/api/prompts/templates', { name: '', body: '', extra: true }));

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; issues: unknown[] };
    expect(body.error).toBe('validation failed');
    expect(body.issues.length).toBeGreaterThan(0);
  });

  test('GET /prompts emits an ETag and honors If-None-Match with 304', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });

    await createTemplate(app, { name: 'Portrait', body: 'p' });
    await createList(app, 'subject');
    await createDimension(app, 'era');

    const first = await app.fetch(authedReq('/api/prompts'));
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f-]{36}:[0-9a-f]{16}"$/);
    expect(first.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    await first.json();

    const conditional = await app.fetch(new Request('http://local/api/prompts', {
      headers: { 'Remote-User': 'alice', 'If-None-Match': etag ?? '' },
    }));
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('etag')).toBe(etag);
    expect(conditional.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(await conditional.text()).toBe('');

    const stale = await app.fetch(new Request('http://local/api/prompts', {
      headers: { 'Remote-User': 'alice', 'If-None-Match': '"deadbeefdeadbeef"' },
    }));
    expect(stale.status).toBe(200);
    expect(stale.headers.get('etag')).toBe(etag);

    await createTemplate(app, { name: 'Landscape', body: 'l' });
    const afterChange = await app.fetch(new Request('http://local/api/prompts', {
      headers: { 'Remote-User': 'alice', 'If-None-Match': etag ?? '' },
    }));
    expect(afterChange.status).toBe(200);
    expect(afterChange.headers.get('etag')).not.toBe(etag);
  });

  test('GET /prompts conditional 304 does not hydrate the prompt library', async () => {
    const { app, db } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });

    await createTemplate(app, { name: 'Portrait', body: 'p' });
    const list = await createList(app, 'subject');
    const dimension = await createDimension(app, 'era');
    const tagged = await replaceTags(app, dimension.id, [{ label: 'noir', sortOrder: 0 }]);
    const tag = tagged.tags[0];
    if (!tag) throw new Error('expected tag');
    await replaceOptions(app, list.id, [{ value: 'detective', tagIds: [tag.id], sortOrder: 0 }]);

    const first = await app.fetch(authedReq('/api/prompts'));
    const etag = first.headers.get('etag');
    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();
    await first.json();

    const realQuery = db.query.bind(db);
    const observedSql: string[] = [];
    const spy: { query: typeof db.query } = db;
    spy.query = ((sql: string) => {
      observedSql.push(sql);
      return realQuery(sql);
    });
    const conditional = await app.fetch(new Request('http://local/api/prompts', {
      headers: { 'Remote-User': 'alice', 'If-None-Match': etag ?? '' },
    }));
    spy.query = realQuery;

    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('etag')).toBe(etag);
    expect(observedSql.filter((sql) => (
      /FROM prompt_templates/i.test(sql) ||
      /FROM variable_lists/i.test(sql) ||
      /FROM variable_options/i.test(sql) ||
      /FROM tag_dimensions/i.test(sql) ||
      /FROM dimension_tags/i.test(sql) ||
      /FROM option_tags/i.test(sql)
    ))).toEqual([]);
  });
});
