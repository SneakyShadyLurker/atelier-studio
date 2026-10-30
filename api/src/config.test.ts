import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAINSTORM_MAX_COUNT_CEILING } from '@atelier/shared';
import { ConfigError, ephemeraEnabled, loadConfig } from './config';

const validEnv = (): NodeJS.ProcessEnv => ({
  CLIPROXY_BASE_URL: 'http://127.0.0.1:8317',
  CLIPROXY_TOKEN: 'sk-cliproxy-test',
  DATA_DIR: '/tmp/atelier-test',
});

describe('loadConfig', () => {
  test('happy path returns frozen config with defaults filled in', () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.CLIPROXY_BASE_URL).toBe('http://127.0.0.1:8317');
    expect(cfg.CLIPROXY_TOKEN).toBe('sk-cliproxy-test');
    expect(cfg.COMFYUI_BASE_URL).toBeUndefined();
    expect(cfg.COMFYUI_MODELS_DIR).toBeUndefined();
    expect(cfg.COMFYUI_ENABLE_MODELS).toEqual([]);
    expect(cfg.DATA_DIR).toBe('/tmp/atelier-test');
    expect(cfg.API_HOST).toBe('0.0.0.0');
    expect(cfg.API_PORT).toBe(8787);
    expect(cfg.AUTH_HEADER_USER).toBe('Remote-User');
    expect(cfg.CLOUD_TIMEOUT_MS).toBe(300_000);
    expect(cfg.LOCAL_TIMEOUT_MS).toBe(600_000);
    expect(cfg.AI_FILL_PER_ATTEMPT_TIMEOUT_MS).toBe(120_000);
    expect(cfg.MAX_CONCURRENT_TILES).toBe(5);
    expect(cfg.MAX_CONCURRENT_TILES_PER_USER).toBe(4);
    expect(cfg.MAX_CONCURRENT_TILES_PER_USER_BYOK).toBe(8);
    expect(cfg.LOCAL_VIDEO_MAX_RESPONSE_BYTES).toBe(209_715_200);
    expect(cfg.MAX_INFLIGHT_VIDEO_PER_USER).toBe(1);
    expect(cfg.VIDEO_MODELS_ENABLED).toBe(false);
    expect(cfg.MAX_SEQUENCE_SEGMENTS).toBe(12);
    expect(cfg.SEQUENCE_STITCH_TIMEOUT_MS).toBe(120_000);
    expect(cfg.SEQUENCE_MASTER_MAX_BYTES).toBe(1_073_741_824);
    expect(cfg.MAX_QUEUED_BATCHES_PER_USER).toBe(20);
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  test('optional ComfyUI URL treats empty as unset and validates configured URLs', () => {
    expect(loadConfig({ ...validEnv(), COMFYUI_BASE_URL: '' }).COMFYUI_BASE_URL).toBeUndefined();
    expect(loadConfig({
      ...validEnv(),
      COMFYUI_BASE_URL: 'https://comfyui.example.internal:7860',
    }).COMFYUI_BASE_URL).toBe('https://comfyui.example.internal:7860');
    expect(() => loadConfig({ ...validEnv(), COMFYUI_BASE_URL: 'comfyui' })).toThrow(ConfigError);
  });

  describe('COMFYUI_MODELS_DIR', () => {
    const root = mkdtempSync(join(tmpdir(), 'atelier-config-models-'));
    afterAll(() => { rmSync(root, { recursive: true }); });

    test('accepts a readable directory', () => {
      expect(loadConfig({ ...validEnv(), COMFYUI_MODELS_DIR: root }).COMFYUI_MODELS_DIR).toBe(root);
    });

    test('rejects a missing path, a file and an unreadable directory', () => {
      const file = join(root, 'file.json');
      writeFileSync(file, '{}');
      const locked = join(root, 'locked');
      mkdirSync(locked);
      expect(() => loadConfig({ ...validEnv(), COMFYUI_MODELS_DIR: join(root, 'missing') })).toThrow(/COMFYUI_MODELS_DIR/);
      expect(() => loadConfig({ ...validEnv(), COMFYUI_MODELS_DIR: file })).toThrow(/COMFYUI_MODELS_DIR/);
      chmodSync(locked, 0o000);
      try {
        // root bypasses permission bits, so only assert when the mode is enforced.
        if (process.getuid?.() !== 0) {
          expect(() => loadConfig({ ...validEnv(), COMFYUI_MODELS_DIR: locked })).toThrow(/COMFYUI_MODELS_DIR/);
        }
      } finally {
        chmodSync(locked, 0o700);
      }
    });
  });

  test('COMFYUI_ENABLE_MODELS splits a comma-separated id list', () => {
    expect(loadConfig({ ...validEnv(), COMFYUI_ENABLE_MODELS: ' model-a , model-b,, ' }).COMFYUI_ENABLE_MODELS)
      .toEqual(['model-a', 'model-b']);
  });

  test('text backend model ids default to the unprefixed upstream ids and accept overrides', () => {
    const cfg = loadConfig(validEnv());
    expect([
      cfg.CLIPROXY_TEXT_MODEL_KIMI,
      cfg.CLIPROXY_TEXT_MODEL_MIMO,
      cfg.CLIPROXY_TEXT_MODEL_GROK,
      cfg.CLIPROXY_TEXT_MODEL_GEMINI_ARGON,
      cfg.CLIPROXY_TEXT_MODEL_DEEPSEEK_ABLITERATED,
      cfg.CLIPROXY_TEXT_MODEL_GLM_ABLITERATED,
      cfg.CLIPROXY_TEXT_MODEL_GPT,
    ]).toEqual([
      'kimi-latest',
      'mimo-v2.6-pro',
      'grok-latest',
      'gemini-4-argon',
      'abliterated-model-large-flash',
      'glm-5.3',
      'gpt-6.1-sol',
    ]);
    expect(loadConfig({ ...validEnv(), CLIPROXY_TEXT_MODEL_KIMI: 'proxy/kimi' }).CLIPROXY_TEXT_MODEL_KIMI).toBe('proxy/kimi');
  });

  test('user allowlists default to empty (nobody)', () => {
    const c = loadConfig(validEnv());
    expect(c.PROMPT_LIBRARY_USERS.size).toBe(0);
    expect(c.LOCAL_MODELS_USERS.size).toBe(0);
    expect(c.EPHEMERA_USERS.size).toBe(0);
  });

  test('PROMPT_LIBRARY_USERS splits, trims, dedupes', () => {
    const c = loadConfig({ ...validEnv(), PROMPT_LIBRARY_USERS: ' bob , alice ,bob ' });
    expect([...c.PROMPT_LIBRARY_USERS].sort()).toEqual(['alice', 'bob']);
  });

  test('explicit empty PROMPT_LIBRARY_USERS disables the feature', () => {
    const c = loadConfig({ ...validEnv(), PROMPT_LIBRARY_USERS: '' });
    expect(c.PROMPT_LIBRARY_USERS.size).toBe(0);
  });

  test('TEXT_PROVIDER_ADMINS defaults to nobody, splits, trims and dedupes', () => {
    expect(loadConfig(validEnv()).TEXT_PROVIDER_ADMINS.size).toBe(0);
    expect(loadConfig({ ...validEnv(), TEXT_PROVIDER_ADMINS: '' }).TEXT_PROVIDER_ADMINS.size).toBe(0);
    const c = loadConfig({ ...validEnv(), TEXT_PROVIDER_ADMINS: ' bob , alice ,bob ' });
    expect([...c.TEXT_PROVIDER_ADMINS].sort()).toEqual(['alice', 'bob']);
  });

  test('LOCAL_MODELS_USERS splits, trims, dedupes', () => {
    const c = loadConfig({ ...validEnv(), LOCAL_MODELS_USERS: ' bob , alice ,bob ' });
    expect([...c.LOCAL_MODELS_USERS].sort()).toEqual(['alice', 'bob']);
  });

  test('explicit empty LOCAL_MODELS_USERS disables local models for everyone', () => {
    const c = loadConfig({ ...validEnv(), LOCAL_MODELS_USERS: '' });
    expect(c.LOCAL_MODELS_USERS.size).toBe(0);
  });

  test('brainstorm defaults are present and within the shared ceiling', () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.BRAINSTORM_MAX_COUNT).toBeLessThanOrEqual(BRAINSTORM_MAX_COUNT_CEILING);
    expect(cfg.BRAINSTORM_MAX_RESPONSE_BYTES).toBeGreaterThan(0);
  });

  test('brainstorm count override above the ceiling is clamped', () => {
    const cfg = loadConfig({ ...validEnv(), BRAINSTORM_MAX_COUNT: '999' });
    expect(cfg.BRAINSTORM_MAX_COUNT).toBe(BRAINSTORM_MAX_COUNT_CEILING);
  });

  test.each([
    ['CLIPROXY_BASE_URL'],
    ['CLIPROXY_TOKEN'],
    ['DATA_DIR'],
  ] as const)('missing required %s throws ConfigError naming the var', (varName) => {
    const env = validEnv();
    Reflect.deleteProperty(env, varName);
    let caught: unknown = null;
    try {
      loadConfig(env);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const err = caught as ConfigError;
    expect(err.issues.some((i) => i.var === varName)).toBe(true);
    expect(err.message).toContain(varName);
  });

  test('production surfaces ALL invariant violations at once (not just the first)', () => {
    const env: NodeJS.ProcessEnv = {
      ...validEnv(),
      NODE_ENV: 'production',
      MAX_CONCURRENT_TILES_PER_USER: '1', // below MAX_TILE_COUNT -> cap issue
      BYOK_ENCRYPTION_KEY: 'a'.repeat(64), // valid, so it is NOT an issue
      // TRUSTED_PROXY_KEY omitted -> key issue
    };
    let caught: unknown = null;
    try {
      loadConfig(env);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const vars = (caught as ConfigError).issues.map((i) => i.var);
    expect(vars).toContain('MAX_CONCURRENT_TILES_PER_USER');
    expect(vars).toContain('TRUSTED_PROXY_KEY');
  });

  test('a non-numeric numeric env var reports a clear positive-integer message', () => {
    let caught: unknown = null;
    try {
      loadConfig({ ...validEnv(), API_PORT: 'abc' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const issue = (caught as ConfigError).issues.find((i) => i.var === 'API_PORT');
    expect(issue?.message).toBe('must be a positive integer');
  });

  test('empty CLIPROXY_TOKEN is rejected', () => {
    const env = { ...validEnv(), CLIPROXY_TOKEN: '' };
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  test('non-URL CLIPROXY_BASE_URL is rejected', () => {
    const env = { ...validEnv(), CLIPROXY_BASE_URL: 'not a url' };
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  test('non-http(s) CLIPROXY_BASE_URL is rejected', () => {
    const env = { ...validEnv(), CLIPROXY_BASE_URL: 'ftp://example.com' };
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  test('empty-string optional vars fall back to defaults (not silent override)', () => {
    // Regression — previously these used `transform(v => v ?? default)`, which
    // accepted '' as a valid value and silently neutered the auth header.
    const cfg = loadConfig({
      ...validEnv(),
      API_HOST: '',
      AUTH_HEADER_USER: '',
      LOG_LEVEL: '',
    });
    expect(cfg.API_HOST).toBe('0.0.0.0');
    expect(cfg.AUTH_HEADER_USER).toBe('Remote-User');
    expect(cfg.LOG_LEVEL).toBe('info');
  });

  test('overriding optional vars round-trips numeric strings to numbers', () => {
    const cfg = loadConfig({
      ...validEnv(),
      API_PORT: '9090',
      CLOUD_TIMEOUT_MS: '120000',
      MAX_CONCURRENT_TILES: '8',
      LOCAL_VIDEO_MAX_RESPONSE_BYTES: '314572800',
      MAX_INFLIGHT_VIDEO_PER_USER: '2',
      LOG_LEVEL: 'debug',
    });
    expect(cfg.API_PORT).toBe(9090);
    expect(cfg.CLOUD_TIMEOUT_MS).toBe(120_000);
    expect(cfg.MAX_CONCURRENT_TILES).toBe(8);
    expect(cfg.LOCAL_VIDEO_MAX_RESPONSE_BYTES).toBe(314_572_800);
    expect(cfg.MAX_INFLIGHT_VIDEO_PER_USER).toBe(2);
    expect(cfg.LOG_LEVEL).toBe('debug');
  });

  test('VIDEO_MODELS_ENABLED uses the boolish env convention', () => {
    const videoEnv = { ...validEnv(), COMFYUI_BASE_URL: 'https://comfyui.example.internal:7860' };
    expect(loadConfig({ ...videoEnv, VIDEO_MODELS_ENABLED: 'true' }).VIDEO_MODELS_ENABLED).toBe(true);
    expect(loadConfig({ ...videoEnv, VIDEO_MODELS_ENABLED: '1' }).VIDEO_MODELS_ENABLED).toBe(true);
    expect(loadConfig({ ...validEnv(), VIDEO_MODELS_ENABLED: 'false' }).VIDEO_MODELS_ENABLED).toBe(false);
  });

  test('VIDEO_MODELS_ENABLED=true requires COMFYUI_BASE_URL (H3 host)', () => {
    expect(() => loadConfig({ ...validEnv(), VIDEO_MODELS_ENABLED: 'true' })).toThrow(/COMFYUI_BASE_URL: is required/);
  });

  test('non-numeric API_PORT is rejected', () => {
    const env = { ...validEnv(), API_PORT: 'not-a-number' };
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  test('zero or negative MAX_CONCURRENT_TILES is rejected', () => {
    expect(() => loadConfig({ ...validEnv(), MAX_CONCURRENT_TILES: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv(), MAX_CONCURRENT_TILES: '-1' })).toThrow(ConfigError);
  });

  test('INFER_DIMENSIONS_BATCH_CONCURRENCY rejects values above the hard cap', () => {
    // An operator setting this to 100 would fan one /infer into one upstream
    // call per list — swamping the reasoning model queue the parallel-dispatch
    // fix is trying to protect. Hard cap at 16; reject overrides above it.
    expect(() => loadConfig({ ...validEnv(), INFER_DIMENSIONS_BATCH_CONCURRENCY: '17' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv(), INFER_DIMENSIONS_BATCH_CONCURRENCY: '100' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv(), INFER_DIMENSIONS_BATCH_CONCURRENCY: '16' })).not.toThrow();
    expect(() => loadConfig({ ...validEnv(), INFER_DIMENSIONS_BATCH_CONCURRENCY: '12' })).not.toThrow();
  });

  test('resilience knobs default to bounded production-safe values', () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.INFER_TOTAL_BUDGET_MS).toBe(500_000);
    expect(cfg.RESILIENT_PER_ATTEMPT_TIMEOUT_MS).toBe(70_000);
    expect(cfg.INFER_TAXONOMY_TIMEOUT_MS).toBe(180_000);
    expect(cfg.RESILIENT_MAX_ATTEMPTS).toBe(2);
    expect(cfg.RESILIENT_INITIAL_BACKOFF_MS).toBe(800);
    expect(cfg.RESILIENT_MAX_BACKOFF_MS).toBe(8_000);
    expect(cfg.RESILIENT_BREAKER_THRESHOLD).toBe(8);
    expect(cfg.RESILIENT_HALF_OPEN_AFTER_MS).toBe(30_000);
    expect(cfg.ENHANCE_OPEN_TIMEOUT_MS).toBe(15_000);
    expect(cfg.SWAG_PROXY_READ_TIMEOUT_MS).toBe(600_000);
    expect(cfg.INFER_DIMENSIONS_BATCH_CONCURRENCY).toBe(12);
  });

  test('resilience budget rejects per-attempt attempts without total headroom', () => {
    expect(() =>
      loadConfig({
        ...validEnv(),
        RESILIENT_PER_ATTEMPT_TIMEOUT_MS: '180000',
        RESILIENT_MAX_ATTEMPTS: '5',
        INFER_TOTAL_BUDGET_MS: '120000',
      }),
    ).toThrow(/INFER_TOTAL_BUDGET_MS/);
  });

  test('resilience budget accounts for taxonomy, chunk waves, and retry backoff envelope', () => {
    expect(() =>
      loadConfig({
        ...validEnv(),
        INFER_DIMENSIONS_BATCH_CONCURRENCY: '1',
      }),
    ).toThrow(/need at least/);
    expect(() =>
      loadConfig({
        ...validEnv(),
        RESILIENT_PER_ATTEMPT_TIMEOUT_MS: '70000',
        RESILIENT_MAX_ATTEMPTS: '2',
        RESILIENT_MAX_BACKOFF_MS: '8000',
        INFER_TOTAL_BUDGET_MS: '500000',
      }),
    ).not.toThrow();
  });

  test('taxonomy timeout is wired into the budget envelope', () => {
    // The Pass-1 taxonomy call has its own larger single-attempt timeout. A
    // taxonomy timeout big enough to overflow INFER_TOTAL_BUDGET_MS must be
    // rejected at boot — proving the taxonomy term participates in the
    // envelope rather than the (smaller) RESILIENT per-attempt timeout.
    // Default envelope: 180_000 (taxonomy) + 148_000 (wave1) + 70_000 (wave2)
    // + 60_000 = 458_000 <= 500_000.
    expect(() =>
      loadConfig({ ...validEnv(), INFER_TAXONOMY_TIMEOUT_MS: '180000' }),
    ).not.toThrow();
    // 300_000 + 148_000 + 70_000 + 60_000 = 578_000 > 500_000.
    expect(() =>
      loadConfig({ ...validEnv(), INFER_TAXONOMY_TIMEOUT_MS: '300000' }),
    ).toThrow(/need at least/);
  });

  test('infer total budget must leave at least 60s under SWAG read timeout', () => {
    expect(() =>
      loadConfig({
        ...validEnv(),
        INFER_TOTAL_BUDGET_MS: '500000',
        SWAG_PROXY_READ_TIMEOUT_MS: '600000',
      }),
    ).not.toThrow();
    expect(() =>
      loadConfig({
        ...validEnv(),
        INFER_TOTAL_BUDGET_MS: '580000',
        SWAG_PROXY_READ_TIMEOUT_MS: '600000',
      }),
    ).toThrow(/SWAG_PROXY_READ_TIMEOUT_MS/);
  });

  test('image resilience knobs: defaults and overrides', () => {
    const base = loadConfig(validEnv());
    expect(base.IMAGE_RETRY_MAX_ATTEMPTS).toBe(3);
    expect(base.IMAGE_RETRY_INITIAL_BACKOFF_MS).toBe(1000);
    expect(base.IMAGE_RETRY_MAX_BACKOFF_MS).toBe(8000);
    expect(base.IMAGE_BREAKER_THRESHOLD).toBe(5);
    expect(base.IMAGE_BREAKER_HALF_OPEN_MS).toBe(15000);
    expect(base.IMAGE_BREAKER_MAX_PAUSE_MS).toBe(300000);

    const over = loadConfig({ ...validEnv(), IMAGE_BREAKER_THRESHOLD: '9' });
    expect(over.IMAGE_BREAKER_THRESHOLD).toBe(9);
  });

  test('MAX_TEMPLATE_BODY_BYTES cannot exceed the transport hard cap', () => {
    // The Zod transport cap (TEMPLATE_BODY_HARD_MAX in prompts/limits.ts) and
    // this runtime cap must agree: a runtime value above the transport ceiling
    // would 400 every legitimate request. Fail-fast at boot.
    expect(() => loadConfig({ ...validEnv(), MAX_TEMPLATE_BODY_BYTES: '262145' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv(), MAX_TEMPLATE_BODY_BYTES: '500000' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv(), MAX_TEMPLATE_BODY_BYTES: '262144' })).not.toThrow();
    expect(() => loadConfig({ ...validEnv(), MAX_TEMPLATE_BODY_BYTES: '65536' })).not.toThrow();
  });

  test('prompt library array caps cannot exceed the transport hard cap', () => {
    expect(() => loadConfig({ ...validEnv(), MAX_OPTIONS_PER_LIST: '2000' })).not.toThrow();
    expect(() => loadConfig({ ...validEnv(), MAX_OPTIONS_PER_LIST: '2001' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv(), MAX_TAGS_PER_DIMENSION: '2000' })).not.toThrow();
    expect(() => loadConfig({ ...validEnv(), MAX_TAGS_PER_DIMENSION: '2001' })).toThrow(ConfigError);
  });

  test('per-user cap above global cap is rejected', () => {
    // The global cap binds first; allowing per-user > global would be a
    // silent misconfiguration where an operator believes they've raised
    // per-user limits.
    let caught: unknown = null;
    try {
      loadConfig({ ...validEnv(), MAX_CONCURRENT_TILES: '4', MAX_CONCURRENT_TILES_PER_USER: '6' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const err = caught as ConfigError;
    expect(err.issues.some((i) => i.var === 'MAX_CONCURRENT_TILES_PER_USER')).toBe(true);
  });

  test('per-user cap equal to global cap is accepted', () => {
    // Equal is fine — disables fairness, but useful for single-user setups.
    expect(() => loadConfig({ ...validEnv(), MAX_CONCURRENT_TILES: '4', MAX_CONCURRENT_TILES_PER_USER: '4' })).not.toThrow();
  });

  test('BYOK per-user cap is independent of the shared global cap guard', () => {
    // BYOK has no server-wide cap (each user spends their own quota), so
    // MAX_CONCURRENT_TILES_PER_USER_BYOK can exceed MAX_CONCURRENT_TILES
    // without tripping the per-user > global guard.
    const cfg = loadConfig({
      ...validEnv(),
      MAX_CONCURRENT_TILES: '5',
      MAX_CONCURRENT_TILES_PER_USER: '4',
      MAX_CONCURRENT_TILES_PER_USER_BYOK: '8',
    });
    expect(cfg.MAX_CONCURRENT_TILES_PER_USER_BYOK).toBe(8);
  });

  test('zero or negative MAX_CONCURRENT_TILES_PER_USER_BYOK is rejected', () => {
    expect(() => loadConfig({ ...validEnv(), MAX_CONCURRENT_TILES_PER_USER_BYOK: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv(), MAX_CONCURRENT_TILES_PER_USER_BYOK: '-1' })).toThrow(ConfigError);
  });

  test('legacy MAX_CONCURRENT_BATCHES env throws ConfigError naming the rename', () => {
    // Migration guard: silently ignoring the old name would let operators boot
    // with the new default of 4 instead of their configured limit.
    let caught: unknown = null;
    try {
      loadConfig({ ...validEnv(), MAX_CONCURRENT_BATCHES: '1' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const err = caught as ConfigError;
    expect(err.issues.some((i) => i.var === 'MAX_CONCURRENT_BATCHES')).toBe(true);
    expect(err.message).toContain('MAX_CONCURRENT_TILES');
  });

  test('empty-string MAX_CONCURRENT_BATCHES is treated as unset (does not trip the guard)', () => {
    // Mirrors the empty-string-is-default convention used elsewhere.
    expect(() => loadConfig({ ...validEnv(), MAX_CONCURRENT_BATCHES: '' })).not.toThrow();
  });

  test('invalid LOG_LEVEL is rejected', () => {
    const env = { ...validEnv(), LOG_LEVEL: 'verbose' };
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  test('ConfigError lists every missing required var', () => {
    const env: NodeJS.ProcessEnv = {};
    let caught: unknown = null;
    try {
      loadConfig(env);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const err = caught as ConfigError;
    const names = err.issues.map((i) => i.var);
    expect(names).toContain('CLIPROXY_BASE_URL');
    expect(names).toContain('CLIPROXY_TOKEN');
    expect(names).toContain('DATA_DIR');
  });

  describe('production TRUSTED_PROXY_KEY invariant', () => {
    const longKey = 'a'.repeat(48);
    const byokKey = 'b'.repeat(64);

    test('production with valid long key passes', () => {
      const cfg = loadConfig({
        ...validEnv(),
        NODE_ENV: 'production',
        TRUSTED_PROXY_KEY: longKey,
        BYOK_ENCRYPTION_KEY: byokKey,
        STORAGE_ROOT_RECIPIENT: 'age1pq1testrecipient',
      });
      expect(cfg.TRUSTED_PROXY_KEY).toBe(longKey);
      expect(cfg.BYOK_ENCRYPTION_KEY).toBe(byokKey);
    });

    test('production without TRUSTED_PROXY_KEY fails', () => {
      let caught: unknown = null;
      try {
        loadConfig({ ...validEnv(), NODE_ENV: 'production' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).issues[0]?.var).toBe('TRUSTED_PROXY_KEY');
      expect((caught as ConfigError).message).toContain('TRUSTED_PROXY_KEY');
    });

    test('production with empty TRUSTED_PROXY_KEY fails', () => {
      expect(() =>
        loadConfig({ ...validEnv(), NODE_ENV: 'production', TRUSTED_PROXY_KEY: '' }),
      ).toThrow(ConfigError);
    });

    test('production with placeholder TRUSTED_PROXY_KEY fails', () => {
      // The shipped .env.production.example uses a `replace-with-...`
      // placeholder; a deploy that copied the file but never edited the
      // value MUST refuse to boot.
      const placeholder = 'replace-with-a-long-random-string-MUST-match-SWAG-conf';
      let caught: unknown = null;
      try {
        loadConfig({ ...validEnv(), NODE_ENV: 'production', TRUSTED_PROXY_KEY: placeholder });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).issues[0]?.message).toContain('placeholder');
    });

    test('production with too-short TRUSTED_PROXY_KEY fails', () => {
      let caught: unknown = null;
      try {
        loadConfig({ ...validEnv(), NODE_ENV: 'production', TRUSTED_PROXY_KEY: 'abcd1234' });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).issues[0]?.message).toContain('32');
    });

    test('non-production environments still allow missing TRUSTED_PROXY_KEY', () => {
      // Dev and test must remain frictionless — local boots without SWAG.
      const dev = loadConfig({ ...validEnv(), NODE_ENV: 'development' });
      expect(dev.TRUSTED_PROXY_KEY).toBeUndefined();
      const test = loadConfig({ ...validEnv(), NODE_ENV: 'test' });
      expect(test.TRUSTED_PROXY_KEY).toBeUndefined();
      const unset = loadConfig(validEnv());
      expect(unset.TRUSTED_PROXY_KEY).toBeUndefined();
    });
  });

  describe('BYOK_ENCRYPTION_KEY', () => {
    const baseEnv = {
      ...validEnv(),
      DATA_DIR: '/tmp/atelier-test',
      TRUSTED_PROXY_KEY: 'a'.repeat(40),
    };

    test('optional outside production', () => {
      const cfg = loadConfig({ ...baseEnv, NODE_ENV: 'test' });
      expect(cfg.BYOK_ENCRYPTION_KEY).toBeUndefined();
    });

    test('required in production', () => {
      expect(() =>
        loadConfig({ ...baseEnv, NODE_ENV: 'production' }),
      ).toThrow(/BYOK_ENCRYPTION_KEY/);
    });

    test('rejects non-hex in production', () => {
      expect(() =>
        loadConfig({
          ...baseEnv,
          NODE_ENV: 'production',
          BYOK_ENCRYPTION_KEY: 'not-hex',
        }),
      ).toThrow(/BYOK_ENCRYPTION_KEY/);
    });

    test('rejects wrong length in production', () => {
      expect(() =>
        loadConfig({
          ...baseEnv,
          NODE_ENV: 'production',
          BYOK_ENCRYPTION_KEY: 'a'.repeat(63),
        }),
      ).toThrow(/BYOK_ENCRYPTION_KEY/);
    });

    test('accepts 64 hex in production', () => {
      const cfg = loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        BYOK_ENCRYPTION_KEY: 'a'.repeat(64),
        STORAGE_ROOT_RECIPIENT: 'age1pq1testrecipient',
      });
      expect(cfg.BYOK_ENCRYPTION_KEY).toBe('a'.repeat(64));
    });
  });

  describe('STORAGE_ROOT_RECIPIENT', () => {
    const prodEnv = (): NodeJS.ProcessEnv => ({
      ...validEnv(),
      NODE_ENV: 'production',
      TRUSTED_PROXY_KEY: 'k'.repeat(48),
      BYOK_ENCRYPTION_KEY: 'a'.repeat(64),
    });

    test('is optional outside production and blank means unset', () => {
      expect(loadConfig(validEnv()).STORAGE_ROOT_RECIPIENT).toBeUndefined();
      expect(loadConfig({ ...validEnv(), STORAGE_ROOT_RECIPIENT: '' }).STORAGE_ROOT_RECIPIENT).toBeUndefined();
    });

    test('is required in production', () => {
      expect(() => loadConfig(prodEnv())).toThrow(/STORAGE_ROOT_RECIPIENT/);
      expect(loadConfig({ ...prodEnv(), STORAGE_ROOT_RECIPIENT: ' age1pq1abc ' }).STORAGE_ROOT_RECIPIENT).toBe('age1pq1abc');
    });

    test('rejects values that are not age recipients', () => {
      expect(() => loadConfig({ ...validEnv(), STORAGE_ROOT_RECIPIENT: 'AGE-SECRET-KEY-PQ-1ABC' })).toThrow(/STORAGE_ROOT_RECIPIENT/);
    });
  });
});

describe('Ephemera integration config', () => {
  const ephemeraKey = 'e'.repeat(48);
  const ephemeraEnv = (): NodeJS.ProcessEnv => ({
    ...validEnv(),
    EPHEMERA_BASE_URL: 'http://host.docker.internal:8789',
    EPHEMERA_INTEGRATION_KEY: ephemeraKey,
    EPHEMERA_ORIGIN: 'https://ephemera.example.org',
  });
  const prodEnv = (): NodeJS.ProcessEnv => ({
    ...ephemeraEnv(),
    NODE_ENV: 'production',
    TRUSTED_PROXY_KEY: 'k'.repeat(48),
    BYOK_ENCRYPTION_KEY: 'a'.repeat(64),
    STORAGE_ROOT_RECIPIENT: 'age1pq1testrecipient',
  });
  const issuesOf = (env: NodeJS.ProcessEnv): readonly { var: string; message: string }[] => {
    try {
      loadConfig(env);
    } catch (error) {
      if (error instanceof ConfigError) return error.issues;
      throw error;
    }
    throw new Error('expected loadConfig to throw a ConfigError');
  };

  test('an unset base URL loads with the integration off', () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.EPHEMERA_BASE_URL).toBeUndefined();
    expect(cfg.EPHEMERA_INTEGRATION_KEY).toBeUndefined();
    expect(cfg.EPHEMERA_ORIGIN).toBeUndefined();
    expect(cfg.EPHEMERA_USERS.size).toBe(0);
    expect(cfg.EPHEMERA_CARD_TIMEOUT_MS).toBe(540_000);
    expect(ephemeraEnabled(cfg)).toBe(false);
    const on = loadConfig(ephemeraEnv());
    expect(ephemeraEnabled(on)).toBe(true);
    expect(on.EPHEMERA_ORIGIN).toBe('https://ephemera.example.org');
  });

  test('an empty EPHEMERA_BASE_URL and an empty EPHEMERA_ORIGIN count as unset', () => {
    const cfg = loadConfig({ ...validEnv(), EPHEMERA_BASE_URL: '', EPHEMERA_ORIGIN: '' });
    expect(cfg.EPHEMERA_BASE_URL).toBeUndefined();
    expect(cfg.EPHEMERA_ORIGIN).toBeUndefined();
    expect(ephemeraEnabled(cfg)).toBe(false);
  });

  test('a base URL without key and origin names both variables in one error', () => {
    const names = issuesOf({ ...validEnv(), EPHEMERA_BASE_URL: 'http://host.docker.internal:8789' })
      .map((issue) => issue.var);
    expect(names).toContain('EPHEMERA_INTEGRATION_KEY');
    expect(names).toContain('EPHEMERA_ORIGIN');
  });

  test('a non-origin EPHEMERA_ORIGIN (path or trailing slash) is refused', () => {
    for (const origin of ['https://ephemera.example.org/', 'https://ephemera.example.org/app', 'ephemera.example.org']) {
      expect(issuesOf({ ...ephemeraEnv(), EPHEMERA_ORIGIN: origin }).map((issue) => issue.var))
        .toContain('EPHEMERA_ORIGIN');
    }
  });

  test('a placeholder or short key in production is refused', () => {
    expect(loadConfig(prodEnv()).EPHEMERA_INTEGRATION_KEY).toBe(ephemeraKey);
    const placeholder = issuesOf({ ...prodEnv(), EPHEMERA_INTEGRATION_KEY: 'replace-with-a-long-random-string-for-ephemera' });
    expect(placeholder.find((issue) => issue.var === 'EPHEMERA_INTEGRATION_KEY')?.message).toContain('placeholder');
    const short = issuesOf({ ...prodEnv(), EPHEMERA_INTEGRATION_KEY: 'short-key' });
    expect(short.find((issue) => issue.var === 'EPHEMERA_INTEGRATION_KEY')?.message).toContain('32');
  });

  test('a card timeout within 60 s of the SWAG read timeout is refused', () => {
    expect(issuesOf({ ...ephemeraEnv(), EPHEMERA_CARD_TIMEOUT_MS: '540001' }).map((issue) => issue.var))
      .toContain('EPHEMERA_CARD_TIMEOUT_MS');
    expect(loadConfig({ ...ephemeraEnv(), EPHEMERA_CARD_TIMEOUT_MS: '540000' }).EPHEMERA_CARD_TIMEOUT_MS).toBe(540_000);
  });
});
