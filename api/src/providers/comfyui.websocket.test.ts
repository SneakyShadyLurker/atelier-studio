import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { createComfyuiProvider, drainComfyUi } from './comfyui';
import { TEST_EXECUTION_TIMEOUT_MS, privateWorkerFixture, privateWorkerTestPrivacy, privateWorkerTestServerOptions } from '../test/private-worker-fixture';
import type { ProviderProgress, ProviderRequest } from './types';

// Minimal valid 1×1 PNG (red pixel).
const PNG_1x1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0),
);

function frameWithHeader(png: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + png.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1, false); // BinaryEventTypes.PREVIEW_IMAGE
  view.setUint32(4, 2, false); // PNG
  out.set(png, 8);
  return out;
}

function frameWithMetadata(png: Uint8Array, promptId: string, nodeId = '8'): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify({
    node_id: nodeId,
    display_node_id: '8',
    real_node_id: '8',
    prompt_id: promptId,
    parent_node_id: null,
  }));
  const out = new Uint8Array(8 + metadata.byteLength + png.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 4, false); // BinaryEventTypes.PREVIEW_IMAGE_WITH_METADATA
  view.setUint32(4, metadata.byteLength, false);
  out.set(metadata, 8);
  out.set(png, 8 + metadata.byteLength);
  return out;
}

const IMG_GRAPH = {
  '1': { class_type: 'UNETLoader', inputs: {} },
  '2': { class_type: 'CLIPLoader', inputs: {} },
  '3': { class_type: 'VAELoader', inputs: {} },
  '4': { class_type: 'VAEDecode', inputs: {} },
  '5': { class_type: 'KSamplerSelect', inputs: {} },
  '8': { class_type: 'KSampler', inputs: {} },
  '9': { class_type: 'SaveImageWebsocket', inputs: { images: ['8', 0] } },
};

const servers: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  await drainComfyUi();
  await Promise.all(servers.map((s) => s.stop()));
  servers.length = 0;
});

function track(server: { stop: (closeActive?: boolean) => Promise<void> }): void {
  servers.push({
    stop: async () => {
      await Promise.race([server.stop(true), new Promise<void>((r) => setTimeout(r, 500))]);
    },
  });
}

function startMock(opts: {
  saveNode: string;
  count: number;
  dropAfter?: number;
  emitExecuted?: boolean;
  payloadBytes?: number;
  previewCount?: number;
  previewWithMetadata?: boolean;
  badPreviewIdentity?: 'prompt' | 'node';
  progressState?: boolean;
  nativeProgressOnly?: boolean;
  successEvent?: boolean;
  interrupted?: boolean;
  nonSamplerProgress?: boolean;
  completionDelayMs?: number;
  /** Extra JSON frames sent before the save node executes. */
  frames?: (promptId: string) => unknown[];
}): string {
  const worker = privateWorkerFixture();
  const sockets = new Map<string, ServerWebSocket<{ clientId: string }>>();
  const server = Bun.serve<{ clientId: string }>({
    port: 0,
    ...privateWorkerTestServerOptions,
    idleTimeout: 0,
    async fetch(req, srv) {
      const handled = worker.handle(req);
      if (handled) return handled;
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        const clientId = url.searchParams.get('clientId') ?? '';
        return srv.upgrade(req, { data: { clientId } }) ? undefined : new Response('upgrade', { status: 426 });
      }
      if (url.pathname === '/free') return new Response(null, { status: 200 });
      if (url.pathname === '/system_stats') return Response.json({ devices: [{ vram_total: 100, vram_free: 95 }] });
      if (url.pathname === '/prompt' && req.method === 'POST') {
        return req.json().then((body) => {
          // Preview mode is owned by the lease's `previews` control on the worker.
          expect(Object.hasOwn(body as object, 'extra_data')).toBe(false);
          const promptId = (body as { prompt_id: string }).prompt_id;
          setTimeout(() => {
            const ws = sockets.get((body as { client_id: string }).client_id);
            if (!ws) { worker.complete(promptId, Array.from({ length: opts.count }, () => PNG_1x1)); return; }
            if (opts.interrupted) {
              worker.fail(promptId);
              ws.send(JSON.stringify({ type: 'execution_interrupted', data: { prompt_id: promptId } }));
              return;
            }
            if (opts.nonSamplerProgress) {
              for (const state of ['running', 'finished']) {
                ws.send(JSON.stringify({ type: 'progress_state', data: { prompt_id: promptId,
                  nodes: Object.fromEntries(['1', '2', '3', '4', '5', '9'].map((nodeId) => [nodeId, {
                    node_id: nodeId, prompt_id: promptId, state, value: state === 'running' ? 0 : 1, max: 1,
                  }])),
                } }));
              }
            }
            for (const frame of opts.frames?.(promptId) ?? []) {
              ws.send(frame instanceof Uint8Array ? frame : JSON.stringify(frame));
            }
            if (opts.previewCount !== undefined) {
              ws.send(JSON.stringify({ type: 'executing', data: { node: '8', prompt_id: promptId } }));
              for (let i = 0; i < opts.previewCount; i += 1) {
                if (!opts.nativeProgressOnly) ws.send(JSON.stringify({
                  type: 'progress',
                  data: { node: '8', prompt_id: promptId, value: i + 1, max: opts.previewCount },
                }));
                if (opts.progressState) {
                  const invalidNode = { node_id: '8', prompt_id: promptId, state: 'running', value: 0.99, max: 1 };
                  ws.send(JSON.stringify({ type: 'progress_state', data: { nodes: { '8': invalidNode } } }));
                  ws.send(JSON.stringify({ type: 'progress_state', data: { prompt_id: 'unrelated', nodes: { '8': invalidNode } } }));
                  for (const state of [undefined, null, 17, 'pending', 'error', 'unknown']) {
                    ws.send(JSON.stringify({ type: 'progress_state', data: { prompt_id: promptId,
                      nodes: { '8': { ...invalidNode, state } } } }));
                  }
                  ws.send(JSON.stringify({ type: 'progress_state', data: { prompt_id: promptId,
                    nodes: { '8': { ...invalidNode, node_id: '9' } } } }));
                  ws.send(JSON.stringify({ type: 'progress_state', data: { prompt_id: promptId, nodes: {
                    '8': { node_id: '8', prompt_id: promptId, state: i + 1 === opts.previewCount ? 'finished' : 'running', value: i + 1, max: opts.previewCount },
                    '9': { node_id: '9', prompt_id: 'unrelated', state: 'running', value: 1, max: 1 },
                    unknown: { node_id: 'unknown', prompt_id: promptId, state: 'running', value: 1, max: 1 },
                  } } }));
                }
                ws.send(opts.previewWithMetadata ? frameWithMetadata(PNG_1x1,
                  opts.badPreviewIdentity === 'prompt' ? 'unrelated' : promptId,
                  opts.badPreviewIdentity === 'node' ? '9' : '8') : frameWithHeader(PNG_1x1));
              }
            }
            ws.send(JSON.stringify({ type: 'executing', data: { node: opts.saveNode, prompt_id: promptId } }));
            const emit = opts.dropAfter ?? opts.count;
            const payload = opts.payloadBytes !== undefined ? new Uint8Array(opts.payloadBytes) : PNG_1x1;
            for (let i = 0; i < emit; i++) ws.send(frameWithHeader(payload));
            worker.complete(promptId, Array.from({ length: opts.count }, () => payload));
            if (opts.dropAfter !== undefined) {
              ws.close();
              return;
            }
            if (opts.emitExecuted !== false) {
              ws.send(
                JSON.stringify({ type: 'executed', data: { node: opts.saveNode, prompt_id: promptId, output: {} } }),
              );
            }
            ws.send(JSON.stringify({ type: opts.successEvent ? 'execution_success' : 'executing', data: { node: null, prompt_id: promptId } }));
          }, opts.completionDelayMs ?? 5);
          return Response.json({ prompt_id: promptId, number: 0, node_errors: {} });
        });
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.set(ws.data.clientId, ws);
      },
      message() {
        // tests do not send client websocket messages
      },
      close(ws) {
        sockets.delete(ws.data.clientId);
      },
    },
  });
  track(server);
  return `https://127.0.0.1:${server.port}`;
}

type ScriptedSocket = ServerWebSocket<{ clientId: string }>;
type Worker = ReturnType<typeof privateWorkerFixture>;

/**
 * A worker whose socket behaviour each test scripts: `onOpen` runs for every
 * accepted socket (1-based connection number), `onPrompt` once /prompt is
 * accepted. `refuseSockets` answers upgrades with 426; `holdSockets` leaves
 * them pending until `releaseSockets()`.
 */
function startScripted(opts: {
  refuseSockets?: boolean;
  holdSockets?: boolean;
  onOpen?: (ws: ScriptedSocket, connection: number, state: ScriptedState) => void;
  onPrompt?: (promptId: string, worker: Worker, state: ScriptedState) => void;
}) {
  const worker = privateWorkerFixture();
  const state: ScriptedState = { socketAttempts: 0, opens: 0, statusReads: 0, promptId: undefined, socket: undefined, worker };
  let releaseSockets = () => { /* Replaced below. */ };
  const socketsReleased = new Promise<void>((resolve) => { releaseSockets = resolve; });
  const server = Bun.serve<{ clientId: string }>({
    port: 0,
    ...privateWorkerTestServerOptions,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (req.method === 'GET' && /^\/atelier\/v1\/jobs\/[^/]+$/.test(url.pathname)) state.statusReads += 1;
      const handled = worker.handle(req);
      if (handled) return handled;
      if (url.pathname === '/ws') {
        state.socketAttempts += 1;
        if (opts.holdSockets) await socketsReleased;
        if (opts.refuseSockets || opts.holdSockets) return new Response('upgrade', { status: 426 });
        return srv.upgrade(req, { data: { clientId: url.searchParams.get('clientId') ?? '' } }) ? undefined : new Response('upgrade', { status: 426 });
      }
      if (url.pathname === '/free') return new Response(null, { status: 200 });
      if (url.pathname === '/system_stats') return Response.json({ devices: [{ vram_total: 100, vram_free: 95 }] });
      if (url.pathname === '/prompt' && req.method === 'POST') {
        const body = await req.json() as { prompt_id: string };
        state.promptId = body.prompt_id;
        opts.onPrompt?.(body.prompt_id, worker, state);
        return Response.json({ prompt_id: body.prompt_id, number: 0, node_errors: {} });
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        state.opens += 1;
        state.socket = ws;
        opts.onOpen?.(ws, state.opens, state);
      },
      message() { /* The adapter's feature_flags message needs no answer. */ },
    },
  });
  servers.push({ stop: async () => {
    releaseSockets();
    await Promise.race([server.stop(true), new Promise<void>((r) => setTimeout(r, 500))]);
  } });
  return { baseUrl: `https://127.0.0.1:${server.port}`, state, releaseSockets };
}

interface ScriptedState {
  socketAttempts: number;
  opens: number;
  statusReads: number;
  promptId: string | undefined;
  socket: ScriptedSocket | undefined;
  worker: Worker;
}

/** Records setTimeout delays and shortens the listed ones, leaving the rest real. */
function recordTimers(shorten: Record<number, number>) {
  const delays: number[] = [];
  const nativeTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== undefined) delays.push(ms);
    return nativeTimeout(fn, ms !== undefined && Object.hasOwn(shorten, ms) ? shorten[ms] : ms, ...args);
  }) as typeof setTimeout);
  return { delays, restore: () => { timer.mockRestore(); } };
}

/** Waits for a condition; throws after `ms` so a test fails instead of hanging with its spies installed. */
async function until(condition: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await Bun.sleep(2);
  }
}

function imageProvider(baseUrl: string, maxResponseBytes = 50 * 1024 * 1024, samplerClass = 'KSampler',
  graph: Record<string, unknown> = { ...IMG_GRAPH, '8': { class_type: samplerClass, inputs: {} } }) {
  return createComfyuiProvider({
    baseUrl,
    privacy: privateWorkerTestPrivacy,
    workflowText: JSON.stringify(graph),
    maxResponseBytes,
    saveImageNodeId: '9',
    requiredPlaceholders: [],
    ratioDims: { '1:1': { width: 1024, height: 1024 } },
    modelId: 'krea-2-gonzalomo',
    requiredModelFiles: [],
    outputKind: 'image',
  });
}

const REQ: ProviderRequest = { prompt: 'x', modelId: 'krea-2-gonzalomo', ratio: '1:1', tileIndex: 0, seed: 1, count: 3 };

test('progress_state validates prompt/node identities and deduplicates progress frames', async () => {
  const provider = imageProvider(startMock({ saveNode: '9', count: 3, previewCount: 3, progressState: true }));
  const progress: number[] = [];
  const results = await Array.fromAsync(provider.generate(REQ, AbortSignal.timeout(2000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS,
    onProgress: (event) => { progress.push(event.progress); },
  }));
  expect(progress).toEqual([1 / 3, 2 / 3, 1]);
  expect(results.filter((event) => event.status === 'ready')).toHaveLength(3);
});

test('native progress_state requires matching identities and running/finished states', async () => {
  const provider = imageProvider(startMock({ saveNode: '9', count: 3, previewCount: 3,
    progressState: true, nativeProgressOnly: true }));
  const progress: number[] = [];
  const results = await Array.fromAsync(provider.generate(REQ, AbortSignal.timeout(2000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS,
    onProgress: (event) => { progress.push(event.progress); },
  }));
  expect(progress).toEqual([1 / 3, 2 / 3, 1]);
  expect(results.filter((event) => event.status === 'ready')).toHaveLength(3);
});

for (const samplerClass of ['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced']) {
  test(`native ${samplerClass} progress ignores loader, VAE, selector and save completion fractions`, async () => {
    const provider = imageProvider(startMock({ saveNode: '9', count: 3, previewCount: 3,
      progressState: true, nativeProgressOnly: true, nonSamplerProgress: true }), undefined, samplerClass);
    const progress: number[] = [];
    const results = await Array.fromAsync(provider.generate(REQ, AbortSignal.timeout(2000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS,
      onProgress: (event) => { progress.push(event.progress); },
    }));
    expect(progress).toEqual([1 / 3, 2 / 3, 1]);
    expect(results.filter((event) => event.status === 'ready')).toHaveLength(3);
  });
}

test('socket connection timeout does not prevent authoritative recovery', async () => {
  // The upgrade is held for the whole job, so every open attempt reaches the
  // (shortened) four-second cap and recovery runs on lease status alone. No
  // job deadline races the status-poll cadence; the test timeout bounds a hang.
  const mock = startScripted({ holdSockets: true, onPrompt: (promptId, worker) => { worker.complete(promptId, [PNG_1x1, PNG_1x1, PNG_1x1]); } });
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => nativeTimeout(ms === 4_000 ? 10 : ms));
  try {
    const signal = new AbortController().signal;
    const results = await Array.fromAsync(imageProvider(mock.baseUrl).generate(REQ, signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    expect(results.map((event) => event.status)).toEqual(['ready', 'ready', 'ready']);
    expect(mock.state.socketAttempts).toBeGreaterThanOrEqual(1);
    expect(mock.state.opens).toBe(0);
  } finally { timeout.mockRestore(); mock.releaseSockets(); }
});

for (const delayed of ['headers', 'body'] as const) {
  test(`ambiguous submission ${delayed} recovers through current lease status`, async () => {
    const provider = imageProvider(startMock({ saveNode: '9', count: 3, completionDelayMs: 100 }));
    const nativeFetch = globalThis.fetch;
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const submissionTimeouts: number[] = [];
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      if (ms === 8_000) submissionTimeouts.push(ms);
      return nativeTimeout(ms === 8_000 ? 10 : ms);
    });
    let acknowledged = false;
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await nativeFetch(input, init);
      if (new URL(input instanceof Request ? input.url : input).pathname !== '/prompt') return response;
      if (delayed === 'headers') {
        await new Promise<void>((resolve) => { setTimeout(resolve, 40); });
        init?.signal?.throwIfAborted();
        acknowledged = true;
        return response;
      }
      const body = new Uint8Array(await response.arrayBuffer());
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(body.subarray(0, 1));
          await new Promise<void>((resolve) => { setTimeout(resolve, 40); });
          if (init?.signal?.aborted) return;
          acknowledged = true;
          controller.enqueue(body.subarray(1));
          controller.close();
        },
      }), { status: response.status });
    }, { preconnect: nativeFetch.preconnect }));
    try {
      const results = await Array.fromAsync(provider.generate(REQ, AbortSignal.timeout(2000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
      expect(results.map((event) => event.status)).toEqual(['ready', 'ready', 'ready']);
      expect(acknowledged).toBe(false);
      expect(submissionTimeouts).toEqual([8_000]);
    } finally { fetch.mockRestore(); timeout.mockRestore(); }
  });
}

for (const identity of ['prompt', 'node'] as const) {
  test(`metadata preview with wrong ${identity} is discarded`, async () => {
    const provider = imageProvider(startMock({ saveNode: '9', count: 3, previewCount: 2,
      previewWithMetadata: true, badPreviewIdentity: identity }));
    const results = await Array.fromAsync(provider.generate(REQ, AbortSignal.timeout(2000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    expect(results.filter((event) => event.status === 'partial')).toHaveLength(0);
    expect(results.filter((event) => event.status === 'ready')).toHaveLength(3);
  });
}

test('execution_success triggers authoritative status without executing(null)', async () => {
  const provider = imageProvider(startMock({ saveNode: '9', count: 3, successEvent: true }));
  const results = await Array.fromAsync(provider.generate(REQ, AbortSignal.timeout(2000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
  expect(results.map((event) => event.status)).toEqual(['ready', 'ready', 'ready']);
});

test('execution_interrupted fails every requested index promptly', async () => {
  const provider = imageProvider(startMock({ saveNode: '9', count: 3, interrupted: true }));
  const results = await Array.fromAsync(provider.generate(REQ, AbortSignal.timeout(2000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
  expect(results).toMatchObject([{ status: 'failed', index: 0 }, { status: 'failed', index: 1 }, { status: 'failed', index: 2 }]);
});

test('maps ordered memory images to indices despite redundant socket payloads', async () => {
  const provider = imageProvider(startMock({ saveNode: '9', count: 3 }));
  const results = [];
  for await (const r of provider.generate(REQ, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) results.push(r);
  const ready = results.filter((r) => r.status === 'ready');
  expect(ready).toHaveLength(3);
  expect(ready.map((r) => r.index).sort()).toEqual([0, 1, 2]);
  for (const r of ready) {
    expect(r.mime).toBe('image/png');
    expect(Array.from(r.bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }
});

test('streams bounded sampler previews before terminal memory images', async () => {
  const provider = imageProvider(startMock({ saveNode: '9', count: 3, previewCount: 20 }));
  const results = [];
  for await (const r of provider.generate(REQ, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) results.push(r);

  const partials = results.filter((r) => r.status === 'partial');
  const ready = results.filter((r) => r.status === 'ready');
  expect(partials).toHaveLength(5);
  expect(partials.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
  expect(partials.every((r) => r.batchIndex === 0)).toBe(true);
  expect(partials.every((r) => r.preview.startsWith('data:image/png;base64,'))).toBe(true);
  expect(ready).toHaveLength(3);
  expect(results.findIndex((r) => r.status === 'partial')).toBeLessThan(results.findIndex((r) => r.status === 'ready'));
});

test('accepts PREVIEW_IMAGE_WITH_METADATA node-context frames', async () => {
  const provider = imageProvider(startMock({
    saveNode: '9',
    count: 1,
    previewCount: 1,
    previewWithMetadata: true,
  }));
  const results = [];
  for await (const r of provider.generate({ ...REQ, count: 1 }, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) results.push(r);

  expect(results[0]).toMatchObject({ status: 'partial', index: 0, batchIndex: 0 });
  expect(results[1]).toMatchObject({ status: 'ready', index: 0, mime: 'image/png' });
});

test('mid-stream websocket close retains authoritative memory recovery', async () => {
  const provider = imageProvider(startMock({ saveNode: '9', count: 3, dropAfter: 1 }));
  const results = [];
  for await (const r of provider.generate(REQ, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) results.push(r);
  expect(results).toHaveLength(3);
  expect(results.map((result) => result.index)).toEqual([0, 1, 2]);
  expect(results.every((result) => result.status === 'ready')).toBe(true);
});

test('empty completed memory output fails despite socket completion', async () => {
  const provider = imageProvider(startMock({ saveNode: '9', count: 0 }));
  const results = [];
  for await (const r of provider.generate({ ...REQ, count: 1 }, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) results.push(r);
  expect(results[0]?.status).toBe('failed');
});

test('oversized advertised memory output fails before download', async () => {
  // payload 5000 bytes > 1000-byte cap → frame dropped, job fails at terminal.
  const provider = imageProvider(startMock({ saveNode: '9', count: 1, payloadBytes: 5000 }), 1000);
  const results = [];
  for await (const r of provider.generate({ ...REQ, count: 1 }, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) results.push(r);
  expect(results).toHaveLength(1);
  expect(results[0]?.status).toBe('failed');
});

test('incomplete memory output batch fails all requested indices', async () => {
  // count=3 requested, mock emits only 2 frames before the terminal.
  const provider = imageProvider(startMock({ saveNode: '9', count: 2 }));
  const results = [];
  for await (const r of provider.generate(REQ, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) results.push(r);
  const ready = results.filter((r) => r.status === 'ready');
  const failed = results.filter((r) => r.status === 'failed');
  expect(ready).toHaveLength(0);
  expect(failed).toHaveLength(3);
  expect(failed.map((result) => result.index)).toEqual([0, 1, 2]);
});

// A two-pass graph: base sampler (25 steps) → decode → upscale → encode →
// refine sampler (8 steps). Node ids deliberately sort against execution order.
const TWO_PASS_GRAPH = {
  '1': { class_type: 'UNETLoader', inputs: {} },
  '20': { class_type: 'KSampler', inputs: { model: ['1', 0], steps: 25, latent_image: ['3', 0] } },
  '3': { class_type: 'EmptyLatentImage', inputs: {} },
  '4': { class_type: 'VAEDecode', inputs: { samples: ['20', 0] } },
  '5': { class_type: 'ImageScaleBy', inputs: { image: ['4', 0] } },
  '6': { class_type: 'VAEEncode', inputs: { pixels: ['5', 0] } },
  '10': { class_type: 'KSampler', inputs: { model: ['1', 0], steps: 8, denoise: 0.15, latent_image: ['6', 0] } },
  '11': { class_type: 'VAEDecode', inputs: { samples: ['10', 0] } },
  '9': { class_type: 'SaveImageWebsocket', inputs: { images: ['11', 0] } },
};

function steps(promptId: string, node: string, max: number): unknown[] {
  return [
    { type: 'executing', data: { node, prompt_id: promptId } },
    ...Array.from({ length: max }, (_, i) => ({ type: 'progress', data: { node, prompt_id: promptId, value: i + 1, max } })),
  ];
}

function collectProgress(provider: ReturnType<typeof imageProvider>, count = 1) {
  const events: ProviderProgress[] = [];
  const run = Array.fromAsync(provider.generate({ ...REQ, count }, AbortSignal.timeout(2000), {
    executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS,
    onProgress: (event) => { events.push(event); },
  }));
  return { events, run };
}

test('two-pass sampler graph reports per-pass steps with weighted monotonic progress', async () => {
  const provider = imageProvider(startMock({ saveNode: '9', count: 1, frames: (id) => [
    ...steps(id, '20', 25),
    // A late "finished" snapshot of pass 1 must not rewind the readout.
    { type: 'progress_state', data: { prompt_id: id, nodes: { '20': { node_id: '20', prompt_id: id, state: 'finished', value: 25, max: 25 } } } },
    { type: 'progress', data: { node: '5', prompt_id: id, value: 1, max: 4 } },
    ...steps(id, '10', 8),
  ] }), undefined, undefined, TWO_PASS_GRAPH);
  const { events, run } = collectProgress(provider);
  await run;
  expect(events).toHaveLength(33);
  expect(events[0]).toEqual({ progress: 1 / 33, phase: '20', step: 1, totalSteps: 25, pass: 1, passCount: 2 });
  expect(events[24]).toEqual({ progress: 25 / 33, phase: '20', step: 25, totalSteps: 25, pass: 1, passCount: 2 });
  expect(events[25]).toEqual({ progress: 26 / 33, phase: '10', step: 1, totalSteps: 8, pass: 2, passCount: 2 });
  expect(events[32]).toEqual({ progress: 1, phase: '10', step: 8, totalSteps: 8, pass: 2, passCount: 2 });
  const fractions = events.map((event) => event.progress);
  expect(fractions).toEqual(fractions.toSorted((a, b) => a - b));
});

test('a pass start snapshot (value 0, max 1) does not reweight the passes', async () => {
  // ComfyUI's progress registry announces each node start as value 0 / max 1
  // before the sampler reports its real step count.
  const start = (id: string, node: string) => ({ type: 'progress_state', data: { prompt_id: id, nodes: {
    [node]: { node_id: node, prompt_id: id, state: 'running', value: 0, max: 1 },
  } } });
  const provider = imageProvider(startMock({ saveNode: '9', count: 1, frames: (id) => [
    start(id, '20'),
    ...steps(id, '20', 25),
    start(id, '10'),
    ...steps(id, '10', 8),
  ] }), undefined, undefined, TWO_PASS_GRAPH);
  const { events, run } = collectProgress(provider);
  await run;
  expect(events).toHaveLength(33);
  expect(events[25]).toEqual({ progress: 26 / 33, phase: '10', step: 1, totalSteps: 8, pass: 2, passCount: 2 });
  expect(events.map((event) => event.step)).not.toContain(0);
});

test('branch samplers take pass numbers in the order they actually run', async () => {
  // Two independent sampler branches feed one output; ComfyUI may run either
  // first, so neither may be treated as a stale earlier pass.
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: {} },
    '3': { class_type: 'EmptyLatentImage', inputs: {} },
    '20': { class_type: 'KSampler', inputs: { model: ['1', 0], steps: 4, latent_image: ['3', 0] } },
    '21': { class_type: 'KSampler', inputs: { model: ['1', 0], steps: 2, latent_image: ['3', 0] } },
    // Any allowed two-input node joins the branches; the mock never executes it.
    '11': { class_type: 'VAEDecode', inputs: { samples: ['20', 0] } },
    '12': { class_type: 'VAEDecode', inputs: { samples: ['21', 0] } },
    '30': { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['12', 0] } },
    '13': { class_type: 'VAEDecode', inputs: { samples: ['30', 0] } },
    '9': { class_type: 'SaveImageWebsocket', inputs: { images: ['13', 0] } },
  };
  const provider = imageProvider(startMock({ saveNode: '9', count: 1, frames: (id) => [
    ...steps(id, '21', 2),
    ...steps(id, '20', 4),
  ] }), undefined, undefined, graph);
  const { events, run } = collectProgress(provider);
  await run;
  expect(events.map((event) => [event.pass, event.step, event.totalSteps])).toEqual([
    [1, 1, 2], [1, 2, 2], [2, 1, 4], [2, 2, 4], [2, 3, 4], [2, 4, 4],
  ]);
  expect(events.map((event) => event.progress)).toEqual([1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1]);
});

test('a finished pass first seen after a reconnect slots in before the running pass', async () => {
  // The socket missed pass 1 entirely and joins during pass 2; the next
  // progress_state still lists pass 1 as finished.
  const snapshot = (id: string) => ({ type: 'progress_state', data: { prompt_id: id, nodes: {
    '20': { node_id: '20', prompt_id: id, state: 'finished', value: 25, max: 25 },
    '10': { node_id: '10', prompt_id: id, state: 'running', value: 3, max: 8 },
  } } });
  const provider = imageProvider(startMock({ saveNode: '9', count: 1, frames: (id) => [
    { type: 'executing', data: { node: '10', prompt_id: id } },
    ...[1, 2, 3].map((value) => ({ type: 'progress', data: { node: '10', prompt_id: id, value, max: 8 } })),
    snapshot(id),
    ...[4, 5, 6, 7, 8].map((value) => ({ type: 'progress', data: { node: '10', prompt_id: id, value, max: 8 } })),
  ] }), undefined, undefined, TWO_PASS_GRAPH);
  const { events, run } = collectProgress(provider);
  await run;
  expect(events.every((event) => event.phase === '10')).toBe(true);
  expect(events.at(3)).toEqual({ progress: 29 / 33, phase: '10', step: 4, totalSteps: 8, pass: 2, passCount: 2 });
  expect(events.at(-1)).toEqual({ progress: 1, phase: '10', step: 8, totalSteps: 8, pass: 2, passCount: 2 });
});

test('a finished pass first seen after the current pass completed is the newest pass', async () => {
  // Pass 1 completed on the socket, pass 2 ran unseen; the snapshot lists
  // both finished, so pass 2 is the latest and the readout reaches the end.
  const provider = imageProvider(startMock({ saveNode: '9', count: 1, frames: (id) => [
    ...steps(id, '20', 25),
    { type: 'progress_state', data: { prompt_id: id, nodes: {
      '20': { node_id: '20', prompt_id: id, state: 'finished', value: 25, max: 25 },
      '10': { node_id: '10', prompt_id: id, state: 'finished', value: 8, max: 8 },
    } } },
  ] }), undefined, undefined, TWO_PASS_GRAPH);
  const { events, run } = collectProgress(provider);
  await run;
  expect(events.at(-1)).toEqual({ progress: 1, phase: '10', step: 8, totalSteps: 8, pass: 2, passCount: 2 });
});

test('a sampler that feeds no output is not counted as a pass', async () => {
  const graph = { ...TWO_PASS_GRAPH, '10': { class_type: 'KSampler', inputs: { steps: 8, latent_image: ['3', 0] } },
    '11': { class_type: 'VAEDecode', inputs: { samples: ['20', 0] } } };
  const provider = imageProvider(startMock({ saveNode: '9', count: 1, frames: (id) => [
    ...steps(id, '20', 25),
  ] }), undefined, undefined, graph);
  const { events, run } = collectProgress(provider);
  await run;
  expect(events.at(-1)).toEqual({ progress: 1, phase: '20', step: 25, totalSteps: 25, pass: 1, passCount: 1 });
});

test('runtime max replaces the planned step count of the running pass', async () => {
  const provider = imageProvider(startMock({ saveNode: '9', count: 1, frames: (id) => [
    ...steps(id, '20', 20),
    ...steps(id, '10', 8),
  ] }), undefined, undefined, TWO_PASS_GRAPH);
  const { events, run } = collectProgress(provider);
  await run;
  expect(events[19]).toMatchObject({ progress: 20 / 28, step: 20, totalSteps: 20, pass: 1 });
  expect(events.at(-1)).toMatchObject({ progress: 1, step: 8, totalSteps: 8, pass: 2 });
});

test('unknown planned steps weight sampler passes equally', async () => {
  const graph = { ...TWO_PASS_GRAPH, '10': { class_type: 'KSampler', inputs: { latent_image: ['6', 0], steps: ['99', 0] } } };
  const provider = imageProvider(startMock({ saveNode: '9', count: 1, frames: (id) => [
    ...steps(id, '20', 4),
    ...steps(id, '10', 2),
  ] }), undefined, undefined, graph);
  const { events, run } = collectProgress(provider);
  await run;
  expect(events.map((event) => event.progress)).toEqual([0.125, 0.25, 0.375, 0.5, 0.75, 1]);
});

test('non-sampler node progress is ignored when the graph has samplers', async () => {
  const provider = imageProvider(startMock({ saveNode: '9', count: 1, frames: (id) => [
    ...steps(id, '20', 25),
    { type: 'executing', data: { node: '11', prompt_id: id } },
    { type: 'progress', data: { node: '11', prompt_id: id, value: 1, max: 4 } },
    { type: 'progress', data: { prompt_id: id, value: 2, max: 4 } },
  ] }), undefined, undefined, TWO_PASS_GRAPH);
  const { events, run } = collectProgress(provider);
  await run;
  expect(events).toHaveLength(25);
  expect(events.every((event) => event.phase === '20')).toBe(true);
});

test('a graph without recognized samplers keeps fraction-only progress', async () => {
  const graph = {
    '1': { class_type: 'VAELoader', inputs: {} },
    '2': { class_type: 'VAEDecode', inputs: { vae: ['1', 0] } },
    '9': { class_type: 'SaveImageWebsocket', inputs: { images: ['2', 0] } },
  };
  const provider = imageProvider(startMock({ saveNode: '9', count: 1, frames: (id) => [
    { type: 'executing', data: { node: '2', prompt_id: id } },
    { type: 'progress', data: { node: '2', prompt_id: id, value: 1, max: 2 } },
    { type: 'progress', data: { node: '2', prompt_id: id, value: 2, max: 2 } },
  ] }), undefined, undefined, graph);
  const { events, run } = collectProgress(provider);
  await run;
  expect(events).toEqual([{ progress: 0.5, phase: '2' }, { progress: 1, phase: '2' }]);
});

test('SamplerCustomAdvanced planned steps resolve through sigmas to the scheduler', async () => {
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: {} },
    '7': { class_type: 'BasicScheduler', inputs: { model: ['1', 0], steps: 6 } },
    '8': { class_type: 'KSamplerSelect', inputs: {} },
    '3': { class_type: 'EmptyLatentImage', inputs: {} },
    '12': { class_type: 'KSampler', inputs: { steps: 2, latent_image: ['3', 0] } },
    '4': { class_type: 'VAEDecode', inputs: { samples: ['12', 0] } },
    '5': { class_type: 'VAEEncode', inputs: { pixels: ['4', 0] } },
    '11': { class_type: 'SamplerCustomAdvanced', inputs: { sampler: ['8', 0], sigmas: ['7', 0], latent_image: ['5', 0] } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['11', 0] } },
    '9': { class_type: 'SaveImageWebsocket', inputs: { images: ['6', 0] } },
  };
  const provider = imageProvider(startMock({ saveNode: '9', count: 1, frames: (id) => [
    // While pass 1 runs, the not-yet-started custom sampler weighs in with
    // the scheduler's planned six steps (equal weighting would give 1/4).
    ...steps(id, '12', 2),
  ] }), undefined, undefined, graph);
  const { events, run } = collectProgress(provider);
  await run;
  expect(events).toEqual([
    { progress: 1 / 8, phase: '12', step: 1, totalSteps: 2, pass: 1, passCount: 2 },
    { progress: 2 / 8, phase: '12', step: 2, totalSteps: 2, pass: 1, passCount: 2 },
  ]);
});

test('preview buckets follow overall progress across passes', async () => {
  // Five previews during pass 1 (steps 1..25), then previews during pass 2.
  // With per-pass fractions pass 1 would spend the whole budget; overall
  // progress leaves later buckets for the refine pass.
  const preview = frameWithHeader(PNG_1x1);
  // Same image, different IHDR CRC byte: distinguishable, still a valid sniff.
  const refinePng = PNG_1x1.slice();
  refinePng[29] = (refinePng[29] ?? 0) ^ 0xff;
  const refinePreview = frameWithHeader(refinePng);
  const provider = imageProvider(startMock({ saveNode: '9', count: 1, frames: (id) => [
    { type: 'executing', data: { node: '20', prompt_id: id } },
    ...Array.from({ length: 25 }, (_, i) => [
      { type: 'progress', data: { node: '20', prompt_id: id, value: i + 1, max: 25 } }, preview,
    ]).flat(),
    { type: 'executing', data: { node: '10', prompt_id: id } },
    ...Array.from({ length: 8 }, (_, i) => [
      { type: 'progress', data: { node: '10', prompt_id: id, value: i + 1, max: 8 } }, refinePreview,
    ]).flat(),
  ] }), undefined, undefined, TWO_PASS_GRAPH);
  const results = await Array.fromAsync(provider.generate({ ...REQ, count: 1 }, AbortSignal.timeout(2000), {
    executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS,
  }));
  const partials = results.filter((r) => r.status === 'partial');
  expect(partials).toHaveLength(5);
  // 25/33 ≈ 0.76 → pass 1 can reach bucket 3 at most; bucket 4 belongs to pass 2.
  const refineUrl = `data:image/png;base64,${Buffer.from(refinePng).toString('base64')}`;
  expect(partials.map((r) => r.preview === refineUrl)).toEqual([false, false, false, false, true]);
});

test('previews resume after a reconnect from the replayed executing frame', async () => {
  // ComfyUI replays the running node to a reconnecting client without a
  // prompt_id; previews on the new socket must keep flowing.
  const mock = startScripted({
    onPrompt: (promptId, _worker, state) => {
      const ws = state.socket;
      if (!ws) throw new Error('socket not open');
      ws.send(JSON.stringify({ type: 'executing', data: { node: '8', prompt_id: promptId } }));
      ws.send(JSON.stringify({ type: 'progress', data: { node: '8', prompt_id: promptId, value: 1, max: 5 } }));
      ws.send(frameWithHeader(PNG_1x1));
      ws.close();
    },
    onOpen: (ws, connection, state) => {
      const promptId = state.promptId;
      if (connection !== 2 || promptId === undefined) return;
      ws.send(JSON.stringify({ type: 'executing', data: { node: '8' } }));
      ws.send(JSON.stringify({ type: 'progress', data: { node: '8', prompt_id: promptId, value: 3, max: 5 } }));
      ws.send(frameWithHeader(PNG_1x1));
      state.worker.complete(promptId, [PNG_1x1]);
      ws.send(JSON.stringify({ type: 'executing', data: { node: null, prompt_id: promptId } }));
    },
  });
  const results = await Array.fromAsync(imageProvider(mock.baseUrl).generate({ ...REQ, count: 1 }, new AbortController().signal,
    { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
  expect(mock.state.opens).toBe(2);
  expect(results.map((r) => r.status)).toEqual(['partial', 'partial', 'ready']);
});

test('reconnect attempts back off from 250 ms, doubling, and stop after three failures', async () => {
  const timers = recordTimers({ 250: 1, 500: 1 });
  const mock = startScripted({ refuseSockets: true });
  try {
    const run = Array.fromAsync(imageProvider(mock.baseUrl).generate({ ...REQ, count: 1 }, new AbortController().signal,
      { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    await until(() => mock.state.socketAttempts >= 4 && mock.state.promptId !== undefined);
    const promptId = mock.state.promptId;
    if (promptId !== undefined) mock.state.worker.complete(promptId, [PNG_1x1]);
    expect((await run).map((r) => r.status)).toEqual(['ready']);
  } finally { timers.restore(); }
  expect(mock.state.socketAttempts).toBe(4);
  expect(timers.delays.filter((ms) => ms === 250 || ms === 500 || ms === 2_000)).toEqual([250, 500]);
});

test('a reopened socket that delivers a frame restores the reconnect budget', async () => {
  // Four drops in a row, each after the server's greeting frame: with the
  // budget reset per delivered frame the fifth socket still opens.
  const timers = recordTimers({ 250: 1 });
  const mock = startScripted({
    onOpen: (ws, connection) => {
      ws.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 1 } } } }));
      if (connection < 5) setTimeout(() => { ws.close(); }, 5);
    },
  });
  try {
    const run = Array.fromAsync(imageProvider(mock.baseUrl).generate({ ...REQ, count: 1 }, new AbortController().signal,
      { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    await until(() => mock.state.promptId !== undefined);
    // A spent budget never opens the fifth socket; stop waiting after a second.
    await until(() => mock.state.opens >= 5, 1_000).catch(() => undefined);
    const promptId = mock.state.promptId;
    if (promptId !== undefined) mock.state.worker.complete(promptId, [PNG_1x1]);
    expect((await run).map((r) => r.status)).toEqual(['ready']);
  } finally { timers.restore(); }
  expect(mock.state.opens).toBe(5);
});

describe('lease status cadence', () => {
  let restoreClock = () => { /* Replaced per test. */ };
  afterEach(() => { restoreClock(); });

  /** Shifts performance.now() forward by `skew.ms` to stand in for elapsed job time. */
  function skewClock() {
    const skew = { ms: 0 };
    const realNow = performance.now.bind(performance);
    const clock = spyOn(performance, 'now').mockImplementation(() => realNow() + skew.ms);
    restoreClock = () => { clock.mockRestore(); };
    return skew;
  }

  test('an open socket polls every second for the first 30 s of a running job, then every 5 s', async () => {
    const skew = skewClock();
    const timers = recordTimers({ 1_000: 10, 5_000: 10 });
    const mock = startScripted({ onPrompt: (promptId, worker) => { worker.running(promptId); } });
    try {
      const run = Array.fromAsync(imageProvider(mock.baseUrl).generate({ ...REQ, count: 1 }, new AbortController().signal,
        { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
      await until(() => mock.state.statusReads >= 3);
      expect(timers.delays).not.toContain(5_000);
      skew.ms = 31_000;
      await until(() => timers.delays.includes(5_000));
      const promptId = mock.state.promptId;
      if (promptId === undefined) throw new Error('prompt not submitted');
      mock.state.worker.complete(promptId, [PNG_1x1]);
      mock.state.socket?.send(JSON.stringify({ type: 'executing', data: { node: null, prompt_id: promptId } }));
      expect((await run).map((r) => r.status)).toEqual(['ready']);
    } finally { timers.restore(); }
  });

  test('a closed socket keeps one-second polling however long the job runs', async () => {
    const skew = skewClock();
    const timers = recordTimers({ 1_000: 10, 250: 1, 500: 1 });
    const mock = startScripted({ refuseSockets: true, onPrompt: (promptId, worker) => { worker.running(promptId); } });
    try {
      const run = Array.fromAsync(imageProvider(mock.baseUrl).generate({ ...REQ, count: 1 }, new AbortController().signal,
        { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
      await until(() => mock.state.statusReads >= 2);
      skew.ms = 31_000;
      const reads = mock.state.statusReads;
      await until(() => mock.state.statusReads >= reads + 3);
      const promptId = mock.state.promptId;
      if (promptId === undefined) throw new Error('prompt not submitted');
      mock.state.worker.complete(promptId, [PNG_1x1]);
      expect((await run).map((r) => r.status)).toEqual(['ready']);
    } finally { timers.restore(); }
    expect(timers.delays).not.toContain(5_000);
  });

  test('a socket close cuts a slow status wait back to one second at once', async () => {
    const skew = skewClock();
    // A slow wait that is not cut short would outlast the test timeout.
    const timers = recordTimers({ 1_000: 10, 5_000: 60_000, 250: 1, 500: 1 });
    let refuse = false;
    const mock = startScripted({
      onOpen: (ws) => { if (refuse) ws.close(); },
      onPrompt: (promptId, worker) => { worker.running(promptId); },
    });
    try {
      const run = Array.fromAsync(imageProvider(mock.baseUrl).generate({ ...REQ, count: 1 }, new AbortController().signal,
        { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
      await until(() => mock.state.statusReads >= 2);
      skew.ms = 31_000;
      await until(() => timers.delays.includes(5_000));
      const promptId = mock.state.promptId;
      if (promptId === undefined) throw new Error('prompt not submitted');
      mock.state.worker.complete(promptId, [PNG_1x1]);
      refuse = true;
      mock.state.socket?.close();
      let settled = false;
      void run.finally(() => { settled = true; });
      await until(() => settled);
      expect((await run).map((r) => r.status)).toEqual(['ready']);
    } finally { timers.restore(); }
  });
});
