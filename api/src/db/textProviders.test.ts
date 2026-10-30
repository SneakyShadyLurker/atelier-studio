import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestReport } from '@atelier/shared';
import { fingerprint, importHmacKey } from '../crypto/fingerprint';
import {
  ByokNotConfiguredError,
  createTextSecretsForKey,
  TextSecretUnreadableError,
} from '../keystore/instanceSecrets';
import { migrate } from './migrate';
import { LEGACY_SEED, type TextSeed } from './textSeed';
import {
  createTextProviderStore,
  TEXT_PROBE_JSON_MAX_BYTES,
  TextConfigConflictError,
  TextConfigValidationError,
  type TextProviderStore,
} from './textProviders';

const HEX = 'd'.repeat(64);

function setup(options: { withSecrets?: boolean; seed?: TextSeed } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-text-providers-'));
  const db = new Database(':memory:');
  if (options.seed) {
    // Seeding happens only on upgrade, so stop at 57 first, then finish with the seed.
    migrate(db, dataDir, { targetVersion: 57 });
    migrate(db, dataDir, { textSeed: options.seed });
  } else {
    migrate(db, dataDir);
  }
  db.run(`INSERT INTO users (id, created_at) VALUES ('alice', 1000), ('bob', 1000)`);
  const secrets = options.withSecrets === false ? undefined : createTextSecretsForKey(HEX);
  const store = createTextProviderStore(secrets ? { db, secrets } : { db });
  return { db, store };
}

async function provider(store: TextProviderStore, name = 'Local', apiKey?: string) {
  return store.createProvider({
    name,
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1/',
    ...(apiKey === undefined ? {} : { apiKey }),
  });
}

const ENV_VAR = 'ATELIER_TEST_TEXT_PROVIDER_TOKEN';
afterEach(() => {
  delete process.env.ATELIER_TEST_TEXT_PROVIDER_TOKEN;
});

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

describe('text provider store: providers', () => {
  test('foreign keys are on after migrate', () => {
    const { db } = setup();
    expect(db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  });

  test('createProvider without a key maps to the admin wire shape', async () => {
    const { store } = setup();
    const created = await provider(store);

    const { id, createdAt, updatedAt, ...rest } = created;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(updatedAt).toBe(createdAt);
    expect(rest).toEqual({
      name: 'Local',
      protocol: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      preset: null,
      auth: 'none',
      tokenField: 'max_completion_tokens',
      listModels: true,
      enabled: true,
    });
    expect(store.getProvider(created.id)).toEqual(created);
    expect(store.listProviders()).toEqual([created]);
  });

  test('createProvider with a key stores ciphertext and exposes only the fingerprint', async () => {
    const { db, store } = setup();
    const created = await provider(store, 'Cloud', 'sk-TOPSECRET');

    const expected = await fingerprint(await importHmacKey(HEX), 'sk-TOPSECRET');
    expect(created.auth).toBe('stored');
    expect(created.fingerprint).toBe(expected);
    expect(JSON.stringify(created)).not.toContain('TOPSECRET');
    expect(JSON.stringify(store.listProviders())).not.toContain('TOPSECRET');

    const row = db
      .query<{ secret_ciphertext: Uint8Array; secret_key_version: number }, [string]>(
        'SELECT secret_ciphertext, secret_key_version FROM text_providers WHERE id = ?',
      )
      .get(created.id);
    expect(row?.secret_key_version).toBe(2);
    expect(Buffer.from(row?.secret_ciphertext ?? []).toString('utf8')).not.toContain('TOPSECRET');
    expect(await store.resolveCredential(created)).toBe('sk-TOPSECRET');
  });

  test('without a master key, apiKey throws ByokNotConfiguredError and keyless works', async () => {
    const { store } = setup({ withSecrets: false });

    const error = await provider(store, 'Cloud', 'sk-x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ByokNotConfiguredError);
    expect(store.listProviders()).toEqual([]);

    const keyless = await provider(store, 'Local');
    expect(keyless.auth).toBe('none');
    expect(await store.resolveCredential(keyless)).toBeUndefined();
  });

  test('a ciphertext moved onto another provider row fails to decrypt', async () => {
    const { db, store } = setup();
    const a = await provider(store, 'A', 'sk-a');
    const b = await provider(store, 'B', 'sk-b');
    db.run(
      `UPDATE text_providers
          SET (secret_ciphertext, secret_nonce, secret_fingerprint) =
              (SELECT secret_ciphertext, secret_nonce, secret_fingerprint FROM text_providers WHERE id = ?)
        WHERE id = ?`,
      [a.id, b.id],
    );

    const error = await store.resolveCredential(b).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TextSecretUnreadableError);
  });

  test('resolveCredential reads env-sourced credentials at call time', async () => {
    const { store } = setup({ seed: seed() });
    const seeded = present(store.listProviders()[0]);
    expect(seeded.auth).toBe('env');
    expect(seeded.envVar).toBe('CLIPROXY_TOKEN');

    const envProvider = { ...seeded, envVar: ENV_VAR };
    expect(await store.resolveCredential(envProvider)).toBeUndefined();
    process.env[ENV_VAR] = 'env-token';
    expect(await store.resolveCredential(envProvider)).toBe('env-token');
  });

  test('a stored credential without a master key throws ByokNotConfiguredError', async () => {
    const { db, store } = setup();
    const created = await provider(store, 'Cloud', 'sk-x');
    const keyless = createTextProviderStore({ db });
    expect(await keyless.resolveCredential(created).catch((e: unknown) => e)).toBeInstanceOf(ByokNotConfiguredError);
  });

  test('duplicate names conflict case-insensitively', async () => {
    const { store } = setup();
    await provider(store, 'Local');
    expect(await provider(store, 'local').catch((e: unknown) => e)).toBeInstanceOf(TextConfigConflictError);
    const other = await provider(store, 'Other');
    expect(await store.updateProvider(other.id, { name: 'LOCAL' }).catch((e: unknown) => e))
      .toBeInstanceOf(TextConfigConflictError);
  });

  test('invalid base URLs are rejected', async () => {
    const { store } = setup();
    const error = await store
      .createProvider({ name: 'Bad', protocol: 'anthropic', baseUrl: 'https://user:pw@example.com/v1' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TextConfigValidationError);
  });

  test('updateProvider replaces and removes a stored key', async () => {
    const { store } = setup();
    const created = await provider(store, 'Cloud', 'sk-old');

    const replaced = present(await store.updateProvider(created.id, { apiKey: 'sk-new', baseUrl: 'https://api.example.com/v1/' }));
    expect(replaced.auth).toBe('stored');
    expect(replaced.baseUrl).toBe('https://api.example.com/v1');
    expect(replaced.fingerprint).not.toBe(created.fingerprint);
    expect(await store.resolveCredential(replaced)).toBe('sk-new');

    const removed = present(await store.updateProvider(created.id, { apiKey: null }));
    expect(removed.auth).toBe('none');
    expect(removed.fingerprint).toBeUndefined();
    expect(await store.resolveCredential(removed)).toBeUndefined();
  });

  test('a key update racing another PATCH keeps both changes', async () => {
    const { store } = setup();
    const created = await provider(store, 'Cloud', 'sk-old');
    // The key update awaits encryption; the rename lands meanwhile.
    const keyUpdate = store.updateProvider(created.id, { apiKey: 'sk-new' });
    const rename = store.updateProvider(created.id, { name: 'Renamed', enabled: false });
    await Promise.all([keyUpdate, rename]);
    const final = present(store.listProviders().find((p) => p.id === created.id));
    expect(final.name).toBe('Renamed');
    expect(final.enabled).toBe(false);
    expect(await store.resolveCredential(final)).toBe('sk-new');
  });

  test('updateProvider rejects key changes on env-auth providers', async () => {
    const { store } = setup({ seed: seed() });
    const seeded = present(store.listProviders()[0]);
    expect(await store.updateProvider(seeded.id, { apiKey: 'sk-x' }).catch((e: unknown) => e))
      .toBeInstanceOf(TextConfigValidationError);
    expect(await store.updateProvider(seeded.id, { apiKey: null }).catch((e: unknown) => e))
      .toBeInstanceOf(TextConfigValidationError);
  });

  test('updateProvider on an unknown id returns null', async () => {
    const { store } = setup();
    expect(await store.updateProvider('missing', { enabled: false })).toBeNull();
  });

  test('deleteProvider cascades its models and their references', async () => {
    const { db, store } = setup();
    const created = await provider(store);
    const [model] = store.createModels(created.id, [{ modelId: 'llama' }]);
    store.setDefault('default', present(model).id);
    store.writeUserPick('alice', 'enhance', { modelId: present(model).id, effort: null });

    expect(store.deleteProvider(created.id)).toBe(true);
    expect(store.deleteProvider(created.id)).toBe(false);
    expect(store.listModels()).toEqual([]);
    expect(db.query('SELECT 1 FROM text_defaults').all()).toEqual([]);
    expect(db.query('SELECT 1 FROM user_text_models').all()).toEqual([]);
  });
});

describe('text provider store: models', () => {
  test('createModels applies defaults and maps to the admin wire shape', async () => {
    const { store } = setup();
    const p = await provider(store);
    const [model] = store.createModels(p.id, [{ modelId: 'llama3.3:70b' }]);

    const { id, ...rest } = present(model);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rest).toEqual({
      providerId: p.id,
      modelId: 'llama3.3:70b',
      displayName: 'llama3.3:70b',
      legacyKey: null,
      enabled: true,
      screenRequests: false,
      sortOrder: 0,
      verifiedAt: null,
      lastTest: null,
      vision: false,
      maxImages: null,
      structuredOutput: 'json_object',
      reasoningLevels: [],
      reasoningDefault: null,
      temperature: null,
      topP: null,
      fixedOutputTokens: null,
      latencyProfile: 'standard',
      promptVariant: 'generic',
    });
    expect(store.getModel(present(model).id)).toEqual(present(model));
  });

  test('createModels appends after existing sort order and keeps given capabilities', async () => {
    const { store } = setup();
    const p = await provider(store);
    store.createModels(p.id, [{ modelId: 'a' }]);
    const [b, c] = store.createModels(p.id, [
      { modelId: 'b', displayName: 'Bee', vision: true, maxImages: 4, reasoningLevels: ['low', 'high'], reasoningDefault: 'low' },
      { modelId: 'c' },
    ]);
    expect(b?.sortOrder).toBe(1);
    expect(c?.sortOrder).toBe(2);
    expect(b).toMatchObject({ displayName: 'Bee', vision: true, maxImages: 4, reasoningLevels: ['low', 'high'], reasoningDefault: 'low' });
    expect(store.listModels(p.id).map((m) => m.modelId)).toEqual(['a', 'b', 'c']);
  });

  test('createModels is all-or-nothing and conflicts on a duplicate upstream id', async () => {
    const { store } = setup();
    const p = await provider(store);
    store.createModels(p.id, [{ modelId: 'a' }]);
    expect(() => store.createModels(p.id, [{ modelId: 'z' }, { modelId: 'a' }])).toThrow(TextConfigConflictError);
    expect(store.listModels(p.id).map((m) => m.modelId)).toEqual(['a']);
  });

  test('createModels on an unknown provider is a validation error', () => {
    const { store } = setup();
    expect(() => store.createModels('missing', [{ modelId: 'a' }])).toThrow(TextConfigValidationError);
  });

  test('reasoning default must be listed when levels are non-empty', async () => {
    const { store } = setup();
    const p = await provider(store);
    expect(() => store.createModels(p.id, [{ modelId: 'a', reasoningLevels: ['low', 'high'], reasoningDefault: 'medium' }]))
      .toThrow(TextConfigValidationError);
    const [model] = store.createModels(p.id, [{ modelId: 'a', reasoningLevels: ['low', 'high'], reasoningDefault: 'high' }]);
    expect(() => store.updateModel(present(model).id, { reasoningDefault: 'max' })).toThrow(TextConfigValidationError);
    expect(() => store.updateModel(present(model).id, { reasoningLevels: ['low'] })).toThrow(TextConfigValidationError);
  });

  test('empty levels allow any fixed effort', async () => {
    const { store } = setup();
    const p = await provider(store);
    const [model] = store.createModels(p.id, [{ modelId: 'a', reasoningLevels: [], reasoningDefault: 'xhigh' }]);
    expect(model?.reasoningDefault).toBe('xhigh');
  });

  test('editing the seeded fixed-effort GPT row succeeds', () => {
    const { store } = setup({ seed: seed() });
    const gpt = present(store.listModels().find((m) => m.legacyKey === 'gpt'));
    expect(gpt.reasoningLevels).toEqual([]);
    expect(gpt.reasoningDefault).toBe('medium');

    const updated = store.updateModel(gpt.id, { displayName: 'GPT', screenRequests: true });
    expect(updated).toMatchObject({ displayName: 'GPT', reasoningLevels: [], reasoningDefault: 'medium', screenRequests: true });
  });

  test('maxImages requires vision', async () => {
    const { store } = setup();
    const p = await provider(store);
    expect(() => store.createModels(p.id, [{ modelId: 'a', maxImages: 2 }])).toThrow(TextConfigValidationError);
    const [model] = store.createModels(p.id, [{ modelId: 'a', vision: true, maxImages: 2 }]);
    expect(() => store.updateModel(present(model).id, { vision: false })).toThrow(TextConfigValidationError);
    expect(store.updateModel(present(model).id, { vision: false, maxImages: null })?.vision).toBe(false);
  });

  test('updateModel maps lastTest from probe_json and returns null for unknown ids', async () => {
    const { db, store } = setup();
    const p = await provider(store);
    const [model] = store.createModels(p.id, [{ modelId: 'a' }]);
    const report: TestReport = { checks: [], proposed: { vision: true }, advertised: {}, wireNotes: ['ok'] };
    db.run('UPDATE text_models SET probe_json = ?, verified_at = 5 WHERE id = ?', [JSON.stringify(report), present(model).id]);

    expect(store.getModel(present(model).id)).toMatchObject({ lastTest: report, verifiedAt: 5 });
    expect(store.updateModel('missing', { enabled: false })).toBeNull();
  });

  test('recordModelTest stores the report, sets verifiedAt only when given and never bumps the revision', async () => {
    const { store } = setup();
    const p = await provider(store);
    const [model] = store.createModels(p.id, [{ modelId: 'a', vision: true }]);
    const id = present(model).id;
    const before = store.revision();
    const report: TestReport = {
      checks: [{ id: 'plain', status: 'pass', message: 'ok' }],
      proposed: { vision: false },
      advertised: {},
      wireNotes: [],
    };

    expect(store.recordModelTest(id, report, 1234)).toMatchObject({ lastTest: report, verifiedAt: 1234, vision: true });
    const failed: TestReport = { ...report, checks: [{ id: 'plain', status: 'fail', message: 'down' }] };
    expect(store.recordModelTest(id, failed, null)).toMatchObject({ lastTest: failed, verifiedAt: 1234 });
    expect(store.revision()).toBe(before);
    expect(store.recordModelTest('missing', report, 1)).toBeNull();
  });

  test('recordModelTest keeps an oversized report within 8 KiB as valid JSON', async () => {
    const { db, store } = setup();
    const p = await provider(store);
    const [model] = store.createModels(p.id, [{ modelId: 'a' }]);
    const id = present(model).id;
    const long = 'x'.repeat(4000);
    const report: TestReport = {
      checks: ['plain', 'json', 'image', 'reasoning'].map((check) => ({ id: check, status: 'pass', message: long })),
      proposed: { structuredOutput: 'json_object' },
      advertised: {},
      wireNotes: [long, long],
    };

    const stored = store.recordModelTest(id, report, null);
    const raw = db.query<{ probe_json: string }, [string]>('SELECT probe_json FROM text_models WHERE id = ?').get(id);
    expect(new TextEncoder().encode(present(raw).probe_json).byteLength).toBeLessThanOrEqual(TEXT_PROBE_JSON_MAX_BYTES);
    expect(stored?.lastTest?.checks.map((check) => [check.id, check.status])).toEqual([
      ['plain', 'pass'], ['json', 'pass'], ['image', 'pass'], ['reasoning', 'pass'],
    ]);
    expect(stored?.lastTest?.proposed).toEqual({ structuredOutput: 'json_object' });
  });

  test('usage reports every reference and deleting a model cascades them', async () => {
    const { db, store } = setup();
    const p = await provider(store);
    const [model, other] = store.createModels(p.id, [{ modelId: 'a' }, { modelId: 'b' }]);
    store.setDefault('default', present(model).id);
    store.setDefault('rescue', present(model).id);
    store.setDefault('enhance', present(model).id);
    store.setDefault('condense', present(other).id);
    store.setWriter('gpt-image-2', { modelId: present(model).id, mode: 'prefer' });
    store.setWriter('gpt-image-2.5-sunburst', { modelId: present(model).id, mode: 'lock' });
    store.writeUserPick('alice', 'enhance', { modelId: present(model).id, effort: null });
    store.writeUserPick('alice', 'ai-fill', { modelId: present(model).id, effort: null });
    store.writeUserPick('bob', 'enhance', { modelId: present(model).id, effort: null });

    expect(store.usage(present(model).id)).toEqual({
      isDefault: true,
      tasks: ['enhance', 'rescue'],
      writers: ['gpt-image-2', 'gpt-image-2.5-sunburst'],
      userPicks: 2,
    });
    expect(store.usage(present(other).id)).toEqual({ isDefault: false, tasks: ['condense'], writers: [], userPicks: 0 });

    expect(store.deleteModel(present(model).id)).toBe(true);
    expect(store.deleteModel(present(model).id)).toBe(false);
    expect(db.query('SELECT scope FROM text_defaults').all()).toEqual([{ scope: 'condense' }]);
    expect(db.query('SELECT 1 FROM image_model_writers').all()).toEqual([]);
    expect(db.query('SELECT 1 FROM user_text_models').all()).toEqual([]);
  });
});

describe('text provider store: routing and picks', () => {
  test('defaults and writers read back and clear with null', async () => {
    const { store } = setup();
    const p = await provider(store);
    const [a, b] = store.createModels(p.id, [{ modelId: 'a' }, { modelId: 'b' }]);
    store.setDefault('default', present(a).id);
    store.setDefault('brainstorm', present(b).id);
    store.setDefault('brainstorm', present(a).id);
    store.setWriter('img-1', { modelId: present(b).id, mode: 'lock' });

    expect(store.readDefaults()).toEqual({ default: present(a).id, byTask: { brainstorm: present(a).id } });
    expect(store.readWriters()).toEqual({ 'img-1': { modelId: present(b).id, mode: 'lock' } });

    store.setDefault('brainstorm', null);
    store.setWriter('img-1', null);
    expect(store.readDefaults()).toEqual({ default: present(a).id, byTask: {} });
    expect(store.readWriters()).toEqual({});
  });

  test('routing writes reject unknown and disabled models', async () => {
    const { store } = setup();
    const p = await provider(store);
    const [model] = store.createModels(p.id, [{ modelId: 'a', enabled: false }]);
    expect(() => { store.setDefault('default', 'missing'); }).toThrow(TextConfigValidationError);
    expect(() => { store.setDefault('default', present(model).id); }).toThrow(TextConfigValidationError);
    expect(() => { store.setWriter('img-1', { modelId: present(model).id, mode: 'prefer' }); }).toThrow(TextConfigValidationError);
  });

  test('user picks round-trip, validate effort and clear with null', async () => {
    const { store } = setup();
    const p = await provider(store);
    const [model] = store.createModels(p.id, [{ modelId: 'a', reasoningLevels: ['low', 'high'], reasoningDefault: 'low' }]);

    store.writeUserPick('carol', 'enhance', { modelId: present(model).id, effort: 'high' });
    store.writeUserPick('carol', 'ai-fill', { modelId: present(model).id, effort: null });
    expect(store.readUserPicks('carol')).toEqual({
      enhance: { modelId: present(model).id, effort: 'high' },
      'ai-fill': { modelId: present(model).id, effort: null },
    });
    expect(store.readUserPicks('nobody')).toEqual({});

    expect(() => { store.writeUserPick('carol', 'enhance', { modelId: present(model).id, effort: 'max' }); })
      .toThrow(TextConfigValidationError);
    expect(() => { store.writeUserPick('carol', 'enhance', { modelId: 'missing', effort: null }); })
      .toThrow(TextConfigValidationError);

    store.writeUserPick('carol', 'enhance', null);
    expect(store.readUserPicks('carol')).toEqual({ 'ai-fill': { modelId: present(model).id, effort: null } });
  });
});

describe('text provider store: revision', () => {
  test('every admin write bumps the revision; user picks and reads do not', async () => {
    const { store } = setup();
    let last = store.revision();
    const bumped = () => {
      const now = store.revision();
      const changed = now > last;
      last = now;
      return changed;
    };

    const p = await provider(store);
    expect(bumped()).toBe(true);
    await store.updateProvider(p.id, { enabled: false });
    expect(bumped()).toBe(true);
    const [model] = store.createModels(p.id, [{ modelId: 'a' }]);
    expect(bumped()).toBe(true);
    store.updateModel(present(model).id, { displayName: 'A' });
    expect(bumped()).toBe(true);
    store.setDefault('default', present(model).id);
    expect(bumped()).toBe(true);
    store.setWriter('img-1', { modelId: present(model).id, mode: 'prefer' });
    expect(bumped()).toBe(true);

    store.writeUserPick('alice', 'enhance', { modelId: present(model).id, effort: null });
    store.writeUserPick('alice', 'enhance', null);
    store.readUserPicks('alice');
    store.listProviders();
    store.usage(present(model).id);
    expect(bumped()).toBe(false);

    store.deleteModel(present(model).id);
    expect(bumped()).toBe(true);
    store.deleteProvider(p.id);
    expect(bumped()).toBe(true);
  });

  test('a rejected admin write does not bump the revision', async () => {
    const { store } = setup();
    const p = await provider(store);
    const before = store.revision();
    expect(() => store.createModels(p.id, [{ modelId: 'a', maxImages: 1 }])).toThrow(TextConfigValidationError);
    expect(store.revision()).toBe(before);
  });
});

function seed(): TextSeed {
  return {
    baseUrl: 'http://cliproxy.lan:8317',
    modelIds: Object.fromEntries(
      LEGACY_SEED.models.map((m) => [m.legacyKey, `${m.legacyKey}-x`]),
    ) as TextSeed['modelIds'],
    sunburstImageModelIds: [],
    gptImageModelIds: [],
  };
}
