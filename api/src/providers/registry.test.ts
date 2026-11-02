import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createKeyStore } from '../keystore';
import { importMasterKey } from '../crypto/aes-gcm';
import { importHmacKey } from '../crypto/fingerprint';
import { migrate } from '../db/migrate';
import { testConfig, tempDir } from '../test/helpers';
import { capsForPool, findModel, publicModelsForUser, registryForConfig } from './registry';

const HEX = 'a'.repeat(64);

async function setup() {
  const dataDir = tempDir();
  const db = new Database(':memory:');
  migrate(db, dataDir);
  db.run(`INSERT INTO users (id, created_at) VALUES ('alice', 1)`);
  const keyStore = createKeyStore({
    db,
    masterAesKey: await importMasterKey(HEX),
    masterHmacKey: await importHmacKey(HEX),
  });
  return {
    config: testConfig({ DATA_DIR: dataDir, LOCAL_MODELS_USERS: 'alice' }),
    keyStore,
  };
}

describe('publicModelsForUser', () => {
  test('Gemini models carry requiresKey when user has no Google key', async () => {
    const { config, keyStore } = await setup();

    const models = await publicModelsForUser(config, { userId: 'alice', keyStore });

    const gemini = models.find((model) => model.id === 'gemini-3-pro-image-preview');
    expect(gemini?.requiresKey).toEqual({ provider: 'google' });
  });

  test('Gemini models drop requiresKey when user has a Google key', async () => {
    const { config, keyStore } = await setup();
    await keyStore.put('alice', 'google', 'AIzaX');

    const models = await publicModelsForUser(config, { userId: 'alice', keyStore });

    const gemini = models.find((model) => model.id === 'gemini-3-pro-image-preview');
    expect(gemini?.requiresKey).toBeUndefined();
  });

  test('availability snapshot is merged into matching model only', async () => {
    const { config, keyStore } = await setup();
    const availability = new Map([
      ['krea-2-gonzalomo', { ok: false as const, checkedAt: 1_700_000_000_000, reason: 'unavailable' as const }],
    ]);

    const models = await publicModelsForUser(config, { userId: 'alice', keyStore, availability });

    const comfy = models.find((model) => model.id === 'krea-2-gonzalomo');
    expect(comfy?.availability).toEqual({ ok: false, checkedAt: 1_700_000_000_000, reason: 'unavailable' });
    const gpt = models.find((model) => model.id === 'gpt-image-2.5-sunburst');
    expect(gpt?.availability).toBeUndefined();
  });

  test('availability merge does not mutate cached registry entries', async () => {
    const { config, keyStore } = await setup();
    const availability = new Map([
      ['krea-2-gonzalomo', { ok: false as const, checkedAt: 1_700_000_000_000, reason: 'unavailable' as const }],
    ]);

    await publicModelsForUser(config, { userId: 'alice', keyStore, availability });
    // Second call without availability MUST see the comfy entry as untouched —
    // the registry cache is shared across requests and a previous request's
    // snapshot must not leak forward.
    const second = await publicModelsForUser(config, { userId: 'alice', keyStore });
    const comfy = second.find((model) => model.id === 'krea-2-gonzalomo');
    expect(comfy?.availability).toBeUndefined();
  });

  test('CLIProxy gpt-image-2.5-sunburst never carries requiresKey', async () => {
    const { config, keyStore } = await setup();

    const models = await publicModelsForUser(config, { userId: 'alice', keyStore });

    const gpt = models.find((model) => model.id === 'gpt-image-2.5-sunburst');
    expect(gpt?.name).toBe('GPT Image 2.5 Sunburst');
    expect(models.some((model) => model.id === 'gpt-image-2')).toBe(false);
    expect(gpt?.requiresKey).toBeUndefined();
  });

  test('catalog models expose their preferred default ratios', async () => {
    const { config, keyStore } = await setup();

    const models = await publicModelsForUser(config, { userId: 'alice', keyStore });

    expect(models.find((model) => model.id === 'gpt-image-2.5-sunburst')?.defaultRatio).toBe('4:5');

    const gemini = models.filter((model) => model.id.startsWith('gemini-'));
    expect(gemini).toHaveLength(3);
    for (const model of gemini) expect(model.defaultRatio).toBe('3:4');

    expect(models.find((model) => model.id === 'krea-2-gonzalomo')?.defaultRatio).toBe('3:4');
    expect(models.find((model) => model.id === 'moss-image-sft')?.defaultRatio).toBe('3:4');
  });

  test('reference-image caps: gpt-image-2.5-sunburst = 4, all Gemini models = 10', async () => {
    const { config, keyStore } = await setup();

    const models = await publicModelsForUser(config, { userId: 'alice', keyStore });

    const gpt = models.find((m) => m.id === 'gpt-image-2.5-sunburst');
    expect(gpt?.supportsReferenceImages).toBe(true);
    expect(gpt?.maxRefImages).toBe(4);

    const pro = models.find((m) => m.id === 'gemini-3-pro-image-preview');
    expect(pro?.supportsReferenceImages).toBe(true);
    expect(pro?.maxRefImages).toBe(10);

    const flash = models.find((m) => m.id === 'gemini-3.1-flash-image-preview');
    expect(flash?.supportsReferenceImages).toBe(true);
    expect(flash?.maxRefImages).toBe(10);

    const lite = models.find((m) => m.id === 'gemini-3.1-flash-lite-image');
    expect(lite?.supportsReferenceImages).toBe(true);
    expect(lite?.maxRefImages).toBe(10);
  });

  test('Nano Banana 2 Lite is registered with fast latency and requiresKey gating', async () => {
    const { config, keyStore } = await setup();

    const models = await publicModelsForUser(config, { userId: 'alice', keyStore });

    const lite = models.find((m) => m.id === 'gemini-3.1-flash-lite-image');
    expect(lite?.name).toBe('Nano Banana 2 Lite');
    expect(lite?.latency).toBe('fast');
    expect(lite?.requiresKey).toEqual({ provider: 'google' });
  });
});

describe('RegistryEntry.bind', () => {
  test('non-BYOK entries return the same provider instance every call', async () => {
    const { config } = await setup();
    const entry = findModel('gpt-image-2.5-sunburst', config);
    if (!entry) throw new Error('expected gpt-image-2.5-sunburst to be registered');
    const a = entry.bind({});
    const b = entry.bind({ keyPlaintext: 'ignored' });
    expect(a).toBe(b);
    expect(a.id).toBe('gpt-image-2.5-sunburst');
    expect(a.backend).toBe('cloud');
  });

  test('BYOK Gemini entry constructs a fresh provider scoped to keyPlaintext', async () => {
    const { config } = await setup();
    const entry = findModel('gemini-3-pro-image-preview', config);
    if (!entry) throw new Error('expected Gemini entry to be registered');
    const a = entry.bind({ keyPlaintext: 'AIzaA' });
    const b = entry.bind({ keyPlaintext: 'AIzaB' });
    // Distinct instances — closure-captures the per-request key, never
    // reused across users.
    expect(a).not.toBe(b);
    expect(a.id).toBe('gemini-3-pro-image-preview');
    expect(a.backend).toBe('cloud');
  });

  test('BYOK bind without keyPlaintext throws (sentinel guard)', async () => {
    const { config } = await setup();
    const entry = findModel('gemini-3-pro-image-preview', config);
    if (!entry) throw new Error('expected Gemini entry to be registered');
    expect(() => entry.bind({})).toThrow(/keyPlaintext/);
  });
});

describe('capsForPool', () => {
  test('shared pool returns both global and per-user caps', async () => {
    const { config } = await setup();
    const caps = capsForPool(config, 'shared');
    expect(caps.globalCap).toBe(config.MAX_CONCURRENT_TILES);
    expect(caps.perUserCap).toBe(config.MAX_CONCURRENT_TILES_PER_USER);
  });

  test('BYOK pool has per-user cap only, no global', async () => {
    const { config } = await setup();
    const caps = capsForPool(config, 'byok');
    expect(caps.globalCap).toBeNull();
    expect(caps.perUserCap).toBe(config.MAX_CONCURRENT_TILES_PER_USER_BYOK);
  });

  test('local pool reports its single cap in both fields', async () => {
    const { config } = await setup();
    const caps = capsForPool(config, 'local');
    expect(caps.globalCap).toBe(config.MAX_CONCURRENT_TILES_LOCAL);
    expect(caps.perUserCap).toBe(config.MAX_CONCURRENT_TILES_LOCAL);
  });
});

describe('Model.concurrencyCapPerUser matches capsForPool', () => {
  test('wire-side concurrencyCapPerUser equals capsForPool.perUserCap for every model', async () => {
    const { config } = await setup();
    for (const entry of registryForConfig(config)) {
      expect(entry.model.concurrencyCapPerUser).toBe(capsForPool(config, entry.model.pool).perUserCap);
    }
  });

  test('wire-side maxCountPerBatch is derived from min global and per-user pool caps', () => {
    const config = testConfig({
      MAX_CONCURRENT_TILES: '4',
      MAX_CONCURRENT_TILES_PER_USER: '4',
      MAX_CONCURRENT_TILES_LOCAL: '1',
      MAX_CONCURRENT_TILES_PER_USER_BYOK: '8',
    });

    const entries = registryForConfig(config);
    expect(entries.find((entry) => entry.model.id === 'gpt-image-2.5-sunburst')?.model.maxCountPerBatch).toBe(4);
    // Local batched models use COMFYUI_BATCH_MAX (default 4), not the
    // concurrency cap — a batch_size=N job occupies a single semaphore slot.
    expect(entries.find((entry) => entry.model.id === 'krea-2-gonzalomo')?.model.maxCountPerBatch).toBe(4);
  });

  test('wire-side maxCountPerBatch respects COMFYUI_BATCH_MAX override', () => {
    const config = testConfig({ COMFYUI_BATCH_MAX: '2' });
    const entries = registryForConfig(config);
    expect(entries.find((entry) => entry.model.id === 'krea-2-gonzalomo')?.model.maxCountPerBatch).toBe(2);
  });
});

describe('Krea models are registered with correct fields', () => {
  test('every Krea row publishes one reference image; video rows never do', async () => {
    const { keyStore } = await setup();
    const config = testConfig({ LOCAL_MODELS_USERS: 'alice', VIDEO_MODELS_ENABLED: 'true' });
    const models = await publicModelsForUser(config, { userId: 'alice', keyStore });
    const krea = models.filter((model) => model.id.startsWith('krea-2-'));
    expect(krea).toHaveLength(1);
    for (const model of krea) {
      expect(model.supportsReferenceImages).toBe(true);
      expect(model.maxRefImages).toBe(1);
      expect(model.tag).toBe('comfyui');
    }
    const video = models.filter((model) => model.id.startsWith('minimax-h3-'));
    expect(video).toHaveLength(2);
    for (const model of video) {
      expect(model).not.toHaveProperty('supportsReferenceImages');
      expect(model).not.toHaveProperty('maxRefImages');
    }
  });

  test('unset COMFYUI_BASE_URL registers no local rows', () => {
    const config = testConfig({ COMFYUI_BASE_URL: undefined, VIDEO_MODELS_ENABLED: 'false' });
    expect(registryForConfig(config).filter((entry) => entry.model.pool === 'local')).toEqual([]);
  });

  test('all Krea models have batched/defaultCount/pool', () => {
    const config = testConfig({ COMFYUI_BASE_URL: 'https://comfyui.example.internal:7860' });
    const entries = registryForConfig(config);
    const krea = entries.filter((entry) => entry.model.id.startsWith('krea-2-'));
    expect(krea.map((entry) => entry.model.id)).toEqual([
      'krea-2-gonzalomo',
    ]);
    for (const { model } of krea) {
      expect(model.pool).toBe('local');
      expect(model.batched).toBe(true);
      expect(model.defaultCount).toBe(4);
    }
  });

  test('promptFormat is absent on Krea models', () => {
    const entries = registryForConfig(testConfig());
    const krea = entries.find((e) => e.model.id === 'krea-2-gonzalomo');
    expect(krea?.model.promptFormat).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(krea?.model ?? {}, 'promptFormat')).toBe(false);
  });

  test('all Krea models honor COMFYUI_BATCH_MAX for maxCountPerBatch', () => {
    const config = testConfig({
      COMFYUI_BATCH_MAX: '2',
      COMFYUI_BASE_URL: 'https://comfyui.example.internal:7860',
    });
    const entries = registryForConfig(config);
    for (const entry of entries.filter((candidate) => candidate.model.id.startsWith('krea-2-'))) {
      expect(entry.model.maxCountPerBatch).toBe(2);
    }
  });
});

describe('MOSS Image is registered as a local image row outside the Krea family', () => {
  test('moss-image-sft publishes batched local fields and no reference image', async () => {
    const { keyStore } = await setup();
    const config = testConfig({ LOCAL_MODELS_USERS: 'alice' });
    const models = await publicModelsForUser(config, { userId: 'alice', keyStore });
    const moss = models.find((model) => model.id === 'moss-image-sft');
    expect(moss).toBeDefined();
    expect(moss?.name).toBe('MOSS Image');
    expect(moss?.pool).toBe('local');
    expect(moss?.tag).toBe('comfyui');
    expect(moss?.batched).toBe(true);
    expect(moss?.defaultCount).toBe(4);
    expect(moss?.defaultRatio).toBe('3:4');
    expect(moss).not.toHaveProperty('supportsReferenceImages');
    expect(moss).not.toHaveProperty('maxRefImages');
    expect(moss?.outputsVideo).toBeUndefined();
  });

  test('moss-image-sft is gated by LOCAL_MODELS_USERS', async () => {
    const config = testConfig({ LOCAL_MODELS_USERS: 'alice' });
    const models = await publicModelsForUser(config, { userId: 'bob', keyStore: undefined });
    expect(models.find((model) => model.id === 'moss-image-sft')).toBeUndefined();
  });

  test('moss-image-sft honors COMFYUI_BATCH_MAX and has no promptFormat', () => {
    const config = testConfig({ COMFYUI_BATCH_MAX: '2', COMFYUI_BASE_URL: 'https://comfyui.example.internal:7860' });
    const entry = registryForConfig(config).find((candidate) => candidate.model.id === 'moss-image-sft');
    expect(entry?.model.maxCountPerBatch).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(entry?.model ?? {}, 'promptFormat')).toBe(false);
  });
});

describe('MiniMax H3 I2V video model gate', () => {
  test('the disabled H3 templates register only when listed in COMFYUI_ENABLE_MODELS', () => {
    const ids = (enable: string) => registryForConfig(testConfig({ VIDEO_MODELS_ENABLED: 'true', COMFYUI_ENABLE_MODELS: enable }))
      .map((entry) => entry.model.id)
      .filter((id) => id.startsWith('minimax-h3-'));
    expect(ids('')).toEqual([]);
    expect(ids('minimax-h3-t2v')).toEqual(['minimax-h3-t2v']);
    expect(ids('minimax-h3-i2v,minimax-h3-t2v')).toEqual(['minimax-h3-i2v', 'minimax-h3-t2v']);
  });

  test('VIDEO_MODELS_ENABLED=false omits minimax-h3-i2v from public models', async () => {
    const config = testConfig({ VIDEO_MODELS_ENABLED: 'false' });
    const models = await publicModelsForUser(config, { userId: 'alice', keyStore: undefined });

    expect(models.find((model) => model.id === 'minimax-h3-i2v')).toBeUndefined();
  });

  test('VIDEO_MODELS_ENABLED=true includes minimax-h3-i2v with I2V singleton fields', async () => {
    const config = testConfig({ COMFYUI_BASE_URL: 'http://127.0.0.1:1', VIDEO_MODELS_ENABLED: 'true', LOCAL_MODELS_USERS: 'alice' });
    const models = await publicModelsForUser(config, { userId: 'alice', keyStore: undefined });

    const h3 = models.find((model) => model.id === 'minimax-h3-i2v');
    expect(h3).toBeDefined();
    expect(h3?.supportsI2V).toBe(true);
    expect(h3?.outputsVideo).toBe(true);
    expect(h3?.pool).toBe('local');
    expect(h3?.batched).toBe(false);
    expect(h3?.defaultCount).toBe(1);
    expect(h3?.maxCountPerBatch).toBe(1);
  });

  test('VIDEO_MODELS_ENABLED=true includes minimax-h3-t2v as video WITHOUT the i2v source requirement', async () => {
    const config = testConfig({ COMFYUI_BASE_URL: 'http://127.0.0.1:1', VIDEO_MODELS_ENABLED: 'true', LOCAL_MODELS_USERS: 'alice' });
    const models = await publicModelsForUser(config, { userId: 'alice', keyStore: undefined });

    const t2v = models.find((model) => model.id === 'minimax-h3-t2v');
    expect(t2v).toBeDefined();
    expect(t2v?.outputsVideo).toBe(true);
    expect(t2v?.supportsI2V).toBeUndefined();
    expect(t2v?.promptFormat).toBeUndefined();
    expect(t2v?.maxCountPerBatch).toBe(1);
  });

  test('VIDEO_MODELS_ENABLED=false omits minimax-h3-t2v too', async () => {
    const config = testConfig({ VIDEO_MODELS_ENABLED: 'false' });
    const models = await publicModelsForUser(config, { userId: 'alice', keyStore: undefined });
    expect(models.find((model) => model.id === 'minimax-h3-t2v')).toBeUndefined();
  });
});

describe('resilient decorator wiring', () => {
  test('gpt-image-2.5-sunburst is wrapped in a resilient decorator', () => {
    const config = testConfig();
    const reg = registryForConfig(config);

    const gpt = reg.find((e) => e.model.id === 'gpt-image-2.5-sunburst');
    expect(gpt).toBeDefined();
    // id is preserved through the decorator:
    expect(gpt?.bind({}).id).toBe('gpt-image-2.5-sunburst');
  });

  test('gpt-image-2.5-sunburst bind() returns the same instance on repeated calls (staticBind preserved)', () => {
    const config = testConfig();
    const entry = registryForConfig(config).find((e) => e.model.id === 'gpt-image-2.5-sunburst');
    if (!entry) throw new Error('expected gpt-image-2.5-sunburst to be registered');
    const a = entry.bind({});
    const b = entry.bind({ keyPlaintext: 'ignored' });
    // staticBind wraps the resilient provider — always the same wrapper instance:
    expect(a).toBe(b);
    expect(a.id).toBe('gpt-image-2.5-sunburst');
  });

  test('policy is per-Config, not module-global (two configs yield independent policy instances)', () => {
    const c1 = testConfig();
    const c2 = testConfig();
    // registryForConfig memoizes per Config reference; two distinct Configs
    // must produce two distinct provider instances (separate breaker state).
    const p1 = registryForConfig(c1).find((e) => e.model.id === 'gpt-image-2.5-sunburst')?.bind({});
    const p2 = registryForConfig(c2).find((e) => e.model.id === 'gpt-image-2.5-sunburst')?.bind({});
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p1).not.toBe(p2);
  });
});

describe('RegistryEntry.timeoutMs by pool/kind', () => {
  const TIMEOUTS = { cloud: 300_000, local: 600_000, localVideo: 1_200_000 };

  test('video (I2V) entries use the longer localVideo timeout', () => {
    const config = testConfig({ COMFYUI_BASE_URL: 'http://127.0.0.1:1', VIDEO_MODELS_ENABLED: 'true' });
    const h3 = registryForConfig(config).find((e) => e.model.id === 'minimax-h3-i2v');
    expect(h3).toBeDefined();
    expect(h3?.timeoutMs(TIMEOUTS)).toBe(TIMEOUTS.localVideo);
  });

  test('image local entries use the standard local timeout', () => {
    const config = testConfig({});
    const krea = registryForConfig(config).find((e) => e.model.id === 'krea-2-gonzalomo');
    expect(krea?.timeoutMs(TIMEOUTS)).toBe(TIMEOUTS.local);
  });
});
