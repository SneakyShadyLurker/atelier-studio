import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate';
import { textBackendModels } from '../providers/cliproxyText.config';
import { testConfig } from '../test/helpers';
import {
  configureTextBackendAvailability,
  resetTextBackendAvailabilityForTests,
} from './textBackendAvailability';
import {
  type AutoTextBackend,
  readTextBackendEfforts,
  readTextBackendOverrides,
  resolveTextBackend,
  resolveTextBackendEffort,
  writeTextBackendOverride,
} from './textBackendPreference';

const TEXT_MODELS = textBackendModels(testConfig());

function openMigratedDb(): { db: Database; close: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-text-backend-'));
  const db = new Database(':memory:');
  migrate(db, dataDir);
  return { db, close: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

describe('resolveTextBackend', () => {
  test('the auto type admits only Kimi and GPT', () => {
    const acceptsAuto = (backend: AutoTextBackend): AutoTextBackend => backend;
    expect(acceptsAuto('kimi')).toBe('kimi');
    expect(acceptsAuto('gpt')).toBe('gpt');
    // @ts-expect-error MiMo is selectable only as an override.
    acceptsAuto('mimo');
    // @ts-expect-error Grok is selectable only as an override.
    acceptsAuto('grok');
    // @ts-expect-error Gemini Argon is selectable only as an override.
    acceptsAuto('gemini-argon');
    // @ts-expect-error DeepSeek Abliterated is selectable only as an override.
    acceptsAuto('deepseek-abliterated');
    // @ts-expect-error GLM is selectable only as an override.
    acceptsAuto('glm-abliterated');
  });

  test('a legacy GPT pin routes as Auto on every target; GPT Auto needs a cloud target', () => {
    const { db, close } = openMigratedDb();
    try {
      writeTextBackendOverride(db, 'alice', 'ai-fill', 'gpt');
      expect(readTextBackendOverrides(db, 'alice')).toEqual({ 'ai-fill': 'gpt' });
      expect(resolveTextBackend(db, 'alice', 'ai-fill', 'kimi', { targetPool: 'cloud' })).toBe('kimi');
      expect(resolveTextBackend(db, 'alice', 'ai-fill', 'kimi', { targetPool: 'local' })).toBe('kimi');
      expect(resolveTextBackend(db, 'alice', 'ai-fill', 'kimi')).toBe('kimi');
      expect(resolveTextBackend(db, 'alice', 'ai-fill', 'gpt', { targetPool: 'local' })).toBe('kimi');
      expect(resolveTextBackend(db, 'alice', 'enhance', 'gpt', { targetPool: 'local' })).toBe('kimi');
      expect(resolveTextBackend(db, 'alice', 'enhance', 'gpt')).toBe('kimi');
    } finally {
      close();
    }
  });

  test('a legacy GPT pin does not route a BYOK target through GPT', () => {
    const { db, close } = openMigratedDb();
    try {
      // Google BYOK models (pool 'byok') reach the resolver as cloud targets.
      for (const workload of ['ai-fill', 'brainstorm', 'enhance'] as const) {
        writeTextBackendOverride(db, 'alice', workload, 'gpt');
        expect(resolveTextBackend(db, 'alice', workload, 'kimi', {
          targetModelId: 'gemini-3.1-flash-image-preview', targetPool: 'cloud',
        })).toBe('kimi');
      }
      expect(resolveTextBackend(db, 'alice', 'enhance', 'kimi', {
        targetModelId: 'gemini-3.1-flash-image-preview', targetPool: 'cloud', visionRequired: true,
      })).toBe('kimi');
    } finally {
      close();
    }
  });

  test('a validated Sunburst target fixes text work to GPT without rewriting stored preferences', () => {
    const { db, close } = openMigratedDb();
    try {
      writeTextBackendOverride(db, 'alice', 'enhance', 'mimo');
      const targetModelId = 'gpt-image-2.5-sunburst';
      expect(resolveTextBackend(db, 'alice', 'enhance', 'kimi', {
        targetModelId, targetPool: 'cloud', visionRequired: true,
      })).toBe('gpt');
      expect(readTextBackendOverrides(db, 'alice').enhance).toBe('mimo');
      expect(resolveTextBackend(db, 'alice', 'enhance', 'kimi', {
        targetModelId, targetPool: 'local',
      })).toBe('mimo');
    } finally {
      close();
    }
  });

  test('visionRequired uses GPT Auto for a cloud target with no vision-capable pin', () => {
    const { db, close } = openMigratedDb();
    try {
      const opts = { targetPool: 'cloud', visionRequired: true } as const;
      expect(resolveTextBackend(db, 'alice', 'enhance', 'gpt', opts)).toBe('gpt');
      writeTextBackendOverride(db, 'alice', 'enhance', 'grok');
      expect(resolveTextBackend(db, 'alice', 'enhance', 'gpt', opts)).toBe('grok');
      writeTextBackendOverride(db, 'alice', 'enhance', 'deepseek-abliterated');
      expect(resolveTextBackend(db, 'alice', 'enhance', 'gpt', opts)).toBe('gpt');
    } finally {
      close();
    }
  });

  test('absent row returns auto', () => {
    const { db, close } = openMigratedDb();
    try {
      expect(resolveTextBackend(db, 'alice', 'ai-fill', 'kimi')).toBe('kimi');
      expect(resolveTextBackend(db, 'alice', 'ai-fill', 'gpt', { targetPool: 'cloud' })).toBe('gpt');
    } finally {
      close();
    }
  });

  test('an override is honoured over auto', () => {
    const { db, close } = openMigratedDb();
    try {
      writeTextBackendOverride(db, 'alice', 'ai-fill', 'gemini-argon');
      expect(resolveTextBackend(db, 'alice', 'ai-fill', 'kimi')).toBe('gemini-argon');
      expect(resolveTextBackend(db, 'other-user', 'ai-fill', 'kimi')).toBe('kimi');
    } finally {
      close();
    }
  });

  test('every workload key round-trips through read/write/resolve', () => {
    const { db, close } = openMigratedDb();
    try {
      writeTextBackendOverride(db, 'alice', 'ai-fill', 'mimo');
      writeTextBackendOverride(db, 'alice', 'brainstorm', 'grok');
      writeTextBackendOverride(db, 'alice', 'enhance', 'gemini-argon');
      writeTextBackendOverride(db, 'alice', 'condense', 'deepseek-abliterated');
      writeTextBackendOverride(db, 'alice', 'storytelling', 'glm-abliterated');
      expect(readTextBackendOverrides(db, 'alice')).toEqual({
        'ai-fill': 'mimo',
        brainstorm: 'grok',
        enhance: 'gemini-argon',
        condense: 'deepseek-abliterated',
        storytelling: 'glm-abliterated',
      });
      expect(resolveTextBackend(db, 'alice', 'ai-fill', 'kimi')).toBe('mimo');
      expect(resolveTextBackend(db, 'alice', 'brainstorm', 'kimi')).toBe('grok');
      expect(resolveTextBackend(db, 'alice', 'enhance', 'kimi')).toBe('gemini-argon');
      expect(resolveTextBackend(db, 'alice', 'condense', 'kimi')).toBe('deepseek-abliterated');
      expect(resolveTextBackend(db, 'alice', 'storytelling', 'kimi')).toBe('glm-abliterated');
    } finally {
      close();
    }
  });

  test('a stored row for a retired workload never reaches the overrides', () => {
    const { db, close } = openMigratedDb();
    try {
      writeTextBackendOverride(db, 'alice', 'ai-fill', 'kimi');
      db.query(
        'INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES (?, ?, ?, ?)',
      ).run('alice', 'retired-workload', 'mimo', 0);
      expect(readTextBackendOverrides(db, 'alice')).toEqual({ 'ai-fill': 'kimi' });
    } finally {
      close();
    }
  });

  test('visionRequired honours every vision-capable override and falls back to Kimi otherwise', () => {
    const { db, close } = openMigratedDb();
    try {
      // MiMo, Grok and Gemini read images (verified), so image calls stay on their pins.
      for (const [workload, backend] of [['enhance', 'mimo'], ['condense', 'grok'], ['ai-fill', 'gemini-argon']] as const) {
        writeTextBackendOverride(db, 'alice', workload, backend);
        expect(resolveTextBackend(db, 'alice', workload, 'kimi', { visionRequired: true })).toBe(backend);
        expect(resolveTextBackend(db, 'alice', workload, 'kimi')).toBe(backend);
      }
      // Text-only backends never receive an image: the call falls back to
      // Kimi, while a text-only call stays on the pin.
      for (const backend of ['glm-abliterated', 'deepseek-abliterated'] as const) {
        writeTextBackendOverride(db, 'alice', 'storytelling', backend);
        expect(
          resolveTextBackend(db, 'alice', 'storytelling', 'kimi', { visionRequired: true }),
        ).toBe('kimi');
        expect(resolveTextBackend(db, 'alice', 'storytelling', 'kimi')).toBe(backend);
      }
      // A GPT Auto on a local target is replaced by Kimi before the vision check.
      expect(
        resolveTextBackend(db, 'alice', 'brainstorm', 'gpt', { visionRequired: true, targetPool: 'local' }),
      ).toBe('kimi');
    } finally {
      close();
    }
  });

  test("a retired Pro key from a skipped migration is an unknown value and is ignored", () => {
    const { db, close } = openMigratedDb();
    try {
      const retiredBackend = 'deepseek-pro';
      // The widened CHECK now rejects 'flash' at the DB level; recreate the
      // table checkless so a legacy row can be simulated for the validator.
      db.run('DROP TABLE user_text_backends');
      db.run(`
        CREATE TABLE user_text_backends (
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          workload   TEXT NOT NULL,
          backend    TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          effort     TEXT,
          PRIMARY KEY (user_id, workload)
        );
      `);
      db.query("INSERT INTO users (id, created_at) VALUES ('alice', 1)").run();
      db.query(
        "INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('alice', 'brainstorm', ?, 1)",
      ).run(retiredBackend);
      expect(readTextBackendOverrides(db, 'alice')).toEqual({});
      expect(resolveTextBackend(db, 'alice', 'brainstorm', 'kimi')).toBe('kimi');
    } finally {
      close();
    }
  });

  test('an unknown stored string is ignored', () => {
    const { db, close } = openMigratedDb();
    try {
      db.run('DROP TABLE user_text_backends');
      db.run(`
        CREATE TABLE user_text_backends (
          user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          workload   TEXT NOT NULL,
          backend    TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          effort     TEXT,
          PRIMARY KEY (user_id, workload)
        );
      `);
      db.query("INSERT INTO users (id, created_at) VALUES ('alice', 1)").run();
      db.query(
        "INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('alice', 'brainstorm', 'gpt-5', 1)",
      ).run();
      expect(readTextBackendOverrides(db, 'alice')).toEqual({});
      expect(resolveTextBackend(db, 'alice', 'brainstorm', 'kimi')).toBe('kimi');
    } finally {
      close();
    }
  });

  test('null clears back to auto', () => {
    const { db, close } = openMigratedDb();
    try {
      writeTextBackendOverride(db, 'alice', 'brainstorm', 'grok');
      writeTextBackendOverride(db, 'alice', 'brainstorm', null);
      expect(readTextBackendOverrides(db, 'alice')).toEqual({});
      expect(resolveTextBackend(db, 'alice', 'brainstorm', 'kimi')).toBe('kimi');
    } finally {
      close();
    }
  });

  test('a pin whose model the proxy does not serve routes as Auto, and is kept stored', () => {
    const { db, close } = openMigratedDb();
    try {
      writeTextBackendOverride(db, 'alice', 'ai-fill', 'deepseek-abliterated');
      const served = new Set(Object.values(TEXT_MODELS).filter((id) => id !== TEXT_MODELS['deepseek-abliterated']));
      configureTextBackendAvailability({ snapshot: () => served }, TEXT_MODELS);
      expect(resolveTextBackend(db, 'alice', 'ai-fill', 'kimi', { targetPool: 'local' })).toBe('kimi');
      expect(readTextBackendOverrides(db, 'alice')).toEqual({ 'ai-fill': 'deepseek-abliterated' });
    } finally {
      close();
    }
  });

  test('a Sunburst target stays on GPT even when the inventory lacks the GPT model', () => {
    const { db, close } = openMigratedDb();
    try {
      configureTextBackendAvailability({ snapshot: () => new Set([TEXT_MODELS.kimi]) }, TEXT_MODELS);
      expect(resolveTextBackend(db, 'alice', 'enhance', 'kimi', {
        targetModelId: 'gpt-image-2.5-sunburst', targetPool: 'cloud',
      })).toBe('gpt');
    } finally {
      close();
    }
  });

  test('an unknown proxy inventory honours the pin', () => {
    const { db, close } = openMigratedDb();
    try {
      writeTextBackendOverride(db, 'alice', 'ai-fill', 'deepseek-abliterated');
      configureTextBackendAvailability({ snapshot: () => null }, TEXT_MODELS);
      expect(resolveTextBackend(db, 'alice', 'ai-fill', 'kimi', { targetPool: 'local' })).toBe('deepseek-abliterated');
    } finally {
      close();
    }
  });
});

afterEach(() => {
  resetTextBackendAvailabilityForTests();
});

describe('text backend reasoning effort', () => {
  test('an effort follows its pin: kept while the new backend accepts it, dropped otherwise, cleared with the pin', () => {
    const { db, close } = openMigratedDb();
    try {
      writeTextBackendOverride(db, 'alice', 'enhance', 'kimi', 'high');
      expect(readTextBackendEfforts(db, 'alice')).toEqual({ enhance: 'high' });
      writeTextBackendOverride(db, 'alice', 'enhance', 'mimo');
      expect(readTextBackendEfforts(db, 'alice')).toEqual({ enhance: 'high' });

      writeTextBackendOverride(db, 'alice', 'enhance', 'mimo', 'none');
      // Kimi lists only low/high/max, so moving a 'none' pin there resets the effort.
      writeTextBackendOverride(db, 'alice', 'enhance', 'kimi');
      expect(readTextBackendEfforts(db, 'alice')).toEqual({});

      writeTextBackendOverride(db, 'alice', 'enhance', 'glm-abliterated', 'max');
      writeTextBackendOverride(db, 'alice', 'enhance', 'glm-abliterated', null);
      expect(readTextBackendEfforts(db, 'alice')).toEqual({});

      // Grok lists 'medium'; Gemini does too, MiMo does not.
      writeTextBackendOverride(db, 'alice', 'enhance', 'grok', 'medium');
      writeTextBackendOverride(db, 'alice', 'enhance', 'gemini-argon');
      expect(readTextBackendEfforts(db, 'alice')).toEqual({ enhance: 'medium' });
      writeTextBackendOverride(db, 'alice', 'enhance', 'mimo');
      expect(readTextBackendEfforts(db, 'alice')).toEqual({});

      writeTextBackendOverride(db, 'alice', 'enhance', 'deepseek-abliterated', 'minimal');
      writeTextBackendOverride(db, 'alice', 'enhance', null);
      writeTextBackendOverride(db, 'alice', 'enhance', 'deepseek-abliterated');
      expect(readTextBackendEfforts(db, 'alice')).toEqual({});
    } finally {
      close();
    }
  });

  test('the effort applies only when the pinned backend serves the call', () => {
    const { db, close } = openMigratedDb();
    try {
      writeTextBackendOverride(db, 'alice', 'brainstorm', 'grok', 'xhigh');
      expect(resolveTextBackendEffort(db, 'alice', 'brainstorm', 'grok')).toBe('xhigh');
      // An Auto route, a vision fallback or a failover partner keeps its default.
      expect(resolveTextBackendEffort(db, 'alice', 'brainstorm', 'kimi')).toBeUndefined();
      expect(resolveTextBackendEffort(db, 'alice', 'enhance', 'grok')).toBeUndefined();
    } finally {
      close();
    }
  });

  test('an unavailable pin keeps its effort out of an Auto route that lands on the same backend', () => {
    const { db, close } = openMigratedDb();
    try {
      writeTextBackendOverride(db, 'alice', 'condense', 'kimi', 'max');
      configureTextBackendAvailability({ snapshot: () => new Set([TEXT_MODELS.mimo]) }, TEXT_MODELS);
      expect(resolveTextBackend(db, 'alice', 'condense', 'kimi', { targetPool: 'local' })).toBe('kimi');
      expect(resolveTextBackendEffort(db, 'alice', 'condense', 'kimi')).toBeUndefined();
    } finally {
      close();
    }
  });

  test('a stored effort the backend no longer accepts never reaches the wire', () => {
    const { db, close } = openMigratedDb();
    try {
      db.query("INSERT INTO users (id, created_at) VALUES ('alice', 1)").run();
      db.query(
        "INSERT INTO user_text_backends (user_id, workload, backend, effort, updated_at) VALUES ('alice', 'ai-fill', 'kimi', 'none', 1)",
      ).run();
      db.query(
        "INSERT INTO user_text_backends (user_id, workload, backend, effort, updated_at) VALUES ('alice', 'enhance', 'gpt', 'high', 1)",
      ).run();
      expect(readTextBackendEfforts(db, 'alice')).toEqual({});
      expect(resolveTextBackendEffort(db, 'alice', 'ai-fill', 'kimi')).toBeUndefined();
      expect(resolveTextBackendEffort(db, 'alice', 'enhance', 'gpt')).toBeUndefined();
    } finally {
      close();
    }
  });
});
