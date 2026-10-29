import { describe, expect, test } from 'bun:test';
import pino from 'pino';
import { startModelInventory, type ModelInventoryHandle } from './model-inventory';

const TOKEN = 'sk-inventory-secret-token';

function modelsBody(ids: readonly string[]): Response {
  return Response.json({
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created: 1, owned_by: 'cliproxy' })),
  });
}

function start(responses: (() => Response | Promise<Response>)[]): {
  inventory: ModelInventoryHandle;
  logs: string[];
  calls: { url: string; auth: string | null }[];
  refresh: () => Promise<void>;
} {
  const logs: string[] = [];
  const calls: { url: string; auth: string | null }[] = [];
  const queue = [...responses];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), auth: new Headers(init?.headers).get('authorization') });
    const next = queue.shift();
    if (!next) return Promise.reject(new Error('no scripted response'));
    return Promise.resolve(next());
  }) as typeof fetch;
  const inventory = startModelInventory({
    baseUrl: 'http://proxy.test/',
    token: TOKEN,
    logger: pino({ level: 'warn' }, { write: (line: string) => { logs.push(line); } }),
    intervalMs: 5,
    timeoutMs: 1_000,
    fetch: fetchImpl,
  });
  // Each refresh completes before the next interval fires; wait for the call
  // count to advance past the next scripted response.
  const refresh = async (): Promise<void> => {
    const target = calls.length + 1;
    while (calls.length < target) await Bun.sleep(1);
    await inventory.drain();
  };
  return { inventory, logs, calls, refresh };
}

describe('startModelInventory', () => {
  test('parses data[].id with the bearer token and tolerates extra fields', async () => {
    const { inventory, calls } = start([() => modelsBody(['kimi-latest', 'mimo-v2.6-pro'])]);
    await inventory.drain();
    inventory.stop();
    expect(calls[0]).toEqual({ url: 'http://proxy.test/v1/models', auth: `Bearer ${TOKEN}` });
    expect([...(inventory.snapshot() ?? [])]).toEqual(['kimi-latest', 'mimo-v2.6-pro']);
  });

  test('stays null until the first successful fetch', async () => {
    const { inventory, refresh } = start([
      () => new Response('nope', { status: 503 }),
      () => modelsBody(['kimi-latest']),
    ]);
    expect(inventory.snapshot()).toBeNull();
    await inventory.drain();
    expect(inventory.snapshot()).toBeNull();
    await refresh();
    inventory.stop();
    expect(inventory.snapshot()).toEqual(new Set(['kimi-latest']));
  });

  test('a failed refresh keeps the last good snapshot', async () => {
    const { inventory, refresh } = start([
      () => modelsBody(['kimi-latest']),
      () => new Response('upstream down', { status: 502 }),
      () => new Response('not json', { status: 200 }),
      () => Response.json({ data: [{ object: 'model' }] }),
    ]);
    await inventory.drain();
    await refresh();
    await refresh();
    await refresh();
    inventory.stop();
    expect(inventory.snapshot()).toEqual(new Set(['kimi-latest']));
  });

  test('an empty model list keeps the last good snapshot', async () => {
    const { inventory, refresh } = start([
      () => modelsBody(['kimi-latest']),
      () => modelsBody([]),
    ]);
    await inventory.drain();
    await refresh();
    inventory.stop();
    expect(inventory.snapshot()).toEqual(new Set(['kimi-latest']));
  });

  test('a fetch that outlives the timeout is aborted, logged and leaves the inventory unknown', async () => {
    const logs: string[] = [];
    const inventory = startModelInventory({
      baseUrl: 'http://proxy.test',
      token: TOKEN,
      logger: pino({ level: 'warn' }, { write: (line: string) => { logs.push(line); } }),
      intervalMs: 60_000,
      timeoutMs: 20,
      fetch: ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); });
      })) as typeof fetch,
    });
    await inventory.drain();
    inventory.stop();
    expect(inventory.snapshot()).toBeNull();
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ inventoryCode: 'timeout' });
  });

  test('failure logs carry a code and status, never the token or the raw body', async () => {
    const { inventory, logs, refresh } = start([
      () => new Response(`echo Bearer ${TOKEN}`, { status: 401 }),
      () => new Response(`{"data": "${TOKEN}"}`, { status: 200 }),
    ]);
    await inventory.drain();
    await refresh();
    inventory.stop();
    expect(logs).toHaveLength(2);
    const joined = logs.join('\n');
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain('echo');
    const first = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>;
    expect(first).toMatchObject({ inventoryCode: 'http_status', status: 401 });
    expect(JSON.parse(logs[1] ?? '{}')).toMatchObject({ inventoryCode: 'invalid_body', status: 200 });
  });
});
