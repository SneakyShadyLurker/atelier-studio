import { afterEach, expect, spyOn, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import type { ServerWebSocket } from 'bun';
import sharp from 'sharp';
import { createComfyuiProvider, drainComfyUi } from './comfyui';
import { TEST_EXECUTION_TIMEOUT_MS, currentWorkerPrivacy, privateWorkerTestPrivacy, privateWorkerTestTls } from '../test/private-worker-fixture';
import { grayCardPng, pngBytes } from '../test/image-fixtures';
import type { ProviderResult } from './types';
import * as abort from '../lifecycle/abort';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0));
const MP4 = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { await drainComfyUi(); await Promise.all(stops.splice(0).map((stop) => stop())); });

function fixture(options: {
  video?: boolean; disconnect?: boolean; ack?: 'lost' | 'timeout' | 'throttled' | 'reject' | 'identity' | 'stalled-body' | 'stalled-headers';
  invalid?: 'count' | 'bytes' | 'shape' | 'media';
  terminalClock?: { now: number };
  imageBytes?: Uint8Array; maxResponseBytes?: number;
  baseDimensions?: { width: number; height: number };
  advertisedBytes?: number;
  terminalEvent?: 'executed' | 'execution_success' | 'executing' | 'execution_error' | 'execution_interrupted';
  historyLagReads?: number;
} = {}) {
  let lease = '';
  let completed = false;
  const ids: string[] = [crypto.randomUUID(), crypto.randomUUID()];
  const calls: string[] = [];
  const clients: string[] = [];
  const flags: unknown[] = [];
  const sockets = new Set<ServerWebSocket<{ client: string }>>();
  const statusTimes: number[] = [];
  let eventAt = 0;
  const bytes = options.video ? MP4 : options.imageBytes ?? PNG;
  let finishAck: (() => void) | undefined;
  const server = Bun.serve<{ client: string }>({
    port: 0, tls: privateWorkerTestTls, idleTimeout: 0,
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      calls.push(`${req.method} ${path}`);
      if (req.headers.get('Authorization') !== `Bearer ${privateWorkerTestPrivacy.token}`) return new Response(null, { status: 401 });
      if (path === '/atelier/v1/privacy') return Response.json(currentWorkerPrivacy);
      if (path === '/ws') {
        const client = new URL(req.url).searchParams.get('clientId') ?? '';
        clients.push(client);
        return server.upgrade(req, { data: { client } }) ? undefined : new Response(null, { status: 426 });
      }
      if (path === '/free') return new Response(null);
      if (path === '/system_stats') return Response.json({ devices: [{ vram_total: 100, vram_free: 100 }] });
      if (path.endsWith('/renew')) return Response.json({ ok: true });
      if (path.includes('/outputs/')) {
        expect(completed).toBe(true);
        expect(calls.some((call) => call.endsWith('/renew'))).toBe(true);
        return new Response(options.invalid === 'shape' ? new Uint8Array([1, 2, 3]) : bytes, {
          headers: { 'Content-Type': options.invalid === 'media' ? 'text/plain' : options.video ? 'video/mp4' : 'image/png' },
        });
      }
      if (path.startsWith('/atelier/v1/jobs/')) {
        if (req.method === 'POST') {
          lease = path.split('/').at(-1) ?? '';
          expect(await req.json()).toEqual({ previews: !options.video, imageOutputs: !options.video,
            executionTimeoutSeconds: TEST_EXECUTION_TIMEOUT_MS / 1_000 });
          return Response.json({ protocol: 2, ready: true, previous_prompt_id: null });
        }
        if (req.method === 'DELETE') { finishAck?.(); return Response.json({ ok: true }); }
        if (completed && options.terminalClock) options.terminalClock.now = 600_001;
        statusTimes.push(performance.now());
        const visible = completed && statusTimes.length > (options.historyLagReads ?? 0);
        const count = options.invalid === 'count' ? 0 : options.video ? 1 : 2;
        return Response.json({ state: visible ? 'completed' : 'running', outputs: visible ? ids.slice(0, count).map((id) => ({
          id, bytes: options.advertisedBytes ?? (options.invalid === 'bytes' ? bytes.length + 1 : options.invalid === 'shape' ? 3 : bytes.length),
          mediaType: options.video ? 'video/mp4' : 'image/png',
        })) : [] });
      }
      if (path === '/prompt') {
        const body = await req.json() as { prompt_id: string; client_id: string; prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> };
        expect(body.prompt_id).toBe(lease);
        expect(clients[0]).toBe(body.client_id);
        const sink = body.prompt['9'];
        expect(sink?.class_type).toBe(options.video ? 'AtelierSaveVideo' : 'AtelierSaveImages');
        expect(sink?.inputs.job_id).toBe(lease);
        completed = true;
        if (options.terminalEvent) {
          eventAt = performance.now();
          for (const socket of sockets) socket.send(JSON.stringify({ type: options.terminalEvent,
            data: { prompt_id: lease, node: options.terminalEvent === 'executed' ? '9' : null,
              output: { images: [{ filename: 'not-authoritative.png', subfolder: '', type: 'output' }] } } }));
        }
        if (options.ack === 'lost') return new Response(null, { status: 503 });
        if (options.ack === 'timeout') return new Response(null, { status: 408 });
        if (options.ack === 'throttled') return Response.json({ error: 'worker_busy' }, { status: 429 });
        if (options.ack === 'reject') return new Response(null, { status: 400 });
        if (options.ack === 'identity') return Response.json({ prompt_id: crypto.randomUUID() });
        if (options.ack === 'stalled-body') return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"prompt_id":'));
            finishAck = () => { try { controller.close(); } catch { /* Client already canceled the stream. */ } };
          },
        }));
        if (options.ack === 'stalled-headers') await new Promise<void>((resolve) => { finishAck = resolve; });
        return Response.json({ prompt_id: lease });
      }
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(ws) { sockets.add(ws); if (options.disconnect) setTimeout(() => { ws.close(); }, 10); },
      message(_ws, data) { flags.push(JSON.parse(String(data)) as unknown); },
      close(ws) { sockets.delete(ws); },
    },
  });
  stops.push(async () => { finishAck?.(); for (const socket of sockets) socket.close(); await server.stop(true); });
  const provider = createComfyuiProvider({
    baseUrl: `https://127.0.0.1:${server.port}`, privacy: privateWorkerTestPrivacy,
    workflowText: JSON.stringify({ '9': { class_type: options.video ? 'SaveVideo' : 'SaveImageWebsocket', inputs: { images: ['8', 0] } } }),
    saveImageNodeId: '9', requiredPlaceholders: [], requiredModelFiles: [], maxResponseBytes: options.maxResponseBytes ?? 1024 * 1024,
    ratioDims: { '1:1': options.baseDimensions ?? { width: 1, height: 1 } }, modelId: 'recovery-test', outputKind: options.video ? 'video' : 'image',
  });
  const request = { modelId: 'recovery-test', prompt: 'synthetic', ratio: '1:1' as const, seed: 1, tileIndex: 0, count: options.video ? 1 : 2 };
  return { provider, request, calls, clients, flags, ids, statusTimes,
    terminalHint(marker: number) {
      for (const socket of sockets) {
        socket.send(JSON.stringify({ type: 'execution_success', data: { prompt_id: lease } }));
        // Ordered progress is an acknowledgment that the client processed the
        // preceding terminal hint, without relying on sleeps or socket timing.
        socket.send(JSON.stringify({ type: 'progress', data: { prompt_id: lease, value: marker, max: 10 } }));
      }
    },
    get eventAt() { return eventAt; }, get lease() { return lease; } };
}

for (const terminalEvent of ['executed', 'execution_success', 'executing', 'execution_error', 'execution_interrupted'] as const) {
  test(`${terminalEvent} wakes authoritative status immediately and waits through history insertion`, async () => {
    const worker = fixture({ terminalEvent, historyLagReads: 2 });
    const results = await Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(2_000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    expect(results.map((result) => result.status)).toEqual(['ready', 'ready']);
    expect(worker.statusTimes.length).toBe(3);
    expect((worker.statusTimes[0] ?? Infinity) - worker.eventAt).toBeLessThan(500);
    expect((worker.statusTimes[2] ?? Infinity) - worker.eventAt).toBeLessThan(800);
    expect(worker.calls.filter((call) => call === 'POST /prompt')).toHaveLength(1);
    for (const result of results) if (result.status === 'ready') await result.afterStored?.();
  });
}

test('terminal hints cannot bypass transient status backoff before recovery and fast history reconciliation', async () => {
  const worker = fixture({ terminalEvent: 'execution_success' });
  const nativeFetch = globalThis.fetch;
  const nativeDelay = abort.abortableDelay;
  let statusReads = 0;
  let now = 0;
  const readTimes: number[] = [];
  const backoffs = [Promise.withResolvers<{ ms: number; advance: () => void }>(),
    Promise.withResolvers<{ ms: number; advance: () => void }>()];
  const gates: (() => void)[] = [];
  const markers = new Map<number, () => void>();
  const controller = new AbortController();
  const delay = spyOn(abort, 'abortableDelay').mockImplementation((ms, signal) => {
    if (statusReads === 1 || statusReads === 2) {
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          reject(abort.abortReason(signal));
        };
        const advance = () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          now += ms;
          resolve();
        };
        gates.push(advance);
        signal.addEventListener('abort', onAbort, { once: true });
        backoffs[statusReads - 1]?.resolve({ ms, advance });
      });
    }
    if (statusReads === 3) { now += ms; return Promise.resolve(); }
    return nativeDelay(ms, signal);
  });
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if ((init?.method ?? 'GET') === 'GET' && path === `/atelier/v1/jobs/${worker.lease}`) {
      statusReads += 1;
      readTimes.push(now);
      if (statusReads === 1) return new Response(null, { status: 503 });
      if (statusReads === 2) throw new TypeError('brief status disconnect');
      if (statusReads === 3) return Response.json({ state: 'running', outputs: [] });
    }
    return await nativeFetch(input, init);
  }, { preconnect: nativeFetch.preconnect }));
  const generation = Array.fromAsync(worker.provider.generate(worker.request, controller.signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS,
    onProgress(event) { markers.get(Math.round(event.progress * 10))?.(); },
  }));
  void generation.catch(() => undefined);
  try {
    for (const index of [0, 1]) {
      const backoff = await backoffs[index]?.promise;
      if (!backoff) throw new Error('missing status backoff');
      expect(backoff.ms).toBe(1_000);
      for (let hint = 1; hint <= 3; hint += 1) {
        const marker = index * 3 + hint;
        const received = new Promise<void>((resolve) => { markers.set(marker, resolve); });
        worker.terminalHint(marker);
        await received;
        expect(statusReads).toBe(index + 1);
      }
      backoff.advance();
    }
    const results = await generation;
    expect(results.map((result) => result.status)).toEqual(['ready', 'ready']);
    expect(readTimes).toEqual([0, 1_000, 2_000, 2_100]);
    expect(worker.calls.filter((call) => call === 'POST /prompt')).toHaveLength(1);
    for (const result of results) if (result.status === 'ready') await result.afterStored?.();
  } finally {
    controller.abort();
    for (const advance of gates) advance();
    await generation.catch(() => undefined);
    fetch.mockRestore();
    delay.mockRestore();
  }
});

test('recovery preserves native hires PNG dimensions instead of requiring base latent dimensions', async () => {
  const imageBytes = await grayCardPng(3);
  const worker = fixture({ imageBytes, baseDimensions: { width: 2, height: 2 } });
  const results = await Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(5000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
  expect(results.map((result) => result.status)).toEqual(['ready', 'ready']);
  for (const result of results) if (result.status === 'ready') {
    expect(result.bytes).toEqual(imageBytes);
    await result.afterStored?.();
  }
});

test('recovery accepts a valid PNG above 8 MiB within the configured response budget', async () => {
  // A flat synthetic image with uncompressed PNG data exercises the byte
  // contract without requiring noisy pixels or a model render.
  const imageBytes = new Uint8Array(await sharp({ create: {
    width: 2048, height: 1400, channels: 3, background: { r: 108, g: 108, b: 108 },
  } }).png({ compressionLevel: 0 }).toBuffer());
  const maxResponseBytes = 50 * 1024 * 1024;
  expect(imageBytes.length).toBeGreaterThan(8 * 1024 * 1024);
  expect(imageBytes.length).toBeLessThan(maxResponseBytes);
  const worker = fixture({ imageBytes, maxResponseBytes });
  const results = await Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(5000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
  expect(results.map((result) => result.status)).toEqual(['ready', 'ready']);
  for (const result of results) if (result.status === 'ready') {
    expect(result.bytes).toEqual(imageBytes);
    await result.afterStored?.();
  }
});

test('recovery rejects advertised PNG bytes above the configured budget before download', async () => {
  const worker = fixture({ advertisedBytes: 50 * 1024 * 1024 + 1, maxResponseBytes: 50 * 1024 * 1024 });
  const results = await Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(5000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
  expect(results.map((result) => result.status)).toEqual(['failed', 'failed']);
  expect(worker.calls.some((call) => call.includes('/outputs/'))).toBe(false);
});

for (const [width, height, ready] of [[6144, 4096, true], [6144, 4097, false], [8000, 4000, false], [0, 1, false], [1, 0, false]] as const) {
  test(`recovery enforces positive PNG dimensions and Atelier's existing 24 Mi-pixel ceiling: ${width}x${height}`, async () => {
    const worker = fixture({ imageBytes: pngBytes(width, height) });
    const results = await Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(5000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    expect(results.map((result) => result.status)).toEqual(ready ? ['ready', 'ready'] : ['failed', 'failed']);
    for (const result of results) if (result.status === 'ready') await result.afterStored?.();
  });
}

for (const options of [{}, { video: true }, { disconnect: true, ack: 'lost' as const }]) {
  test(`silent/disconnected worker recovers scoped ${options.video ? 'MP4' : 'PNG'} output without resubmission ${JSON.stringify(options)}`, async () => {
    const worker = fixture(options);
    const results: ProviderResult[] = await Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(6000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    expect(results.map((result) => result.status)).toEqual(Array.from({ length: worker.request.count }, () => 'ready'));
    expect(worker.calls.filter((call) => call === 'POST /prompt')).toHaveLength(1);
    expect(worker.calls.some((call) => /\/view|\/history|\/upload|\/interrupt/.test(call))).toBe(false);
    expect(worker.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
    const ready = results.filter((result) => result.status === 'ready');
    await ready.at(-1)?.afterStored?.();
    if (ready.length > 1) expect(worker.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
    for (const result of ready) await result.afterStored?.();
    expect(worker.calls.filter((call) => call === `DELETE /atelier/v1/jobs/${worker.lease}`)).toHaveLength(1);
    expect(new Set(worker.clients).size).toBe(1);
    expect(worker.clients.length).toBeLessThanOrEqual(4);
    expect(worker.flags[0]).toEqual({ type: 'feature_flags', data: { supports_preview_metadata: true } });
  });
}

for (const ack of ['timeout', 'throttled'] as const) {
  test(`accepted prompt followed by ${ack === 'timeout' ? 408 : 429} reconciles the original lease without replay`, async () => {
    const worker = fixture({ ack });
    const results = await Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(5_000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    expect(results.map((result) => result.status)).toEqual(['ready', 'ready']);
    expect(worker.calls.filter((call) => call === 'POST /prompt')).toHaveLength(1);
    expect(worker.calls.filter((call) => call.startsWith('POST /atelier/v1/jobs/') && !call.endsWith('/renew')))
      .toEqual([`POST /atelier/v1/jobs/${worker.lease}`]);
    expect(worker.calls).toContain(`GET /atelier/v1/jobs/${worker.lease}`);
    expect(worker.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
    for (const result of results) if (result.status === 'ready') await result.afterStored?.();
    expect(worker.calls.filter((call) => call.startsWith('DELETE'))).toEqual([`DELETE /atelier/v1/jobs/${worker.lease}`]);
  });
}

for (const scenario of [
  { name: 'three consecutive 5xx failures exhaust recovery', steps: [503, 503, 503, 'completed'], ready: false, reads: 3 },
  { name: 'three consecutive transport failures exhaust recovery', steps: ['network', 'network', 'network', 'completed'], ready: false, reads: 3 },
  { name: 'successful queued status resets consecutive transient failures', steps: [503, 'network', 'queued', 503, 'network', 'completed'], ready: true, reads: 6 },
] as const) {
  test(scenario.name, async () => {
    const worker = fixture();
    const nativeFetch = globalThis.fetch;
    const nativeDelay = abort.abortableDelay;
    const delay = spyOn(abort, 'abortableDelay').mockImplementation((ms, signal) => nativeDelay(ms === 1_000 ? 5 : ms, signal));
    let statusReads = 0;
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if ((init?.method ?? 'GET') !== 'GET' || path !== `/atelier/v1/jobs/${worker.lease}`) return nativeFetch(input, init);
      const step = scenario.steps[statusReads] ?? 503;
      statusReads += 1;
      if (step === 'network') throw new TypeError('synthetic status transport failure');
      if (typeof step === 'number') return new Response(null, { status: step });
      if (step === 'queued') return Response.json({ state: 'queued', outputs: [] });
      return nativeFetch(input, init);
    }, { preconnect: nativeFetch.preconnect }));
    try {
      const signal = AbortSignal.timeout(2_000);
      const results = await Array.fromAsync(worker.provider.generate(worker.request, signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
      expect(signal.aborted).toBe(false);
      expect(results.map((result) => result.status)).toEqual(scenario.ready ? ['ready', 'ready'] : ['failed', 'failed']);
      expect(statusReads).toBe(scenario.reads);
      expect(worker.calls.filter((call) => call === 'POST /prompt')).toHaveLength(1);
      if (!scenario.ready) expect(worker.calls.some((call) => call.includes('/outputs/'))).toBe(false);
      for (const result of results) if (result.status === 'ready') await result.afterStored?.();
      await drainComfyUi();
      expect(worker.calls.filter((call) => call === `DELETE /atelier/v1/jobs/${worker.lease}`)).toHaveLength(1);
    } finally { fetch.mockRestore(); delay.mockRestore(); }
  });
}

for (const ack of ['reject', 'identity'] as const) {
  test(`definite ${ack} acknowledgment fails without downloading or rerendering`, async () => {
    const worker = fixture({ ack });
    const results = await Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(4000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    expect(results.map((result) => result.status)).toEqual(['failed', 'failed']);
    expect(worker.calls.filter((call) => call === 'POST /prompt')).toHaveLength(1);
    expect(worker.calls.some((call) => call.includes('/outputs/'))).toBe(false);
  });
}

for (const bodyFailure of ['stalled', 'error']) {
  test(`definite rejection with ${bodyFailure} diagnostics cannot recover completed output or resubmit`, async () => {
    const worker = fixture({ ack: 'reject' });
    const nativeFetch = globalThis.fetch;
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => nativeTimeout(ms === 8_000 ? 1500 : ms));
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await nativeFetch(input, init);
      if (new URL(input instanceof Request ? input.url : input).pathname !== '/prompt') return response;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          if (bodyFailure === 'error') controller.error(new Error('synthetic rejection body failure'));
          else controller.enqueue(new TextEncoder().encode('rejected'));
        },
      }), { status: response.status });
    }, { preconnect: nativeFetch.preconnect }));
    try {
      const results: ProviderResult[] = await Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(4000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
      expect(results.map((result) => result.status)).toEqual(['failed', 'failed']);
      for (const result of results) {
        if (result.status !== 'failed') throw new Error('expected definite rejection');
        expect(result.error).toMatchObject({ name: 'ComfyuiUpstreamError', status: 400 });
      }
      expect(worker.calls.filter((call) => call === 'POST /prompt')).toHaveLength(1);
      expect(worker.calls.some((call) => call === `GET /atelier/v1/jobs/${worker.lease}` || call.includes('/outputs/'))).toBe(false);
      await drainComfyUi();
    } finally { fetch.mockRestore(); timeout.mockRestore(); }
  });
}

for (const invalid of ['count', 'bytes', 'shape', 'media'] as const) {
  test(`invalid recovered ${invalid} produces exactly one failure per index`, async () => {
    const worker = fixture({ invalid });
    const results = await Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(5000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    expect(results).toMatchObject([{ status: 'failed', index: 0 }, { status: 'failed', index: 1 }]);
  });
}

for (const ack of ['stalled-body', 'stalled-headers'] as const) {
  test(`${ack} has its own eight-second deadline while completed output is retained`, async () => {
    const worker = fixture({ ack });
    const started = performance.now();
    const results = await Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(15_000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    expect(results.map((result) => result.status)).toEqual(['ready', 'ready']);
    expect(performance.now() - started).toBeLessThan(11_000);
    expect(worker.calls.filter((call) => call === 'POST /prompt')).toHaveLength(1);
    for (const result of results) if (result.status === 'ready') await result.afterStored?.();
  }, 16_000);
}

test('completed status during a stalled acknowledgment cannot refresh the absolute retention cap', async () => {
  const terminalClock = { now: 0 };
  const clock = spyOn(performance, 'now').mockImplementation(() => terminalClock.now);
  const worker = fixture({ ack: 'stalled-body', terminalClock });
  try {
    const results = await Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(4000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    expect(results).toMatchObject([{ status: 'failed', index: 0 }, { status: 'failed', index: 1 }]);
    expect(worker.calls.some((call) => call.includes('/outputs/'))).toBe(false);
    expect(worker.calls.filter((call) => call === 'POST /prompt')).toHaveLength(1);
    await drainComfyUi();
  } finally { clock.mockRestore(); }
});

test('abort during recovery cancels and releases the original lease', async () => {
  const worker = fixture();
  await rejects(Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(200), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })));
  await drainComfyUi();
  expect(worker.calls.filter((call) => call === `DELETE /atelier/v1/jobs/${worker.lease}`)).toHaveLength(1);
});

for (const fail of [false, true]) {
  test(fail ? 'one invalid concurrent image aborts and joins a stalled sibling reader'
    : 'concurrent image downloads preserve batch order when responses finish in reverse', async () => {
    const worker = fixture();
    const nativeFetch = globalThis.fetch;
    let beginBoth: (() => void) | undefined;
    const both = new Promise<void>((resolve) => { beginBoth = resolve; });
    let started = 0;
    let canceledSibling = 0;
    const completed: number[] = [];
    const second = pngBytes(1, 1, PNG.length);
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (!url.pathname.includes('/outputs/')) return nativeFetch(input, init);
      const index = worker.ids.indexOf(url.pathname.split('/').at(-1) ?? '');
      started += 1;
      if (started === 2) beginBoth?.();
      await both;
      if (fail && index === 1) return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(PNG.subarray(0, 1)); },
        cancel() { canceledSibling += 1; },
      }), { headers: { 'Content-Type': 'image/png' } });
      if (!fail) await new Promise<void>((resolve) => { setTimeout(resolve, index === 0 ? 20 : 1); });
      completed.push(index);
      return new Response(index === 0 ? PNG : second, {
        headers: { 'Content-Type': fail ? 'text/plain' : 'image/png' },
      });
    }, { preconnect: nativeFetch.preconnect }));
    try {
      const results = await Array.fromAsync(worker.provider.generate(worker.request, AbortSignal.timeout(4000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
      expect(started).toBe(2);
      if (fail) {
        expect(results).toMatchObject([{ status: 'failed', index: 0 }, { status: 'failed', index: 1 }]);
        expect(canceledSibling).toBe(1);
      } else {
        expect(completed).toEqual([1, 0]);
        const ready = results.filter((result) => result.status === 'ready');
        expect(ready.map((result) => result.bytes)).toEqual([PNG, second]);
        for (const result of ready) await result.afterStored?.();
      }
      await drainComfyUi();
    } finally { fetch.mockRestore(); }
  });
}
