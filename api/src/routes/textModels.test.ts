import { describe, expect, test } from 'bun:test';
import { TEXT_TASKS, type TextModelsResponse } from '@atelier/shared';
import { bumpTextConfigRevision } from '../db/textProviders';
import { listedTextAvailability, testConfig, testRuntime } from '../test/helpers';

const config = testConfig();
const KIMI = config.CLIPROXY_TEXT_MODEL_KIMI;
// Every seeded upstream id except DeepSeek Abliterated's: that one is offline.
const WITHOUT_DEEPSEEK = listedTextAvailability(new Set([
  KIMI,
  config.CLIPROXY_TEXT_MODEL_MIMO,
  config.CLIPROXY_TEXT_MODEL_GROK,
  config.CLIPROXY_TEXT_MODEL_GEMINI_ARGON,
  config.CLIPROXY_TEXT_MODEL_GLM_ABLITERATED,
  config.CLIPROXY_TEXT_MODEL_GPT,
]));

function headers(user = 'alice') {
  return { 'Content-Type': 'application/json', 'Remote-User': user };
}

type Runtime = ReturnType<typeof testRuntime>;

function rowId(rt: Runtime, legacyKey: string): string {
  const row = rt.db.query<{ id: string }, [string]>('SELECT id FROM text_models WHERE legacy_key = ?').get(legacyKey);
  if (!row) throw new Error(`no seeded model ${legacyKey}`);
  return row.id;
}

async function getModels(rt: Runtime, user = 'alice'): Promise<TextModelsResponse> {
  const res = await rt.fetch('/api/text-models', { headers: headers(user) });
  expect(res.status).toBe(200);
  return await res.json() as TextModelsResponse;
}

function put(rt: Runtime, task: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return rt.fetch(`/api/text-models/tasks/${task}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(body),
    ...init,
  });
}

function taskRow(body: TextModelsResponse, task: string) {
  return body.tasks.find((row) => row.task === task);
}

describe('GET /api/text-models', () => {
  test('a fresh install lists no models and one bare row per task, uncached', async () => {
    const rt = testRuntime();
    const res = await rt.fetch('/api/text-models', { headers: headers() });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      models: [],
      tasks: TEXT_TASKS.map((task) => ({ task })),
      defaults: { byTask: {} },
      writers: {},
    });
  });

  test('is open to every signed-in user, not only prompt-library users', async () => {
    const rt = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', seedLegacyText: true });
    const body = await getModels(rt, 'mallory');
    expect(body.models).toHaveLength(7);
  });

  test('lists the seeded models with their levels and status, and resolves every task to the default', async () => {
    const rt = testRuntime({ seedLegacyText: true, textAvailability: WITHOUT_DEEPSEEK });
    const body = await getModels(rt);
    const kimi = rowId(rt, 'kimi');
    const gpt = rowId(rt, 'gpt');

    expect(body.models.find((model) => model.id === kimi)).toEqual({
      id: kimi,
      displayName: expect.any(String) as string,
      providerName: expect.any(String) as string,
      vision: true,
      reasoningLevels: ['low', 'high', 'max'],
      status: 'available',
    });
    expect(body.models.find((model) => model.id === rowId(rt, 'deepseek-abliterated'))?.status).toBe('offline');
    // Fixed-effort model: users cannot pick a level.
    expect(body.models.find((model) => model.id === gpt)?.reasoningLevels).toEqual([]);
    expect(body.defaults).toEqual({ default: kimi, byTask: {} });
    expect(Object.values(body.writers).every((id) => id === gpt)).toBe(true);
    expect(Object.keys(body.writers).length).toBeGreaterThan(0);
    // Resolved without vision and without an image model: the writers never apply.
    expect(body.tasks).toEqual(TEXT_TASKS.map((task) => ({ task, effectiveModelId: kimi })));
  });

  test('an offline pick is reported with the model the task falls back to', async () => {
    const rt = testRuntime({ seedLegacyText: true, textAvailability: WITHOUT_DEEPSEEK });
    rt.db.query("INSERT INTO users (id, created_at) VALUES ('alice', 1)").run();
    rt.db.query("INSERT INTO user_text_models (user_id, task, text_model_id, effort, updated_at) VALUES ('alice', 'ai-fill', ?, 'low', 1)")
      .run(rowId(rt, 'deepseek-abliterated'));
    const body = await getModels(rt);
    expect(taskRow(body, 'ai-fill')).toEqual({
      task: 'ai-fill',
      pick: rowId(rt, 'deepseek-abliterated'),
      effort: 'low',
      effectiveModelId: rowId(rt, 'kimi'),
      pickState: 'offline',
    });
  });

  test('reports a stored effort only while the picked model still offers it', async () => {
    const rt = testRuntime({ seedLegacyText: true });
    const kimi = rowId(rt, 'kimi');
    rt.db.query("INSERT INTO users (id, created_at) VALUES ('alice', 1)").run();
    rt.db.query("INSERT INTO user_text_models (user_id, task, text_model_id, effort, updated_at) VALUES ('alice', 'enhance', ?, 'max', 1)")
      .run(kimi);
    expect(taskRow(await getModels(rt), 'enhance')?.effort).toBe('max');

    // An admin removes the level from the model.
    rt.db.query('UPDATE text_models SET reasoning_levels = ? WHERE id = ?').run(JSON.stringify(['low', 'high']), kimi);
    bumpTextConfigRevision();
    expect(taskRow(await getModels(rt), 'enhance')).toEqual({
      task: 'enhance', pick: kimi, effectiveModelId: kimi, pickState: 'active',
    });
  });
});

describe('PUT /api/text-models/tasks/:task', () => {
  test('stores a pick with its effort, returns the fresh settings, and null clears both', async () => {
    const rt = testRuntime({ seedLegacyText: true });
    const mimo = rowId(rt, 'mimo');
    const stored = await put(rt, 'enhance', { modelId: mimo, effort: 'high' });
    expect(stored.status).toBe(200);
    expect(stored.headers.get('cache-control')).toBe('private, no-store');
    const body = await stored.json() as TextModelsResponse;
    expect(taskRow(body, 'enhance')).toEqual({
      task: 'enhance', pick: mimo, effort: 'high', effectiveModelId: mimo, pickState: 'active',
    });

    const cleared = await put(rt, 'enhance', { modelId: null });
    expect(cleared.status).toBe(200);
    expect(taskRow(await cleared.json() as TextModelsResponse, 'enhance')).toEqual({
      task: 'enhance', effectiveModelId: rowId(rt, 'kimi'),
    });
    expect(rt.db.query('SELECT COUNT(*) AS count FROM user_text_models').get()).toEqual({ count: 0 });
  });

  test('a first pick without an effort stores none', async () => {
    const rt = testRuntime({ seedLegacyText: true });
    const res = await put(rt, 'motion', { modelId: rowId(rt, 'grok') });
    expect(taskRow(await res.json() as TextModelsResponse, 'motion')).toEqual({
      task: 'motion', pick: rowId(rt, 'grok'), effectiveModelId: rowId(rt, 'grok'), pickState: 'active',
    });
  });

  test('an omitted effort keeps the stored one while the new model offers it, and drops it otherwise', async () => {
    const rt = testRuntime({ seedLegacyText: true });
    const levels = (id: string) => rt.db.query<{ reasoning_levels: string }, [string]>(
      'SELECT reasoning_levels FROM text_models WHERE id = ?',
    ).get(id)?.reasoning_levels;
    const kimi = rowId(rt, 'kimi');
    const mimo = rowId(rt, 'mimo');
    // Mimo offers 'high' but not 'max' (Kimi offers both).
    expect(JSON.parse(levels(mimo) ?? '[]')).toContain('high');
    expect(JSON.parse(levels(mimo) ?? '[]')).not.toContain('max');

    await put(rt, 'motion', { modelId: kimi, effort: 'high' });
    const kept = await put(rt, 'motion', { modelId: mimo });
    expect(taskRow(await kept.json() as TextModelsResponse, 'motion')).toEqual({
      task: 'motion', pick: mimo, effort: 'high', effectiveModelId: mimo, pickState: 'active',
    });

    await put(rt, 'motion', { modelId: kimi, effort: 'max' });
    const dropped = await put(rt, 'motion', { modelId: mimo });
    expect(taskRow(await dropped.json() as TextModelsResponse, 'motion')).toEqual({
      task: 'motion', pick: mimo, effectiveModelId: mimo, pickState: 'active',
    });
    // Dropped for good: switching back does not revive it.
    const back = await put(rt, 'motion', { modelId: kimi });
    expect(taskRow(await back.json() as TextModelsResponse, 'motion')?.effort).toBeUndefined();
  });

  test('an explicit null effort clears the stored one', async () => {
    const rt = testRuntime({ seedLegacyText: true });
    const kimi = rowId(rt, 'kimi');
    await put(rt, 'motion', { modelId: kimi, effort: 'high' });
    const res = await put(rt, 'motion', { modelId: kimi, effort: null });
    expect(taskRow(await res.json() as TextModelsResponse, 'motion')).toEqual({
      task: 'motion', pick: kimi, effectiveModelId: kimi, pickState: 'active',
    });
  });

  test('rejects an effort the model does not offer, including any effort on a fixed-effort model', async () => {
    const rt = testRuntime({ seedLegacyText: true });
    expect((await put(rt, 'enhance', { modelId: rowId(rt, 'mimo'), effort: 'low' })).status).toBe(400);
    expect((await put(rt, 'enhance', { modelId: rowId(rt, 'gpt'), effort: 'medium' })).status).toBe(400);
    expect((await put(rt, 'enhance', { modelId: null, effort: 'low' })).status).toBe(400);
    expect((await put(rt, 'enhance', { modelId: rowId(rt, 'kimi'), effort: 'extreme' })).status).toBe(400);
    // A fixed-effort model is still pickable without an effort.
    expect((await put(rt, 'enhance', { modelId: rowId(rt, 'gpt') })).status).toBe(200);
    expect((await put(rt, 'enhance', { modelId: rowId(rt, 'gpt'), effort: null })).status).toBe(200);
  });

  test('rejects an unknown task, an unknown model and a disabled model', async () => {
    const rt = testRuntime({ seedLegacyText: true });
    expect((await put(rt, 'not-a-task', { modelId: rowId(rt, 'kimi') })).status).toBe(400);
    expect((await put(rt, 'enhance', { modelId: crypto.randomUUID() })).status).toBe(400);
    // Legacy keys are not model ids.
    expect((await put(rt, 'enhance', { modelId: 'kimi' })).status).toBe(400);

    rt.db.query('UPDATE text_models SET enabled = 0 WHERE legacy_key = ?').run('grok');
    bumpTextConfigRevision();
    const disabled = await put(rt, 'enhance', { modelId: rowId(rt, 'grok') });
    expect(disabled.status).toBe(400);
    expect(rt.db.query('SELECT COUNT(*) AS count FROM user_text_models').get()).toEqual({ count: 0 });
  });

  test('rejects an offline model and still accepts null', async () => {
    const rt = testRuntime({ seedLegacyText: true, textAvailability: WITHOUT_DEEPSEEK });
    const rejected = await put(rt, 'brainstorm', { modelId: rowId(rt, 'deepseek-abliterated') });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: string }).error).toContain('offline');
    expect((await put(rt, 'brainstorm', { modelId: null })).status).toBe(200);
  });

  test('sits under the CSRF guard', async () => {
    const rt = testRuntime({ seedLegacyText: true, CSRF_PROTECT: 'true' });
    const res = await put(rt, 'enhance', { modelId: rowId(rt, 'kimi') }, {
      headers: { ...headers(), Host: 'atelier.local', Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});
