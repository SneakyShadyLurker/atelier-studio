import { afterEach, expect, spyOn, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { createComfyuiHealthTransport } from './health';
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
