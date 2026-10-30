import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AI_FILL_BACKEND_VALUES,
  isVisionTextBackend,
  TEXT_BACKEND_LABELS,
  TEXT_TASKS,
  textBackendReasoningEfforts,
  usesGenericPromptVariant,
} from '@atelier/shared';
import { BINARY_SCHEMA_VERSION, migrate } from './migrate';
import { LEGACY_SEED, legacyTextModelEnvVars, legacyTextSeed, staleLegacyTextModelEnvVars, type TextSeed } from './textSeed';
import {
  AI_FILL_DEFAULTS,
  GLM_ABLITERATED_MAX_COMPLETION_TOKENS,
  GROK_SAMPLING,
  TEXT_BACKEND_DEFAULT_REASONING_EFFORT,
} from '../providers/cliproxyText.config';
import { registryForConfig } from '../providers/registry';
import { testConfig } from '../test/helpers';
import type { AppLogger } from '../observability/logger';

const NEW_TABLES = ['text_providers', 'text_models', 'text_defaults', 'image_model_writers', 'user_text_models'];

const SEED: TextSeed = {
  baseUrl: 'http://cliproxy.lan:8317',
  modelIds: {
    kimi: 'kimi-x',
    mimo: 'mimo-x',
    grok: 'grok-x',
    'gemini-argon': 'gemini-x',
    'deepseek-abliterated': 'deepseek-x',
    'glm-abliterated': 'glm-x',
    gpt: 'gpt-x',
  },
  sunburstImageModelIds: ['gpt-image-2.5-sunburst'],
  gptImageModelIds: ['gpt-image-2'],
};

// [user, workload, backend, updated_at, effort]: every key, each with an effort.
const PINS = [
  ['u1', 'ai-fill', 'kimi', 11, 'high'],
  ['u1', 'brainstorm', 'mimo', 12, 'none'],
  ['u1', 'enhance', 'grok', 13, 'xhigh'],
  ['u1', 'condense', 'gemini-argon', 14, 'medium'],
  ['u1', 'storytelling', 'deepseek-abliterated', 15, 'minimal'],
  ['u2', 'ai-fill', 'glm-abliterated', 16, 'max'],
  ['u2', 'enhance', 'gpt', 17, 'low'],
] as const;
// The old resolver ignored stored GPT pins (routed as Auto), so the migration drops them.
const CARRIED_PINS = PINS.filter(([, , backend]) => backend !== 'gpt');

interface Logged {
  level: 'info' | 'warn';
  obj: unknown;
  msg: string | undefined;
}

function recordingLog(): { log: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void }; entries: Logged[] } {
  const entries: Logged[] = [];
  return {
    entries,
    log: {
      info: (obj, msg) => { entries.push({ level: 'info', obj, msg }); },
      warn: (obj, msg) => { entries.push({ level: 'warn', obj, msg }); },
    },
  };
}

function migrateLogged(db: Database, dataDir: string, options: { textSeed?: TextSeed } = {}): Logged[] {
  const { log, entries } = recordingLog();
  // The recorder implements the two logger methods migrate() calls.
  migrate(db, dataDir, { ...options, log: log as unknown as Pick<AppLogger, 'info' | 'warn'> });
  return entries;
}

function tableNames(db: Database): string[] {
  return db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
}

function count(db: Database, sql: string): number {
  return db.query<{ count: number }, []>(sql).get()?.count ?? -1;
}

function schemaVersion(db: Database): number {
  return db.query<{ version: number }, []>('SELECT MAX(version) AS version FROM schema_versions').get()?.version ?? 0;
}

/** A real v57 database with legacy pins for all seven keys. */
function openV57WithPins(): { db: Database; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig58-'));
  const db = new Database(':memory:');
  migrate(db, dataDir, { targetVersion: 57 });
  expect(schemaVersion(db)).toBe(57);
  db.run("INSERT INTO users (id, created_at) VALUES ('u1', 1), ('u2', 1)");
  const insert = db.query('INSERT INTO user_text_backends (user_id, workload, backend, updated_at, effort) VALUES (?, ?, ?, ?, ?)');
  for (const pin of PINS) insert.run(...pin);
  return { db, dataDir };
}

describe('migration 58 - text providers', () => {
  test('a fresh database gets all five tables, no rows and no legacy table; a rerun is a no-op', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig58-fresh-'));
    const db = new Database(':memory:');
    try {
      migrate(db, dataDir);
      expect(BINARY_SCHEMA_VERSION).toBe(58);
      expect(schemaVersion(db)).toBe(58);
      const tables = tableNames(db);
      for (const table of NEW_TABLES) {
        expect(tables).toContain(table);
        expect(count(db, `SELECT COUNT(*) AS count FROM ${table}`)).toBe(0);
      }
      expect(tables).not.toContain('user_text_backends');
      migrate(db, dataDir);
      expect(count(db, 'SELECT COUNT(*) AS count FROM schema_versions WHERE version = 58')).toBe(1);
    } finally {
      db.close();
    }
  });

  test('a fresh install never seeds, even when boot offers a seed', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-mig58-fresh-seed-'));
    const db = new Database(':memory:');
    try {
      migrate(db, dataDir, { textSeed: SEED });
      expect(count(db, 'SELECT COUNT(*) AS count FROM text_providers')).toBe(0);
      expect(count(db, 'SELECT COUNT(*) AS count FROM text_models')).toBe(0);
      expect(count(db, 'SELECT COUNT(*) AS count FROM image_model_writers')).toBe(0);
    } finally {
      db.close();
    }
  });

  test('upgrading v57 with a seed creates the provider, seven models, defaults, writers and carries every pin', () => {
    const { db, dataDir } = openV57WithPins();
    try {
      const logs = migrateLogged(db, dataDir, { textSeed: SEED });
      expect(schemaVersion(db)).toBe(58);
      const tables = tableNames(db);
      for (const table of NEW_TABLES) expect(tables).toContain(table);
      expect(tables).not.toContain('user_text_backends');

      const providers = db.query('SELECT * FROM text_providers').all() as Record<string, unknown>[];
      expect(providers).toHaveLength(1);
      const provider = providers[0];
      expect(provider).toMatchObject({
        name: 'CLIProxyAPI',
        protocol: 'openai-compatible',
        base_url: 'http://cliproxy.lan:8317/v1',
        preset: 'cliproxy-seed',
        auth_mode: 'env',
        credential_env: 'CLIPROXY_TOKEN',
        secret_ciphertext: null,
        token_field: 'max_completion_tokens',
        list_models: 1,
        enabled: 1,
      });
      expect(typeof provider?.id).toBe('string');
      expect(Number.isInteger(provider?.created_at)).toBe(true);

      const models = db.query(`
        SELECT legacy_key, model_id, display_name, enabled, vision, max_images, structured_output,
               reasoning_levels, reasoning_default, temperature, top_p, fixed_output_tokens,
               latency_profile, prompt_variant, screen_requests, sort_order, provider_id,
               typeof(created_at) AS created_type
          FROM text_models ORDER BY sort_order
      `).all();
      const row = (key: string, model_id: string, display_name: string, rest: Record<string, unknown>) => ({
        legacy_key: key,
        model_id,
        display_name,
        enabled: 1,
        max_images: null,
        temperature: null,
        top_p: null,
        fixed_output_tokens: null,
        latency_profile: 'standard',
        prompt_variant: 'generic',
        screen_requests: 0,
        provider_id: provider?.id,
        created_type: 'integer',
        ...rest,
      });
      // Spec § 11.1.
      expect(models).toEqual([
        row('kimi', 'kimi-x', 'Kimi K3', { vision: 1, structured_output: 'json_schema', reasoning_levels: '["low","high","max"]', reasoning_default: 'low', prompt_variant: 'kimi', sort_order: 0 }),
        row('mimo', 'mimo-x', 'MiMo V2.6 Pro', { vision: 1, structured_output: 'json_schema', reasoning_levels: '["none","high"]', reasoning_default: 'none', sort_order: 1 }),
        row('grok', 'grok-x', 'Grok 4.7', { vision: 1, structured_output: 'json_schema', reasoning_levels: '["low","medium","high","xhigh"]', reasoning_default: 'low', temperature: 0.7, top_p: 0.95, sort_order: 2 }),
        row('gemini-argon', 'gemini-x', 'Gemini 4 Argon', { vision: 1, structured_output: 'json_schema', reasoning_levels: '["low","medium","high"]', reasoning_default: 'low', sort_order: 3 }),
        row('deepseek-abliterated', 'deepseek-x', 'DeepSeek V4.1 Flash Abliterated', { vision: 0, structured_output: 'json_schema', reasoning_levels: '["none","minimal","low","medium","high","xhigh","max"]', reasoning_default: 'none', sort_order: 4 }),
        row('glm-abliterated', 'glm-x', 'GLM 5.3', { vision: 0, structured_output: 'none', reasoning_levels: '["low","high","max"]', reasoning_default: 'low', fixed_output_tokens: 32768, latency_profile: 'slow', sort_order: 5 }),
        row('gpt', 'gpt-x', 'GPT-6.1 Sol', { vision: 1, structured_output: 'json_schema', reasoning_levels: '[]', reasoning_default: 'medium', screen_requests: 1, sort_order: 6 }),
      ]);

      expect(db.query(`
        SELECT d.scope, m.legacy_key FROM text_defaults d JOIN text_models m ON m.id = d.text_model_id
      `).all()).toEqual([{ scope: 'default', legacy_key: 'kimi' }]);
      expect(db.query(`
        SELECT w.image_model_id, w.mode, m.legacy_key FROM image_model_writers w
          JOIN text_models m ON m.id = w.text_model_id ORDER BY w.image_model_id
      `).all()).toEqual([
        { image_model_id: 'gpt-image-2', mode: 'prefer', legacy_key: 'gpt' },
        { image_model_id: 'gpt-image-2.5-sunburst', mode: 'lock', legacy_key: 'gpt' },
      ]);
      expect(db.query(`
        SELECT u.user_id, u.task, m.legacy_key, u.updated_at, u.effort FROM user_text_models u
          JOIN text_models m ON m.id = u.text_model_id ORDER BY u.updated_at
      `).all()).toEqual(CARRIED_PINS.map(([user_id, task, legacy_key, updated_at, effort]) => ({ user_id, task, legacy_key, updated_at, effort })));
      expect(logs.filter((entry) => entry.level === 'warn').map((entry) => entry.obj)).toEqual([
        expect.objectContaining({ event: 'migration_text_pins_dropped', carried: CARRIED_PINS.length, dropped: 1 }),
      ]);

      // Rerun: no-op.
      const snapshot = (): unknown[] => NEW_TABLES.map((table) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all());
      const before = snapshot();
      migrate(db, dataDir, { textSeed: SEED });
      expect(snapshot()).toEqual(before);
      expect(count(db, 'SELECT COUNT(*) AS count FROM schema_versions WHERE version = 58')).toBe(1);

      // Cascades: deleting the provider removes models, defaults, writers and pins.
      db.run("DELETE FROM users WHERE id = 'u2'");
      expect(count(db, "SELECT COUNT(*) AS count FROM user_text_models WHERE user_id = 'u2'")).toBe(0);
      db.run('DELETE FROM text_providers');
      for (const table of NEW_TABLES) expect(count(db, `SELECT COUNT(*) AS count FROM ${table}`)).toBe(0);
      expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('legacy slots naming the same upstream id keep one row each with their own policy; pins, default and writers follow legacy_key', () => {
    const { db, dataDir } = openV57WithPins();
    try {
      // kimi and grok both point at one upstream id, and so do mimo and gpt.
      const seed: TextSeed = { ...SEED, modelIds: { ...SEED.modelIds, grok: 'kimi-x', gpt: 'mimo-x' } };
      const logs = migrateLogged(db, dataDir, { textSeed: seed });
      expect(schemaVersion(db)).toBe(58);
      expect(db.query(`
        SELECT legacy_key, model_id, reasoning_levels, reasoning_default, temperature, top_p,
               prompt_variant, screen_requests, sort_order
          FROM text_models ORDER BY sort_order
      `).all()).toEqual([
        { legacy_key: 'kimi', model_id: 'kimi-x', reasoning_levels: '["low","high","max"]', reasoning_default: 'low', temperature: null, top_p: null, prompt_variant: 'kimi', screen_requests: 0, sort_order: 0 },
        { legacy_key: 'mimo', model_id: 'mimo-x', reasoning_levels: '["none","high"]', reasoning_default: 'none', temperature: null, top_p: null, prompt_variant: 'generic', screen_requests: 0, sort_order: 1 },
        { legacy_key: 'grok', model_id: 'kimi-x', reasoning_levels: '["low","medium","high","xhigh"]', reasoning_default: 'low', temperature: 0.7, top_p: 0.95, prompt_variant: 'generic', screen_requests: 0, sort_order: 2 },
        { legacy_key: 'gemini-argon', model_id: 'gemini-x', reasoning_levels: '["low","medium","high"]', reasoning_default: 'low', temperature: null, top_p: null, prompt_variant: 'generic', screen_requests: 0, sort_order: 3 },
        { legacy_key: 'deepseek-abliterated', model_id: 'deepseek-x', reasoning_levels: '["none","minimal","low","medium","high","xhigh","max"]', reasoning_default: 'none', temperature: null, top_p: null, prompt_variant: 'generic', screen_requests: 0, sort_order: 4 },
        { legacy_key: 'glm-abliterated', model_id: 'glm-x', reasoning_levels: '["low","high","max"]', reasoning_default: 'low', temperature: null, top_p: null, prompt_variant: 'generic', screen_requests: 0, sort_order: 5 },
        { legacy_key: 'gpt', model_id: 'mimo-x', reasoning_levels: '[]', reasoning_default: 'medium', temperature: null, top_p: null, prompt_variant: 'generic', screen_requests: 1, sort_order: 6 },
      ]);
      expect(db.query(`
        SELECT d.scope, m.legacy_key FROM text_defaults d JOIN text_models m ON m.id = d.text_model_id
      `).all()).toEqual([{ scope: 'default', legacy_key: 'kimi' }]);
      // The GPT image writers stay on the screened GPT row, not on MiMo's.
      expect(db.query(`
        SELECT w.image_model_id, w.mode, m.legacy_key, m.screen_requests FROM image_model_writers w
          JOIN text_models m ON m.id = w.text_model_id ORDER BY w.image_model_id
      `).all()).toEqual([
        { image_model_id: 'gpt-image-2', mode: 'prefer', legacy_key: 'gpt', screen_requests: 1 },
        { image_model_id: 'gpt-image-2.5-sunburst', mode: 'lock', legacy_key: 'gpt', screen_requests: 1 },
      ]);
      // Each carried pin lands on its own slot's row (grok on grok, not kimi).
      expect(db.query(`
        SELECT u.user_id, u.task, m.legacy_key, u.effort FROM user_text_models u
          JOIN text_models m ON m.id = u.text_model_id ORDER BY u.updated_at
      `).all()).toEqual(CARRIED_PINS.map(([user_id, task, legacy_key, , effort]) => ({ user_id, task, legacy_key, effort })));
      // Only the usual dropped-GPT-pin warning; nothing collapses.
      expect(logs.filter((entry) => entry.level === 'warn').map((entry) => entry.obj)).toEqual([
        expect.objectContaining({ event: 'migration_text_pins_dropped', carried: CARRIED_PINS.length, dropped: 1 }),
      ]);

      const snapshot = (): unknown[] => NEW_TABLES.map((table) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all());
      const before = snapshot();
      migrate(db, dataDir, { textSeed: seed });
      expect(snapshot()).toEqual(before);
      db.run('DELETE FROM schema_versions WHERE version = 58');
      migrate(db, dataDir, { textSeed: seed });
      expect(snapshot()).toEqual(before);
    } finally {
      db.close();
    }
  });

  test('re-applying migration 58 after a committed seed (fn rerun) changes nothing', () => {
    const { db, dataDir } = openV57WithPins();
    try {
      migrate(db, dataDir, { textSeed: SEED });
      const before = NEW_TABLES.map((table) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all());
      // Simulate a crash after the fn returned but before the version marker.
      db.run('DELETE FROM schema_versions WHERE version = 58');
      migrate(db, dataDir, { textSeed: SEED });
      expect(NEW_TABLES.map((table) => db.query(`SELECT * FROM ${table} ORDER BY 1`).all())).toEqual(before);
      expect(schemaVersion(db)).toBe(58);
    } finally {
      db.close();
    }
  });

  test('upgrading v57 without a seed creates the tables, drops the pins and logs their count', () => {
    const { db, dataDir } = openV57WithPins();
    try {
      const logs = migrateLogged(db, dataDir);
      const tables = tableNames(db);
      for (const table of NEW_TABLES) {
        expect(tables).toContain(table);
        expect(count(db, `SELECT COUNT(*) AS count FROM ${table}`)).toBe(0);
      }
      expect(tables).not.toContain('user_text_backends');
      const warnings = logs.filter((entry) => entry.level === 'warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.obj).toMatchObject({ event: 'migration_text_pins_dropped', version: 58, carried: 0, dropped: PINS.length });
      expect(warnings[0]?.msg).toContain(String(PINS.length));
    } finally {
      db.close();
    }
  });

  test('a pin on a workload that is not a task is dropped and counted, not fatal', () => {
    const { db, dataDir } = openV57WithPins();
    try {
      db.run("INSERT INTO user_text_backends (user_id, workload, backend, updated_at, effort) VALUES ('u2', 'retired-workload', 'kimi', 18, NULL)");
      const logs = migrateLogged(db, dataDir, { textSeed: SEED });
      expect(count(db, 'SELECT COUNT(*) AS count FROM user_text_models')).toBe(CARRIED_PINS.length);
      expect(logs.find((entry) => entry.level === 'warn')?.obj).toMatchObject({ carried: CARRIED_PINS.length, dropped: 2 });
    } finally {
      db.close();
    }
  });

  test('a crash after the provider insert, before the pins move, leaves the old table and the rerun completes', () => {
    const { db, dataDir } = openV57WithPins();
    try {
      // Pre-create the tables (step 1 is idempotent) so a temp trigger can
      // abort the first pin insert, after the seed rows went in.
      db.run(readFileSync(new URL('./migrations/0058_text_providers.sql', import.meta.url), 'utf8'));
      db.run(`
        CREATE TEMP TRIGGER crash_before_pins BEFORE INSERT ON main.user_text_models
        BEGIN SELECT RAISE(ABORT, 'simulated crash'); END
      `);
      expect(() => { migrate(db, dataDir, { textSeed: SEED }); }).toThrow(/simulated crash/);
      expect(schemaVersion(db)).toBe(57);
      expect(count(db, 'SELECT COUNT(*) AS count FROM text_providers')).toBe(0);
      expect(count(db, 'SELECT COUNT(*) AS count FROM text_models')).toBe(0);
      expect(count(db, 'SELECT COUNT(*) AS count FROM user_text_backends')).toBe(PINS.length);

      db.run('DROP TRIGGER crash_before_pins');
      migrate(db, dataDir, { textSeed: SEED });
      expect(schemaVersion(db)).toBe(58);
      expect(count(db, 'SELECT COUNT(*) AS count FROM text_providers')).toBe(1);
      expect(count(db, 'SELECT COUNT(*) AS count FROM text_models')).toBe(7);
      expect(count(db, 'SELECT COUNT(*) AS count FROM user_text_models')).toBe(CARRIED_PINS.length);
      expect(tableNames(db)).not.toContain('user_text_backends');
    } finally {
      db.close();
    }
  });

  test('task CHECKs accept exactly TEXT_TASKS (and default for text_defaults)', () => {
    const { db, dataDir } = openV57WithPins();
    try {
      migrate(db, dataDir, { textSeed: SEED });
      db.run('DELETE FROM user_text_models');
      db.run('DELETE FROM text_defaults');
      const modelId = db.query<{ id: string }, []>("SELECT id FROM text_models WHERE legacy_key = 'kimi'").get()?.id;
      for (const task of TEXT_TASKS) {
        db.query("INSERT INTO user_text_models (user_id, task, text_model_id, effort, updated_at) VALUES ('u1', ?, ?, NULL, 1)").run(task, modelId ?? '');
        db.query('INSERT INTO text_defaults (scope, text_model_id, updated_at) VALUES (?, ?, 1)').run(task, modelId ?? '');
      }
      db.query("INSERT INTO text_defaults (scope, text_model_id, updated_at) VALUES ('default', ?, 1)").run(modelId ?? '');
      expect(() => db.query("INSERT INTO user_text_models (user_id, task, text_model_id, updated_at) VALUES ('u2', 'bogus', ?, 1)").run(modelId ?? ''))
        .toThrow(/CHECK constraint failed/i);
      expect(() => db.query("INSERT INTO text_defaults (scope, text_model_id, updated_at) VALUES ('bogus', ?, 1)").run(modelId ?? ''))
        .toThrow(/CHECK constraint failed/i);
      expect(() => db.query("INSERT INTO image_model_writers VALUES ('x', ?, 'always', 1)").run(modelId ?? ''))
        .toThrow(/CHECK constraint failed/i);
      // Auth-mode invariants.
      expect(() => db.run("INSERT INTO text_providers (id, name, protocol, base_url, auth_mode, created_at, updated_at) VALUES ('p', 'P', 'anthropic', 'http://x', 'env', 1, 1)"))
        .toThrow(/CHECK constraint failed/i);
      expect(() => db.run("INSERT INTO text_providers (id, name, protocol, base_url, auth_mode, created_at, updated_at) VALUES ('p', 'P', 'anthropic', 'http://x', 'stored', 1, 1)"))
        .toThrow(/CHECK constraint failed/i);
      db.run("INSERT INTO text_providers (id, name, protocol, base_url, auth_mode, created_at, updated_at) VALUES ('p', 'P', 'anthropic', 'http://x', 'none', 1, 1)");
      expect(() => db.run("INSERT INTO text_providers (id, name, protocol, base_url, auth_mode, created_at, updated_at) VALUES ('q', 'cliproxyapi', 'anthropic', 'http://x', 'none', 1, 1)"))
        .toThrow(/UNIQUE constraint failed/i);
    } finally {
      db.close();
    }
  });

  test('schema.sql header names the binary schema version', () => {
    const header = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').split('\n')[0];
    expect(header).toContain(`migrations 1-${BINARY_SCHEMA_VERSION}.`);
  });
});

describe('legacy text seed', () => {
  test('LEGACY_SEED reproduces the legacy backend constants', () => {
    expect(LEGACY_SEED.models.map((m) => m.legacyKey)).toEqual([...AI_FILL_BACKEND_VALUES]);
    const defaults = testConfig();
    for (const model of LEGACY_SEED.models) {
      const key = model.legacyKey;
      const caps = model.capabilities;
      expect(model.displayName).toBe(TEXT_BACKEND_LABELS[key]);
      expect(caps.vision).toBe(isVisionTextBackend(key));
      expect(caps.promptVariant).toBe(usesGenericPromptVariant(key) ? 'generic' : 'kimi');
      expect(caps.reasoningLevels).toEqual([...textBackendReasoningEfforts(key)]);
      expect(caps.reasoningDefault).toBe(TEXT_BACKEND_DEFAULT_REASONING_EFFORT[key] ?? AI_FILL_DEFAULTS.reasoning_effort);
      expect(model.screenRequests).toBe(key === 'gpt');
      expect(caps.temperature).toBe(key === 'grok' ? GROK_SAMPLING.temperature : null);
      expect(caps.topP).toBe(key === 'grok' ? GROK_SAMPLING.top_p : null);
      expect(caps.fixedOutputTokens).toBe(key === 'glm-abliterated' ? GLM_ABLITERATED_MAX_COMPLETION_TOKENS : null);
      expect(caps.latencyProfile).toBe(key === 'glm-abliterated' ? 'slow' : 'standard');
      expect(caps.structuredOutput).toBe(key === 'glm-abliterated' ? 'none' : 'json_schema');
      expect(model.defaultModelId).toBe(defaults[model.modelIdEnv as keyof typeof defaults] as string);
    }
  });

  test('legacyTextSeed reads the configured ids and splits the registry into Sunburst and other GPT image models', () => {
    const config = testConfig({ CLIPROXY_BASE_URL: 'http://cliproxy.lan:8317', CLIPROXY_TEXT_MODEL_GPT: 'gpt-custom' });
    const seed = legacyTextSeed(config, ['gpt-image-2.5-sunburst', 'gpt-image-2', 'gemini-3-pro-image', 'krea-2-x', 'mock-fast']);
    expect(seed).toEqual({
      baseUrl: 'http://cliproxy.lan:8317',
      modelIds: {
        kimi: 'kimi-latest',
        mimo: 'mimo-v2.6-pro',
        grok: 'grok-latest',
        'gemini-argon': 'gemini-4-argon',
        'deepseek-abliterated': 'abliterated-model-large-flash',
        'glm-abliterated': 'glm-5.3',
        gpt: 'gpt-custom',
      },
      sunburstImageModelIds: ['gpt-image-2.5-sunburst'],
      gptImageModelIds: ['gpt-image-2'],
    });
    // The real registry registers Sunburst.
    const registryIds = registryForConfig(config).map((entry) => entry.model.id);
    expect(legacyTextSeed(config, registryIds)?.sunburstImageModelIds).toEqual(['gpt-image-2.5-sunburst']);
  });

  test('legacyTextModelEnvVars lists only the set legacy model variables', () => {
    expect(legacyTextModelEnvVars({})).toEqual([]);
    expect(legacyTextModelEnvVars({ CLIPROXY_TEXT_MODEL_KIMI: 'k', CLIPROXY_TEXT_MODEL_GPT: '', CLIPROXY_BASE_URL: 'x' }))
      .toEqual(['CLIPROXY_TEXT_MODEL_KIMI']);
  });

  test('migrate reports the schema version the database started at', () => {
    const db = new Database(':memory:');
    expect(migrate(db, '/tmp').startVersion).toBe(0);
    expect(migrate(db, '/tmp').startVersion).toBe(BINARY_SCHEMA_VERSION);
  });

  describe('staleLegacyTextModelEnvVars (boot warning)', () => {
    const env = { CLIPROXY_TEXT_MODEL_KIMI: 'kimi-x' };

    test('nothing is stale when no legacy variable is set', () => {
      expect(staleLegacyTextModelEnvVars({}, { startVersion: 58, seedOffered: true })).toEqual([]);
    });

    test('the upgrade boot that seeds from them does not warn', () => {
      expect(staleLegacyTextModelEnvVars(env, { startVersion: 57, seedOffered: true })).toEqual([]);
    });

    test('they are stale once the seed migration has already run', () => {
      expect(staleLegacyTextModelEnvVars(env, { startVersion: 58, seedOffered: true }))
        .toEqual(['CLIPROXY_TEXT_MODEL_KIMI']);
    });

    test('they are stale when nothing seeds from them (fresh install or no CLIProxy)', () => {
      expect(staleLegacyTextModelEnvVars(env, { startVersion: 0, seedOffered: true }))
        .toEqual(['CLIPROXY_TEXT_MODEL_KIMI']);
      expect(staleLegacyTextModelEnvVars(env, { startVersion: 57, seedOffered: false }))
        .toEqual(['CLIPROXY_TEXT_MODEL_KIMI']);
    });
  });
});
