import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate';
import { createTextProviderStore, type TextProviderStore } from '../db/textProviders';
import { createTextSecretsForKey } from '../keystore/instanceSecrets';
import { startTextAvailability, type TextAvailabilityHandle } from './text-availability';

// Spec § 9.1: one bounded poller per enabled listing provider, last good
// snapshot kept, empty = unknown, unknown fails open; reconciliation on config
// revision changes is owned by the service.

type Handler = (req: Request) => Response | Promise<Response>;

let server: ReturnType<typeof Bun.serve>;
let origin = '';
/** Path prefix ('/a') → handler for `${prefix}/v1/models`. */
const routes = new Map<string, Handler>();
const hits: { path: string; authorization: string | null }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push({ path, authorization: req.headers.get('authorization') });
      const handler = routes.get(path.replace(/\/v1\/models$/, ''));
      return handler ? handler(req) : new Response('not found', { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  void server.stop(true);
});

const handles: TextAvailabilityHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) {
    handle.stop();
    await handle.drain();
  }
  routes.clear();
  hits.length = 0;
});

function list(...ids: string[]): Handler {
  return () => Response.json({ data: ids.map((id) => ({ id })) });
}

/** Never answers until the client goes away; records the abort. */
function hanging(aborted: { count: number }): Handler {
  return (req) => new Promise<Response>((resolve) => {
    req.signal.addEventListener('abort', () => {
      aborted.count += 1;
      resolve(new Response('gone', { status: 499 }));
    }, { once: true });
  });
}

interface Logged {
  readonly providerId?: unknown;
  readonly inventoryCode?: unknown;
  readonly status?: unknown;
}

function setup(): { store: TextProviderStore; logs: Logged[]; start: () => TextAvailabilityHandle } {
  const db = new Database(':memory:');
  migrate(db, mkdtempSync(join(tmpdir(), 'atelier-text-availability-')));
  const secrets = createTextSecretsForKey('f'.repeat(64));
  if (secrets === undefined) throw new Error('no secrets');
  const store = createTextProviderStore({ db, secrets });
  const logs: Logged[] = [];
  const logger = { info: () => undefined, warn: (fields: Logged) => { logs.push(fields); } };
  return {
    store,
    logs,
    start: () => {
      const handle = startTextAvailability({ store, logger, intervalMs: 60_000, timeoutMs: 5_000 });
      handles.push(handle);
      return handle;
    },
  };
}

async function addProvider(store: TextProviderStore, prefix: string, options: { listModels?: boolean; apiKey?: string } = {}) {
  return store.createProvider({
    name: `P${prefix}`,
    protocol: 'openai-compatible',
    baseUrl: `${origin}${prefix}/v1`,
    ...(options.listModels === undefined ? {} : { listModels: options.listModels }),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
  });
}

describe('text availability poller', () => {
  test('listed models are available, unlisted ones offline, unknown before the first list', async () => {
    const { store, start } = setup();
    routes.set('/a', list('m1'));
    const provider = await addProvider(store, '/a');
    const handle = start();
    expect(handle.statusOf({ providerId: provider.id, modelId: 'm1' })).toBe('unknown');
    await handle.refresh(provider.id);
    expect(handle.statusOf({ providerId: provider.id, modelId: 'm1' })).toBe('available');
    expect(handle.statusOf({ providerId: provider.id, modelId: 'm2' })).toBe('offline');
  });

  test('an empty list keeps the last snapshot', async () => {
    const { store, logs, start } = setup();
    routes.set('/a', list('m1'));
    const provider = await addProvider(store, '/a');
    const handle = start();
    await handle.refresh(provider.id);
    routes.set('/a', list());
    await handle.refresh(provider.id);
    expect(handle.statusOf({ providerId: provider.id, modelId: 'm1' })).toBe('available');
    expect(logs.map((l) => l.inventoryCode)).toContain('empty_inventory');
  });

  test('an empty first list stays unknown (fails open)', async () => {
    const { store, start } = setup();
    routes.set('/a', list());
    const provider = await addProvider(store, '/a');
    const handle = start();
    await handle.refresh(provider.id);
    expect(handle.statusOf({ providerId: provider.id, modelId: 'anything' })).toBe('unknown');
  });

  test('a failed list keeps the last snapshot and logs only a code and status', async () => {
    const { store, logs, start } = setup();
    routes.set('/a', list('m1'));
    const provider = await addProvider(store, '/a', { apiKey: 'sk-secret-key' });
    const handle = start();
    await handle.refresh(provider.id);
    routes.set('/a', () => new Response('sk-secret-key leaked', { status: 500 }));
    await handle.refresh(provider.id);
    expect(handle.statusOf({ providerId: provider.id, modelId: 'm1' })).toBe('available');
    expect(logs).toContainEqual({ providerId: provider.id, inventoryCode: 'http_status', status: 500 });
    expect(JSON.stringify(logs)).not.toContain('sk-secret-key');
    expect(hits.at(-1)?.authorization).toBe('Bearer sk-secret-key');
  });

  test('a body over 1 MiB is invalid_body and keeps the snapshot', async () => {
    const { store, logs, start } = setup();
    routes.set('/a', list('m1'));
    const provider = await addProvider(store, '/a');
    const handle = start();
    await handle.refresh(provider.id);
    routes.set('/a', () => new Response(JSON.stringify({ data: [{ id: 'x'.repeat(1024 * 1024) }] })));
    await handle.refresh(provider.id);
    expect(logs.map((l) => l.inventoryCode)).toContain('invalid_body');
    expect(handle.statusOf({ providerId: provider.id, modelId: 'm1' })).toBe('available');
  });

  test('a poll past the timeout is abandoned as timeout', async () => {
    const { store, logs } = setup();
    const aborted = { count: 0 };
    routes.set('/a', hanging(aborted));
    const provider = await addProvider(store, '/a');
    const handle = startTextAvailability({
      store,
      logger: { info: () => undefined, warn: (fields: Logged) => { logs.push(fields); } },
      intervalMs: 60_000,
      timeoutMs: 30,
    });
    handles.push(handle);
    await handle.refresh(provider.id);
    expect(logs.map((l) => l.inventoryCode)).toContain('timeout');
    expect(handle.statusOf({ providerId: provider.id, modelId: 'm1' })).toBe('unknown');
  });

  test('a provider with listing off has no poller and reports unknown', async () => {
    const { store, start } = setup();
    routes.set('/a', list('m1'));
    const provider = await addProvider(store, '/a', { listModels: false });
    const handle = start();
    await handle.refresh(provider.id);
    expect(hits).toHaveLength(0);
    expect(handle.statusOf({ providerId: provider.id, modelId: 'm1' })).toBe('unknown');
  });

  test('stop aborts the poll in flight and drain waits for it', async () => {
    const { store, start } = setup();
    const aborted = { count: 0 };
    routes.set('/a', hanging(aborted));
    await addProvider(store, '/a');
    const handle = start();
    while (hits.length === 0) await Bun.sleep(1);
    handle.stop();
    await handle.drain();
    while (aborted.count === 0) await Bun.sleep(1);
    expect(aborted.count).toBe(1);
  });
});

describe('reconciliation on config revision change', () => {
  test('a new enabled provider gets a poller', async () => {
    const { store, start } = setup();
    const handle = start();
    routes.set('/b', list('m2'));
    const provider = await addProvider(store, '/b');
    await handle.refresh(provider.id);
    expect(handle.statusOf({ providerId: provider.id, modelId: 'm2' })).toBe('available');
  });

  test('disabling, turning listing off or deleting stops the poller and forgets its snapshot', async () => {
    const { store, start } = setup();
    routes.set('/a', list('m1'));
    routes.set('/b', list('m1'));
    routes.set('/c', list('m1'));
    const a = await addProvider(store, '/a');
    const b = await addProvider(store, '/b');
    const c = await addProvider(store, '/c');
    const handle = start();
    await Promise.all([handle.refresh(a.id), handle.refresh(b.id), handle.refresh(c.id)]);
    await store.updateProvider(a.id, { enabled: false });
    await store.updateProvider(b.id, { listModels: false });
    store.deleteProvider(c.id);
    for (const id of [a.id, b.id, c.id]) {
      expect(handle.statusOf({ providerId: id, modelId: 'm1' })).toBe('unknown');
    }
    const before = hits.length;
    await Promise.all([handle.refresh(a.id), handle.refresh(b.id), handle.refresh(c.id)]);
    expect(hits).toHaveLength(before);
  });

  test('a base URL change restarts the poller and aborts the poll in flight', async () => {
    const { store, start } = setup();
    const aborted = { count: 0 };
    routes.set('/a', hanging(aborted));
    routes.set('/b', list('moved'));
    const provider = await addProvider(store, '/a');
    const handle = start();
    while (hits.length === 0) await Bun.sleep(1);
    await store.updateProvider(provider.id, { baseUrl: `${origin}/b/v1` });
    await handle.refresh(provider.id);
    expect(handle.statusOf({ providerId: provider.id, modelId: 'moved' })).toBe('available');
    while (aborted.count === 0) await Bun.sleep(1);
    expect(aborted.count).toBe(1);
  });

  test('a credential change restarts the poller with the new key', async () => {
    const { store, start } = setup();
    routes.set('/a', list('m1'));
    const provider = await addProvider(store, '/a', { apiKey: 'sk-old-key' });
    const handle = start();
    await handle.refresh(provider.id);
    expect(hits.at(-1)?.authorization).toBe('Bearer sk-old-key');
    routes.set('/a', list('m2'));
    await store.updateProvider(provider.id, { apiKey: 'sk-new-key' });
    // The restarted poller starts over: unknown until its first list lands.
    expect(handle.statusOf({ providerId: provider.id, modelId: 'm1' })).toBe('unknown');
    await handle.refresh(provider.id);
    expect(hits.at(-1)?.authorization).toBe('Bearer sk-new-key');
    expect(handle.statusOf({ providerId: provider.id, modelId: 'm2' })).toBe('available');
  });

  test('an unrelated edit keeps the poller and its snapshot', async () => {
    const { store, start } = setup();
    routes.set('/a', list('m1'));
    const provider = await addProvider(store, '/a');
    const handle = start();
    await handle.refresh(provider.id);
    await store.updateProvider(provider.id, { name: 'Renamed' });
    expect(handle.statusOf({ providerId: provider.id, modelId: 'm1' })).toBe('available');
  });
});
