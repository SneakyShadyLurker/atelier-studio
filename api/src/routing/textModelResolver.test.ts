import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TextModelStatus, TextTask } from '@atelier/shared';
import { migrate } from '../db/migrate';
import {
  createTextProviderStore,
  type NewTextModel,
  type TextModelRecord,
  type TextProviderStore,
} from '../db/textProviders';
import { LEGACY_SEED, type LegacyTextKey, type TextSeed } from '../db/textSeed';
import { createTextConfigSnapshot, type TextConfigSnapshot } from './textConfigSnapshot';
import {
  resolveTextModel,
  type ResolvedTextModel,
  type ResolveTextModelInput,
} from './textModelResolver';

const SUNBURST = 'gpt-image-2.5-sunburst';
const GPT_IMAGE = 'gpt-image-2';
const LOCAL_IMAGE = 'krea-2-turbo';
const BYOK_IMAGE = 'gemini-3.1-flash-image-preview';

const SEED: TextSeed = {
  baseUrl: 'http://cliproxy.lan:8317',
  modelIds: Object.fromEntries(LEGACY_SEED.models.map((model) => [model.legacyKey, model.defaultModelId])) as Record<
    LegacyTextKey,
    string
  >,
  sunburstImageModelIds: [SUNBURST],
  gptImageModelIds: [GPT_IMAGE],
};

/** Live availability fake keyed by upstream model id; anything unset is 'unknown'. */
function fakeAvailability(): {
  statusOf: (model: Pick<TextModelRecord, 'providerId' | 'modelId'>) => TextModelStatus;
  set: (upstreamId: string, status: TextModelStatus) => void;
} {
  const statuses = new Map<string, TextModelStatus>();
  return {
    statusOf: (model) => statuses.get(model.modelId) ?? 'unknown',
    set: (upstreamId, status) => { statuses.set(upstreamId, status); },
  };
}

interface Harness {
  readonly db: Database;
  readonly store: TextProviderStore;
  readonly snapshot: TextConfigSnapshot;
  readonly availability: ReturnType<typeof fakeAvailability>;
  readonly resolve: (input: Partial<ResolveTextModelInput> & { task: TextTask }) => ResolvedTextModel;
  readonly close: () => void;
}

const open: Harness[] = [];

afterEach(() => {
  for (const harness of open.splice(0)) harness.close();
});

function harnessFor(db: Database, dataDir: string): Harness {
  const store = createTextProviderStore({ db });
  const snapshot = createTextConfigSnapshot(store);
  const availability = fakeAvailability();
  const harness: Harness = {
    db,
    store,
    snapshot,
    availability,
    resolve: (input) => resolveTextModel({ store, snapshot, availability }, { userId: 'alice', ...input }),
    close: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  open.push(harness);
  return harness;
}

/** A real upgrade: v57 database, then migration 58 with the legacy seed. */
function openSeeded(): Harness & { readonly ids: Readonly<Record<LegacyTextKey, string>> } {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-text-resolver-'));
  const db = new Database(':memory:');
  migrate(db, dataDir, { targetVersion: 57 });
  migrate(db, dataDir, { textSeed: SEED });
  const harness = harnessFor(db, dataDir);
  const ids = Object.fromEntries(
    harness.store.listModels().map((model) => [model.legacyKey, model.id]),
  ) as Record<LegacyTextKey, string>;
  expect(Object.keys(ids).sort()).toEqual(LEGACY_SEED.models.map((model) => model.legacyKey).sort());
  return { ...harness, ids };
}

/** A fresh install with no rows. */
function openEmpty(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-text-resolver-'));
  const db = new Database(':memory:');
  migrate(db, dataDir);
  return harnessFor(db, dataDir);
}

/** One keyless provider with the given models; returns row ids keyed by upstream id. */
async function addProvider(
  store: TextProviderStore,
  name: string,
  models: readonly NewTextModel[],
): Promise<{ providerId: string; ids: Record<string, string> }> {
  const provider = await store.createProvider({ name, protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1' });
  const created = store.createModels(provider.id, models);
  return { providerId: provider.id, ids: Object.fromEntries(created.map((model) => [model.modelId, model.id])) };
}

/**
 * A small custom configuration: Alpha (vision), Beta (vision), Text (no
 * vision, reasoning low/high), Writer (vision) on one provider.
 */
type CustomIds = Readonly<Record<'alpha' | 'beta' | 'text' | 'writer', string>>;

async function openCustom(): Promise<Harness & { readonly ids: CustomIds; readonly providerId: string }> {
  const harness = openEmpty();
  const { providerId, ids } = await addProvider(harness.store, 'Local', [
    { modelId: 'alpha', vision: true, reasoningLevels: ['low', 'high'], reasoningDefault: 'low' },
    { modelId: 'beta', vision: true },
    { modelId: 'text', vision: false, reasoningLevels: ['low', 'high'], reasoningDefault: 'low' },
    { modelId: 'writer', vision: true },
  ]);
  return {
    ...harness,
    ids: { alpha: must(ids.alpha), beta: must(ids.beta), text: must(ids.text), writer: must(ids.writer) },
    providerId,
  };
}

function must(id: string | undefined): string {
  if (id === undefined) throw new Error('missing model row');
  return id;
}

function served(result: ResolvedTextModel): { modelId: string; source: string } | { fail: string } {
  return result.ok ? { modelId: result.model.id, source: result.source } : { fail: result.reason };
}

describe('resolveTextModel - seeded legacy configuration (ports of textBackendPreference.test.ts)', () => {
  test('with no pick every task resolves to the seeded default, Kimi', () => {
    const { resolve, ids } = openSeeded();
    for (const task of ['ai-fill', 'enhance', 'brainstorm', 'condense', 'storytelling'] as const) {
      expect(served(resolve({ task }))).toEqual({ modelId: ids.kimi, source: 'default' });
    }
  });

  test('GPT reaches GPT-family targets only through prefer writers; local and BYOK targets get the default', () => {
    const { resolve, ids, store } = openSeeded();
    // The seed carries no GPT pins: the migration dropped them, and GPT comes from writers.
    expect(store.readUserPicks('alice')).toEqual({});
    expect(served(resolve({ task: 'ai-fill', imageModelId: GPT_IMAGE }))).toEqual({ modelId: ids.gpt, source: 'writer' });
    expect(served(resolve({ task: 'enhance', imageModelId: GPT_IMAGE }))).toEqual({ modelId: ids.gpt, source: 'writer' });
    expect(served(resolve({ task: 'ai-fill', imageModelId: LOCAL_IMAGE }))).toEqual({ modelId: ids.kimi, source: 'default' });
    expect(served(resolve({ task: 'enhance' }))).toEqual({ modelId: ids.kimi, source: 'default' });
    for (const task of ['ai-fill', 'brainstorm', 'enhance'] as const) {
      expect(served(resolve({ task, imageModelId: BYOK_IMAGE }))).toEqual({ modelId: ids.kimi, source: 'default' });
    }
    expect(served(resolve({ task: 'enhance', imageModelId: BYOK_IMAGE, visionRequired: true }))).toEqual({
      modelId: ids.kimi,
      source: 'default',
    });
  });

  test('a Sunburst target is locked to GPT over a user pick without rewriting the stored pick', () => {
    const { resolve, ids, store } = openSeeded();
    store.writeUserPick('alice', 'enhance', { modelId: ids.mimo, effort: null });
    expect(served(resolve({ task: 'enhance', imageModelId: SUNBURST, visionRequired: true }))).toEqual({
      modelId: ids.gpt,
      source: 'writer',
    });
    expect(store.readUserPicks('alice').enhance?.modelId).toBe(ids.mimo);
    expect(served(resolve({ task: 'enhance', imageModelId: LOCAL_IMAGE }))).toEqual({ modelId: ids.mimo, source: 'user' });
  });

  test('a Sunburst target stays on GPT when the provider list misses it', () => {
    // Like legacy: a locked writer ignores the inventory; the call itself reports a real outage.
    const { resolve, ids, availability } = openSeeded();
    availability.set(SEED.modelIds.gpt, 'offline');
    availability.set(SEED.modelIds.kimi, 'available');
    expect(served(resolve({ task: 'enhance', imageModelId: SUNBURST }))).toEqual({ modelId: ids.gpt, source: 'writer' });
  });

  test('a GPT-family image call uses the GPT writer unless the user picked a vision model', () => {
    const { resolve, ids, store } = openSeeded();
    const input = { task: 'enhance', imageModelId: GPT_IMAGE, visionRequired: true } as const;
    expect(served(resolve(input))).toEqual({ modelId: ids.gpt, source: 'writer' });
    store.writeUserPick('alice', 'enhance', { modelId: ids.grok, effort: null });
    expect(served(resolve(input))).toEqual({ modelId: ids.grok, source: 'user' });
    store.writeUserPick('alice', 'enhance', { modelId: ids['deepseek-abliterated'], effort: null });
    expect(served(resolve(input))).toEqual({ modelId: ids.gpt, source: 'writer' });
  });

  test("a user's pick serves only that user", () => {
    const { resolve, ids, store } = openSeeded();
    store.writeUserPick('alice', 'ai-fill', { modelId: ids['gemini-argon'], effort: null });
    expect(served(resolve({ task: 'ai-fill' }))).toEqual({ modelId: ids['gemini-argon'], source: 'user' });
    expect(served(resolve({ task: 'ai-fill', userId: 'other-user' }))).toEqual({ modelId: ids.kimi, source: 'default' });
  });

  test('every task serves its own pick', () => {
    const { resolve, ids, store } = openSeeded();
    const picks = {
      'ai-fill': ids.mimo,
      brainstorm: ids.grok,
      enhance: ids['gemini-argon'],
      condense: ids['deepseek-abliterated'],
      storytelling: ids['glm-abliterated'],
    } as const;
    for (const [task, modelId] of Object.entries(picks)) {
      store.writeUserPick('alice', task as TextTask, { modelId, effort: null });
    }
    for (const [task, modelId] of Object.entries(picks)) {
      expect(served(resolve({ task: task as TextTask }))).toEqual({ modelId, source: 'user' });
    }
  });

  test('a pick on a disabled or deleted model falls back to the default', () => {
    const { resolve, ids, store } = openSeeded();
    store.writeUserPick('alice', 'brainstorm', { modelId: ids.grok, effort: null });
    store.updateModel(ids.grok, { enabled: false });
    expect(served(resolve({ task: 'brainstorm' }))).toEqual({ modelId: ids.kimi, source: 'default' });
    store.writeUserPick('alice', 'ai-fill', { modelId: ids.mimo, effort: null });
    store.deleteModel(ids.mimo);
    expect(store.readUserPicks('alice')['ai-fill']).toBeUndefined();
    expect(served(resolve({ task: 'ai-fill' }))).toEqual({ modelId: ids.kimi, source: 'default' });
  });

  test('clearing a pick returns the task to the default', () => {
    const { resolve, ids, store } = openSeeded();
    store.writeUserPick('alice', 'brainstorm', { modelId: ids.grok, effort: null });
    store.writeUserPick('alice', 'brainstorm', null);
    expect(served(resolve({ task: 'brainstorm' }))).toEqual({ modelId: ids.kimi, source: 'default' });
  });

  test('an offline pick falls back, stays stored, and is reported offline', () => {
    const { resolve, ids, store, availability } = openSeeded();
    store.writeUserPick('alice', 'ai-fill', { modelId: ids['deepseek-abliterated'], effort: null });
    availability.set(SEED.modelIds['deepseek-abliterated'], 'offline');
    const result = resolve({ task: 'ai-fill', imageModelId: LOCAL_IMAGE });
    expect(served(result)).toEqual({ modelId: ids.kimi, source: 'default' });
    expect(result.pickState).toBe('offline');
    expect(store.readUserPicks('alice')['ai-fill']?.modelId).toBe(ids['deepseek-abliterated']);
  });

  test('an unknown availability honours the pick', () => {
    const { resolve, ids, store } = openSeeded();
    store.writeUserPick('alice', 'ai-fill', { modelId: ids['deepseek-abliterated'], effort: null });
    const result = resolve({ task: 'ai-fill', imageModelId: LOCAL_IMAGE });
    expect(served(result)).toEqual({ modelId: ids['deepseek-abliterated'], source: 'user' });
    expect(result.pickState).toBe('active');
  });

  test('image calls keep vision-capable picks and move text-only picks to the default', () => {
    const { resolve, ids, store } = openSeeded();
    for (const [task, key] of [['enhance', 'mimo'], ['condense', 'grok'], ['ai-fill', 'gemini-argon']] as const) {
      store.writeUserPick('alice', task, { modelId: ids[key], effort: null });
      expect(served(resolve({ task, visionRequired: true }))).toEqual({ modelId: ids[key], source: 'user' });
      expect(served(resolve({ task }))).toEqual({ modelId: ids[key], source: 'user' });
    }
    for (const key of ['glm-abliterated', 'deepseek-abliterated'] as const) {
      store.writeUserPick('alice', 'storytelling', { modelId: ids[key], effort: null });
      expect(served(resolve({ task: 'storytelling', visionRequired: true }))).toEqual({ modelId: ids.kimi, source: 'default' });
      expect(served(resolve({ task: 'storytelling' }))).toEqual({ modelId: ids[key], source: 'user' });
    }
    expect(served(resolve({ task: 'brainstorm', visionRequired: true, imageModelId: LOCAL_IMAGE }))).toEqual({
      modelId: ids.kimi,
      source: 'default',
    });
  });

  test('the effort applies only when the picked model serves the call', () => {
    const { resolve, ids, store } = openSeeded();
    store.writeUserPick('alice', 'brainstorm', { modelId: ids.grok, effort: 'xhigh' });
    const picked = resolve({ task: 'brainstorm' });
    expect(picked.ok && picked.effort).toBe('xhigh');
    // Another task, a writer route, a vision fallback or a failover partner keeps the row default.
    const otherTask = resolve({ task: 'enhance' });
    expect(otherTask.ok && otherTask.effort).toBeUndefined();
    const writer = resolve({ task: 'brainstorm', imageModelId: SUNBURST });
    expect(writer.ok && writer.model.id).toBe(ids.gpt);
    expect(writer.ok && writer.effort).toBeUndefined();
    const partner = resolve({ task: 'brainstorm', excludeModelIds: [ids.grok] });
    expect(partner.ok && partner.model.id).toBe(ids.kimi);
    expect(partner.ok && partner.effort).toBeUndefined();
  });

  test("a skipped pick's effort never reaches the model that serves instead", () => {
    const { resolve, ids, store, availability } = openSeeded();
    store.writeUserPick('alice', 'condense', { modelId: ids.kimi, effort: 'max' });
    store.setDefault('condense', ids.mimo);
    availability.set(SEED.modelIds.kimi, 'offline');
    const result = resolve({ task: 'condense', imageModelId: LOCAL_IMAGE });
    expect(served(result)).toEqual({ modelId: ids.mimo, source: 'task' });
    expect(result.ok && result.effort).toBeUndefined();
  });

  test('a stored effort the model does not offer never reaches the wire', () => {
    const { db, resolve, ids } = openSeeded();
    db.run("INSERT INTO users (id, created_at) VALUES ('alice', 1)");
    const insert = db.query(
      "INSERT INTO user_text_models (user_id, task, text_model_id, effort, updated_at) VALUES ('alice', ?, ?, ?, 1)",
    );
    insert.run('ai-fill', ids.kimi, 'none');
    // GPT offers no levels (fixed effort): its row default always applies.
    insert.run('enhance', ids.gpt, 'high');
    const kimi = resolve({ task: 'ai-fill' });
    expect(served(kimi)).toEqual({ modelId: ids.kimi, source: 'user' });
    expect(kimi.ok && kimi.effort).toBeUndefined();
    const gpt = resolve({ task: 'enhance' });
    expect(served(gpt)).toEqual({ modelId: ids.gpt, source: 'user' });
    expect(gpt.ok && gpt.effort).toBeUndefined();
  });
});

describe('resolveTextModel - precedence', () => {
  test('a locked writer beats the request pin and the user pick', async () => {
    const { resolve, store, ids } = await openCustom();
    store.setDefault('default', ids.beta);
    store.setWriter('img', { modelId: ids.writer, mode: 'lock' });
    store.writeUserPick('alice', 'brainstorm', { modelId: ids.alpha, effort: 'high' });
    expect(served(resolve({ task: 'brainstorm', imageModelId: 'img', requestPin: ids.beta }))).toEqual({
      modelId: ids.writer,
      source: 'writer',
    });
  });

  test('the request pin beats the user pick', async () => {
    const { resolve, store, ids } = await openCustom();
    store.setDefault('default', ids.beta);
    store.writeUserPick('alice', 'brainstorm', { modelId: ids.alpha, effort: null });
    expect(served(resolve({ task: 'brainstorm', requestPin: ids.text }))).toEqual({ modelId: ids.text, source: 'request' });
  });

  test('the user pick beats a preferred writer, which beats the task assignment and the default', async () => {
    const { resolve, store, ids } = await openCustom();
    store.setDefault('default', ids.beta);
    store.setDefault('enhance', ids.text);
    store.setWriter('img', { modelId: ids.writer, mode: 'prefer' });
    expect(served(resolve({ task: 'enhance' }))).toEqual({ modelId: ids.text, source: 'task' });
    expect(served(resolve({ task: 'ai-fill' }))).toEqual({ modelId: ids.beta, source: 'default' });
    expect(served(resolve({ task: 'enhance', imageModelId: 'img' }))).toEqual({ modelId: ids.writer, source: 'writer' });
    expect(served(resolve({ task: 'ai-fill', imageModelId: 'img' }))).toEqual({ modelId: ids.writer, source: 'writer' });
    store.writeUserPick('alice', 'enhance', { modelId: ids.alpha, effort: null });
    expect(served(resolve({ task: 'enhance', imageModelId: 'img' }))).toEqual({ modelId: ids.alpha, source: 'user' });
  });

  test('a locked writer that is disabled, excluded or lacks vision fails pin-unavailable; offline does not reroute it', async () => {
    const { resolve, store, ids, availability } = await openCustom();
    store.setDefault('default', ids.beta);
    store.writeUserPick('alice', 'enhance', { modelId: ids.alpha, effort: null });
    store.setWriter('img', { modelId: ids.text, mode: 'lock' });
    expect(served(resolve({ task: 'enhance', imageModelId: 'img', visionRequired: true }))).toEqual({ fail: 'pin-unavailable' });
    expect(served(resolve({ task: 'enhance', imageModelId: 'img' }))).toEqual({ modelId: ids.text, source: 'writer' });
    expect(served(resolve({ task: 'enhance', imageModelId: 'img', excludeModelIds: [ids.text] }))).toEqual({
      fail: 'pin-unavailable',
    });
    availability.set('text', 'offline');
    expect(served(resolve({ task: 'enhance', imageModelId: 'img' }))).toEqual({ modelId: ids.text, source: 'writer' });
    availability.set('text', 'available');
    store.updateModel(ids.text, { enabled: false });
    expect(served(resolve({ task: 'enhance', imageModelId: 'img' }))).toEqual({ fail: 'pin-unavailable' });
  });

  test('a preferred writer that is ineligible falls through to the task assignment, then the default', async () => {
    const { resolve, store, ids, availability } = await openCustom();
    store.setDefault('default', ids.beta);
    store.setDefault('enhance', ids.alpha);
    store.setWriter('img', { modelId: ids.writer, mode: 'prefer' });
    availability.set('writer', 'offline');
    expect(served(resolve({ task: 'enhance', imageModelId: 'img' }))).toEqual({ modelId: ids.alpha, source: 'task' });
    expect(served(resolve({ task: 'ai-fill', imageModelId: 'img' }))).toEqual({ modelId: ids.beta, source: 'default' });
  });

  test('a request pin is validated: an unknown, disabled or offline pin falls through', async () => {
    const { resolve, store, ids, availability } = await openCustom();
    store.setDefault('default', ids.beta);
    expect(served(resolve({ task: 'brainstorm', requestPin: 'no-such-row' }))).toEqual({ modelId: ids.beta, source: 'default' });
    availability.set('alpha', 'offline');
    expect(served(resolve({ task: 'brainstorm', requestPin: ids.alpha }))).toEqual({ modelId: ids.beta, source: 'default' });
    store.updateModel(ids.text, { enabled: false });
    expect(served(resolve({ task: 'brainstorm', requestPin: ids.text }))).toEqual({ modelId: ids.beta, source: 'default' });
  });

  test('an offline pick falls to the task assignment, then the default, and reports pickState offline', async () => {
    const { resolve, store, ids, availability } = await openCustom();
    store.setDefault('default', ids.beta);
    store.setDefault('enhance', ids.text);
    store.writeUserPick('alice', 'enhance', { modelId: ids.alpha, effort: null });
    store.writeUserPick('alice', 'ai-fill', { modelId: ids.alpha, effort: null });
    availability.set('alpha', 'offline');
    const task = resolve({ task: 'enhance' });
    expect(served(task)).toEqual({ modelId: ids.text, source: 'task' });
    expect(task.pickState).toBe('offline');
    const fallback = resolve({ task: 'ai-fill' });
    expect(served(fallback)).toEqual({ modelId: ids.beta, source: 'default' });
    expect(fallback.pickState).toBe('offline');
    expect(resolve({ task: 'brainstorm' }).pickState).toBeUndefined();
  });

  test('a disabled model or a disabled provider is skipped at every step', async () => {
    const { resolve, store, ids, providerId } = await openCustom();
    const other = await addProvider(store, 'Other', [{ modelId: 'other', vision: true }]);
    const otherId = must(other.ids.other);
    store.setDefault('default', otherId);
    store.setDefault('enhance', ids.beta);
    store.setWriter('img', { modelId: ids.writer, mode: 'prefer' });
    store.writeUserPick('alice', 'enhance', { modelId: ids.alpha, effort: null });
    store.updateModel(ids.alpha, { enabled: false });
    expect(served(resolve({ task: 'enhance', imageModelId: 'img' }))).toEqual({ modelId: ids.writer, source: 'writer' });
    store.updateModel(ids.writer, { enabled: false });
    expect(served(resolve({ task: 'enhance', imageModelId: 'img' }))).toEqual({ modelId: ids.beta, source: 'task' });
    await store.updateProvider(providerId, { enabled: false });
    expect(served(resolve({ task: 'enhance', imageModelId: 'img' }))).toEqual({ modelId: otherId, source: 'default' });
  });

  test('the vision filter applies at every step', async () => {
    const { resolve, store, ids, providerId } = await openCustom();
    const [textB, textC, textD] = store.createModels(providerId, [
      { modelId: 'text-b', vision: false },
      { modelId: 'text-c', vision: false },
      { modelId: 'text-d', vision: false },
    ]).map((model) => model.id);
    if (!textB || !textC || !textD) throw new Error('models not created');
    store.setDefault('default', ids.beta);
    store.setDefault('enhance', textB);
    store.setWriter('img', { modelId: textC, mode: 'prefer' });
    store.writeUserPick('alice', 'enhance', { modelId: textD, effort: null });
    const input = { task: 'enhance', imageModelId: 'img', requestPin: ids.text } as const;
    expect(served(resolve(input))).toEqual({ modelId: ids.text, source: 'request' });
    expect(served(resolve({ ...input, visionRequired: true }))).toEqual({ modelId: ids.beta, source: 'default' });
  });

  test('no-vision-model only when vision is the sole blocker; otherwise not-configured', async () => {
    const { resolve, store, ids, availability } = await openCustom();
    store.setDefault('default', ids.text);
    expect(served(resolve({ task: 'enhance', visionRequired: true }))).toEqual({ fail: 'no-vision-model' });
    availability.set('text', 'offline');
    expect(served(resolve({ task: 'enhance', visionRequired: true }))).toEqual({ fail: 'not-configured' });
    expect(served(resolve({ task: 'enhance' }))).toEqual({ fail: 'not-configured' });
  });

  test('not-configured when no rows exist', () => {
    const { resolve } = openEmpty();
    expect(served(resolve({ task: 'enhance' }))).toEqual({ fail: 'not-configured' });
    expect(served(resolve({ task: 'enhance', visionRequired: true, imageModelId: SUNBURST }))).toEqual({ fail: 'not-configured' });
  });

  test('availability is read live: offline to available changes the result with no config write', async () => {
    const { resolve, store, ids, availability } = await openCustom();
    store.setDefault('default', ids.beta);
    store.writeUserPick('alice', 'enhance', { modelId: ids.alpha, effort: 'high' });
    availability.set('alpha', 'offline');
    expect(served(resolve({ task: 'enhance' }))).toEqual({ modelId: ids.beta, source: 'default' });
    availability.set('alpha', 'available');
    const back = resolve({ task: 'enhance' });
    expect(served(back)).toEqual({ modelId: ids.alpha, source: 'user' });
    expect(back.ok && back.effort).toBe('high');
    expect(back.pickState).toBe('active');
  });

  test('excludeModelIds skips the failed model; the partner still passes every eligibility rule', async () => {
    const { resolve, store, ids, availability } = await openCustom();
    store.setDefault('default', ids.beta);
    store.setDefault('brainstorm', ids.text);
    store.writeUserPick('alice', 'brainstorm', { modelId: ids.alpha, effort: null });
    expect(served(resolve({ task: 'brainstorm', requestPin: ids.alpha, excludeModelIds: [ids.alpha] }))).toEqual({
      modelId: ids.text,
      source: 'task',
    });
    // The next candidate lacks vision for an image call, and the next is offline:
    // without the images the task model would serve, so vision is the blocker.
    availability.set('beta', 'offline');
    expect(served(resolve({ task: 'brainstorm', excludeModelIds: [ids.alpha], visionRequired: true }))).toEqual({
      fail: 'no-vision-model',
    });
    availability.set('beta', 'available');
    expect(served(resolve({ task: 'brainstorm', excludeModelIds: [ids.alpha], visionRequired: true }))).toEqual({
      modelId: ids.beta,
      source: 'default',
    });
    // A locked writer is never crossed: excluding it fails rather than moving on.
    store.setWriter('img', { modelId: ids.writer, mode: 'lock' });
    expect(served(resolve({ task: 'brainstorm', imageModelId: 'img', excludeModelIds: [ids.writer] }))).toEqual({
      fail: 'pin-unavailable',
    });
  });

  test('the effort needs the serving model to be the pick and the level to be offered', async () => {
    const { resolve, store, ids } = await openCustom();
    store.setDefault('default', ids.alpha);
    store.writeUserPick('alice', 'enhance', { modelId: ids.alpha, effort: 'high' });
    const picked = resolve({ task: 'enhance' });
    expect(picked.ok && picked.effort).toBe('high');
    expect(picked.ok && picked.source).toBe('user');
    // The same model reached through the default for another task carries no effort.
    const other = resolve({ task: 'ai-fill' });
    expect(other.ok && other.model.id).toBe(ids.alpha);
    expect(other.ok && other.effort).toBeUndefined();
    // The level leaves the model's list: the row default applies again.
    store.updateModel(ids.alpha, { reasoningLevels: ['low'], reasoningDefault: 'low' });
    const narrowed = resolve({ task: 'enhance' });
    expect(narrowed.ok && narrowed.model.id).toBe(ids.alpha);
    expect(narrowed.ok && narrowed.effort).toBeUndefined();
  });

  test('the result carries the serving model and its provider', async () => {
    const { resolve, store, ids, providerId } = await openCustom();
    store.setDefault('default', ids.beta);
    const result = resolve({ task: 'enhance' });
    expect(result.ok && result.model.modelId).toBe('beta');
    expect(result.ok && result.provider.id).toBe(providerId);
  });
});

describe('resolveTextModel - reads', () => {
  test('one DB read per resolve (the user pick); the config comes from memory', async () => {
    const { db, resolve, store, ids } = await openCustom();
    store.setDefault('default', ids.beta);
    store.setWriter('img', { modelId: ids.writer, mode: 'prefer' });
    resolve({ task: 'enhance' }); // warm the snapshot
    const query = spyOn(db, 'query');
    const prepare = spyOn(db, 'prepare');
    const run = spyOn(db, 'run');
    try {
      for (let index = 0; index < 5; index += 1) resolve({ task: 'enhance', imageModelId: 'img', visionRequired: true });
      expect(query.mock.calls.length + prepare.mock.calls.length + run.mock.calls.length).toBe(5);
    } finally {
      query.mockRestore();
      prepare.mockRestore();
      run.mockRestore();
    }
  });
});

describe('TextConfigSnapshot', () => {
  test('rebuilds only when the config revision changes', async () => {
    const { store, snapshot, ids } = await openCustom();
    const listModels = spyOn(store, 'listModels');
    try {
      const first = snapshot.current();
      expect(snapshot.current()).toBe(first);
      expect(listModels.mock.calls.length).toBe(1);
      // A user pick never bumps the revision.
      store.writeUserPick('alice', 'enhance', { modelId: ids.alpha, effort: null });
      expect(snapshot.current()).toBe(first);
      store.setDefault('default', ids.beta);
      const second = snapshot.current();
      expect(second).not.toBe(first);
      expect(second.defaults.default).toBe(ids.beta);
      expect(listModels.mock.calls.length).toBe(2);
    } finally {
      listModels.mockRestore();
    }
  });

  test('holds only enabled models of enabled providers, with no availability', async () => {
    const { store, snapshot, ids, providerId } = await openCustom();
    store.updateModel(ids.text, { enabled: false });
    const config = snapshot.current();
    expect([...config.models.keys()].sort()).toEqual([ids.alpha, ids.beta, ids.writer].sort());
    expect(config.providers.get(providerId)?.name).toBe('Local');
    for (const model of config.models.values()) expect(model).not.toHaveProperty('status');
    await store.updateProvider(providerId, { enabled: false });
    expect(snapshot.current().models.size).toBe(0);
  });
});
