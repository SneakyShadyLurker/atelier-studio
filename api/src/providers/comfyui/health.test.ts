import { afterEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { INVENTORY_REUSE_MS, createComfyuiHealthTransport } from './health';
import { createComfyuiProvider } from '../comfyui';
import { abortReason } from '../../lifecycle/abort';
import { currentWorkerPrivacy } from '../../test/private-worker-fixture';

const baseUrl = 'https://worker.test';
const privacy = { token: 'synthetic-token', ca: 'synthetic-ca' };
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); });

test('one registry host shares concurrent privacy/inventory reads but validates each model and refreshes next round', async () => {
  const calls: string[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    calls.push(path);
    return Promise.resolve(Response.json(path.endsWith('/privacy') ? currentWorkerPrivacy : {
      UNETLoader: { input: { required: { unet_name: [['present.safetensors']] } } },
    }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  const healthTransport = createComfyuiHealthTransport(baseUrl, privacy, 1024);
  const provider = (file: string) => createComfyuiProvider({
    baseUrl, privacy, healthTransport, workflowText: '{}', saveImageNodeId: '9',
    requiredPlaceholders: [], requiredModelFiles: [file], ratioDims: {}, modelId: file, maxResponseBytes: 1024,
  });
  const present = provider('present.safetensors');
  const absent = provider('missing.safetensors');
  if (!present.healthCheck || !absent.healthCheck) throw new Error('fixture providers require health checks');
  const result = await Promise.all([present.healthCheck(AbortSignal.timeout(2000)), absent.healthCheck(AbortSignal.timeout(2000))]);
  expect(result).toMatchObject([{ ok: true }, { ok: false, probeCode: 'missing_file' }]);
  expect(calls).toEqual(['/atelier/v1/privacy', '/object_info']);
  await present.healthCheck(AbortSignal.timeout(2000));
  expect(calls).toEqual(['/atelier/v1/privacy', '/object_info', '/atelier/v1/privacy', '/object_info']);
});

function inventoryHost() {
  const state: { bootId: string | undefined; ready: boolean; inventoryStatus: number; inventoryReads: number } = {
    bootId: undefined, ready: true, inventoryStatus: 200, inventoryReads: 0 };
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path.endsWith('/privacy')) {
      const body = state.bootId === undefined ? currentWorkerPrivacy : { ...currentWorkerPrivacy, boot_id: state.bootId };
      return Promise.resolve(Response.json({ ...body, ready: state.ready }));
    }
    state.inventoryReads += 1;
    if (state.inventoryStatus !== 200) return Promise.resolve(new Response(null, { status: state.inventoryStatus }));
    return Promise.resolve(Response.json({ UNETLoader: { input: { required: { unet_name: [['present.safetensors']] } } } }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); setSystemTime(); };
  const healthTransport = createComfyuiHealthTransport(baseUrl, privacy, 1024);
  const provider = createComfyuiProvider({
    baseUrl, privacy, healthTransport, workflowText: '{}', saveImageNodeId: '9',
    requiredPlaceholders: [], requiredModelFiles: ['present.safetensors'], ratioDims: {}, modelId: 'present', maxResponseBytes: 1024,
  });
  const round = async (options?: { fresh?: boolean }) => {
    if (!provider.healthCheck) throw new Error('fixture provider requires a health check');
    return provider.healthCheck(AbortSignal.timeout(2000), options);
  };
  return { state, round };
}

const BOOT_A = 'a'.repeat(32);
const BOOT_B = 'b'.repeat(32);

test('the same worker boot reuses one inventory read across rounds within the reuse window', async () => {
  const { state, round } = inventoryHost();
  state.bootId = BOOT_A;
  expect(await round()).toEqual({ ok: true });
  expect(await round()).toEqual({ ok: true });
  expect(state.inventoryReads).toBe(1);
});

test('a changed boot id re-reads the inventory', async () => {
  const { state, round } = inventoryHost();
  state.bootId = BOOT_A;
  await round();
  state.bootId = BOOT_B;
  await round();
  await round();
  expect(state.inventoryReads).toBe(2);
});

test('a worker without a boot id, or with a malformed one, gets a fresh inventory read every round', async () => {
  const { state, round } = inventoryHost();
  await round();
  await round();
  expect(state.inventoryReads).toBe(2);
  state.bootId = 'not-a-boot-id';
  await round();
  await round();
  expect(state.inventoryReads).toBe(4);
});

test('an inventory read older than the reuse window is read again', async () => {
  const { state, round } = inventoryHost();
  state.bootId = BOOT_A;
  const start = Date.now();
  setSystemTime(start);
  await round();
  setSystemTime(start + INVENTORY_REUSE_MS - 1);
  await round();
  expect(state.inventoryReads).toBe(1);
  setSystemTime(start + INVENTORY_REUSE_MS);
  await round();
  expect(state.inventoryReads).toBe(2);
});

test('a failed inventory read is not cached and does not keep an older read alive', async () => {
  const { state, round } = inventoryHost();
  state.bootId = BOOT_A;
  await round();
  state.inventoryStatus = 500;
  expect(await round({ fresh: true })).toMatchObject({ ok: false, probeCode: 'inventory_transport' });
  expect(await round()).toMatchObject({ ok: false, probeCode: 'inventory_transport' });
  expect(state.inventoryReads).toBe(3);
  state.inventoryStatus = 200;
  expect(await round()).toEqual({ ok: true });
  expect(await round()).toEqual({ ok: true });
  expect(state.inventoryReads).toBe(4);
});

test('a forced probe bypasses a reusable inventory and refreshes it for later rounds', async () => {
  const { state, round } = inventoryHost();
  state.bootId = BOOT_A;
  await round();
  await round({ fresh: true });
  expect(state.inventoryReads).toBe(2);
  await round();
  expect(state.inventoryReads).toBe(2);
});

test('a failed handshake drops the reusable inventory so the next good round reads again', async () => {
  const { state, round } = inventoryHost();
  state.bootId = BOOT_A;
  await round();
  state.ready = false;
  expect(await round()).toMatchObject({ ok: false, probeCode: 'privacy_not_ready' });
  expect(state.inventoryReads).toBe(1);
  state.ready = true;
  expect(await round()).toEqual({ ok: true });
  expect(state.inventoryReads).toBe(2);
});

test('one canceled subscriber cannot abort another and the last subscriber cancels the underlying read', async () => {
  let finish: ((response: Response) => void) | undefined;
  let sharedSignal: AbortSignal | undefined;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: string | URL | Request, init?: RequestInit) => {
    sharedSignal = init?.signal ?? undefined;
    const signal = sharedSignal;
    return new Promise<Response>((resolve, reject) => {
      finish = resolve;
      signal?.addEventListener('abort', () => { reject(abortReason(signal)); }, { once: true });
    });
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  const health = createComfyuiHealthTransport(baseUrl, privacy, 1024);
  const a = new AbortController();
  const b = new AbortController();
  const first = health.inventory(a.signal);
  const second = health.inventory(b.signal);
  a.abort(new Error('first caller canceled'));
  await rejects(first, /first caller canceled/);
  expect(sharedSignal?.aborted).toBe(false);
  finish?.(Response.json({ available: true }));
  expect(await second).toEqual({ available: true });
  const last = new AbortController();
  const abandoned = health.inventory(last.signal);
  last.abort();
  await rejects(abandoned);
  expect(sharedSignal?.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('different registry credential owners never share host reads', async () => {
  const tokens: (string | null)[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: string | URL | Request, init?: RequestInit) => {
    tokens.push(new Headers(init?.headers).get('Authorization'));
    return Promise.resolve(Response.json(currentWorkerPrivacy));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  await Promise.all([
    createComfyuiHealthTransport(baseUrl, privacy, 1024).handshake(AbortSignal.timeout(2000)),
    createComfyuiHealthTransport(baseUrl, { ...privacy, token: 'another-token' }, 1024).handshake(AbortSignal.timeout(2000)),
  ]);
  expect(tokens).toEqual(['Bearer synthetic-token', 'Bearer another-token']);
});
