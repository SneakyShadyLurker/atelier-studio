import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import pino from 'pino';
import { loadConfig, type Config } from '../config';
import type { ModelAvailability } from '@atelier/shared';
import { createApp, createKeyStoreForConfig } from '../server';
import { openDb } from '../db/client';
import { migrate, seedLegacyTextProvider } from '../db/migrate';
import { bumpTextConfigRevision } from '../db/textProviders';
import { legacyTextSeed } from '../db/textSeed';
import type { TextAvailabilityHandle } from '../lifecycle/text-availability';
import { registryForConfig } from '../providers/registry';
import { UNKNOWN_TEXT_AVAILABILITY } from '../routing/textServices';
import { resetConcurrencyForTests } from '../orchestrator/concurrency';
import { resetKeyProbeRuntimeForTests } from '../routes/keys';
import { resetUploadsRuntimeForTests } from '../routes/uploads-runtime';
import { storageKeyring } from '../storage/crypto';

// Captured at first import of this module — which happens before any test
// (hence any fetch mock) runs, so this is the genuinely pristine fetch.
const originalFetch = globalThis.fetch;

// The module-scope afterEach below only binds to whichever file first imports
// helpers (bun evaluates this module once). Fetch-sensitive suites that drive
// the real provider against local servers must call this in their OWN
// before/afterEach to be immune to a sibling suite that mocks globalThis.fetch
// without restoring it (e.g. routes/keys.test.ts).
export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetConcurrencyForTests();
  resetKeyProbeRuntimeForTests();
  resetUploadsRuntimeForTests();
});

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'atelier-api-test-'));
}

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({
    BYOK_ENCRYPTION_KEY: 'a'.repeat(64),
    CLIPROXY_BASE_URL: 'http://127.0.0.1:1',
    CLIPROXY_TOKEN: 'stub',
    COMFYUI_BASE_URL: 'http://127.0.0.1:1',
    // The bundled H3 rows are disabled templates; the video suites need them.
    COMFYUI_ENABLE_MODELS: 'minimax-h3-i2v,minimax-h3-t2v',
    DATA_DIR: tempDir(),
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

/**
 * Seeds the migrated CLIProxyAPI text provider, its seven legacy-keyed models,
 * the Kimi default and the GPT prompt writers (spec § 11.1), as migration 58
 * does on an upgrade. Model ids come from `config`'s `CLIPROXY_TEXT_MODEL_*`.
 */
export function seedLegacyTextConfig(db: Database, config: Config = testConfig()): void {
  const seed = legacyTextSeed(config, registryForConfig(config).map((entry) => entry.model.id));
  if (!seed) throw new Error('seedLegacyTextConfig needs CLIPROXY_BASE_URL');
  seedLegacyTextProvider(db, seed);
  bumpTextConfigRevision();
}

/** Text availability that lists exactly `listed` upstream model ids on every provider. */
export function listedTextAvailability(listed: ReadonlySet<string>): TextAvailabilityHandle {
  return {
    ...UNKNOWN_TEXT_AVAILABILITY,
    statusOf: (model) => (listed.has(model.modelId) ? 'available' : 'offline'),
    snapshot: () => listed,
  };
}

export function testRuntime(overrides: Record<string, unknown> = {}) {
  const {
    disableByok, availability, textModels, textAvailability, seedLegacyText, ...rawEnvOverrides
  } = overrides;
  const envOverrides = rawEnvOverrides as Partial<NodeJS.ProcessEnv>;
  const config = testConfig(
    disableByok === true ? { ...envOverrides, BYOK_ENCRYPTION_KEY: undefined } : envOverrides,
  );
  const db = openDb({ dataDir: config.DATA_DIR });
  migrate(db, config.DATA_DIR);
  if (seedLegacyText === true) seedLegacyTextConfig(db, config);
  const logs: string[] = [];
  const logger = pino({ level: config.LOG_LEVEL }, { write: (line) => logs.push(line) });
  const keyStore = createKeyStoreForConfig(config, db);
  // Tests inject a pre-populated availability snapshot to exercise the offline
  // guard without standing up a real probe + listening host.
  const snapshot = availability instanceof Map
    ? (availability as ReadonlyMap<string, ModelAvailability>)
    : new Map<string, ModelAvailability>();
  const healthProbe = {
    snapshot: () => snapshot,
    probeNow: () => Promise.resolve(undefined),
    stop: () => undefined,
    drain: () => Promise.resolve(),
  };
  // Tests inject a CLIProxy `/v1/models` id set to exercise text-backend
  // availability; absent means the inventory is unknown (fail-open).
  const modelInventory = textModels instanceof Set
    ? {
        snapshot: () => textModels as ReadonlySet<string>,
        stop: () => undefined,
        drain: () => Promise.resolve(),
      }
    : undefined;
  // Text-model availability: an explicit fake wins; a `textModels` id set
  // doubles as the listing of every text provider; absent = unknown.
  const textAvailabilityHandle = textAvailability !== undefined
    ? textAvailability as TextAvailabilityHandle
    : textModels instanceof Set ? listedTextAvailability(textModels as ReadonlySet<string>) : undefined;
  const app = createApp({
    config,
    db,
    logger,
    keyStore,
    healthProbe,
    ...(modelInventory ? { modelInventory } : {}),
    ...(textAvailabilityHandle ? { textAvailability: textAvailabilityHandle } : {}),
  });
  return {
    app,
    config,
    db,
    logger,
    keyStore,
    logs,
    fetch(path: string, init?: RequestInit): Promise<Response> {
      return Promise.resolve(app.fetch(new Request(`http://local${path}`, init)));
    },
    async seedKey(userId: string, provider: 'google', key: string): Promise<void> {
      if (!keyStore) throw new Error('expected keyStore in test runtime');
      db.run(`INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)`, [userId, Date.now()]);
      await keyStore.put(userId, provider, key);
    },
    armGoogleResponse(response: Response): void {
      globalThis.fetch = ((input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const seenKey = new Headers(init?.headers).get('x-goog-api-key');
        if (url.pathname !== '/v1beta/models' || url.searchParams.get('pageSize') !== '1') {
          return Promise.resolve(new Response('unexpected google probe url', { status: 599 }));
        }
        if (!seenKey) {
          return Promise.resolve(new Response('missing google key header', { status: 599 }));
        }
        return Promise.resolve(response);
      }) as typeof fetch;
    },
  };
}

export async function jsonRequest(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  userId = 'test',
  accept = 'application/json',
): Promise<Response> {
  return app.fetch(
    new Request(`http://local${path}`, {
      method: 'POST',
      headers: { Accept: accept, 'Content-Type': 'application/json', 'Remote-User': userId },
      body: JSON.stringify(body),
    }),
  );
}

export async function parseSse(response: Response): Promise<{ event: string; data: unknown }[]> {
  const text = await response.text();
  return parseSseText(text);
}

export async function generateEvents(
  app: ReturnType<typeof createApp>,
  body: unknown,
  userId = 'test',
): Promise<{ event: string; data: unknown }[]> {
  const { batchId } = await submitGenerate(app, body, userId);
  const events = await openBatchEvents(app, batchId, userId);
  return parseSse(events);
}

export async function submitGenerate(
  app: ReturnType<typeof createApp>,
  body: unknown,
  userId = 'test',
): Promise<{ batchId: string; response: Response; payload: Record<string, unknown> }> {
  const submitted = await jsonRequest(app, '/api/generate', body, userId, 'application/json');
  if (!submitted.ok) {
    throw new Error(`generate failed: ${submitted.status} ${await submitted.text()}`);
  }
  const payload = await submitted.json() as Record<string, unknown> & { batchId?: unknown };
  if (typeof payload.batchId !== 'string') throw new Error('generate response missing batchId');
  return { batchId: payload.batchId, response: submitted, payload };
}

export function openBatchEvents(
  app: ReturnType<typeof createApp>,
  batchId: string,
  userId = 'test',
): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`http://local/api/batches/${batchId}/events`, {
    headers: { 'Remote-User': userId },
  })));
}

// Extract the terminal `done` payload from a /infer SSE stream (or surface
// the `error` event as a thrown Error). Used by api tests after the route
// switched to streaming.
export async function parseInferDone<T = unknown>(response: Response): Promise<T> {
  const frames = await parseSse(response);
  const done = frames.find((frame) => frame.event === 'done');
  if (done) return done.data as T;
  const error = frames.find((frame) => frame.event === 'error');
  throw new Error(
    error ? `infer stream returned error: ${JSON.stringify(error.data)}` : 'infer stream produced no terminal event',
  );
}

export function parseSseText(text: string): { event: string; data: unknown }[] {
  return text
    .split('\n\n')
    .filter((frame) => frame.trim().length > 0 && !frame.startsWith(':'))
    .map((frame) => {
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (!event || !data) throw new Error(`bad SSE frame: ${frame}`);
      return { event, data: JSON.parse(data) as unknown };
    });
}

// Plaintext of an artifact file written through storage/files.ts, which
// stores every artifact age-encrypted to its owner.
export async function plaintextOf(userId: string, path: string): Promise<Uint8Array> {
  return (await storageKeyring()).decryptFileBytes(userId, Bun.file(path), AbortSignal.timeout(5_000));
}

// The rejection reason of `promise`; fails the test if it resolves instead.
export function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => { throw new Error('expected the promise to reject'); },
    (error: unknown) => error,
  );
}
