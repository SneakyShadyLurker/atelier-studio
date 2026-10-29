import { afterEach, expect, spyOn, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { createComfyuiProvider, drainComfyUi } from './comfyui';
import { TEST_EXECUTION_TIMEOUT_MS, privateWorkerFixture, privateWorkerTestPrivacy, privateWorkerTestTls } from '../test/private-worker-fixture';
import type { ProviderRequest } from './types';

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
  socketOpenDelayMs?: number;
}): string {
  const worker = privateWorkerFixture();
  const sockets = new Map<string, ServerWebSocket<{ clientId: string }>>();
  const server = Bun.serve<{ clientId: string }>({
    port: 0,
    tls: privateWorkerTestTls,
    idleTimeout: 0,
    async fetch(req, srv) {
      const handled = worker.handle(req);
      if (handled) return handled;
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (opts.socketOpenDelayMs !== undefined) {
          await new Promise<void>((resolve) => { setTimeout(resolve, opts.socketOpenDelayMs); });
        }
        const clientId = url.searchParams.get('clientId') ?? '';
        return srv.upgrade(req, { data: { clientId } }) ? undefined : new Response('upgrade', { status: 426 });
      }
      if (url.pathname === '/free') return new Response(null, { status: 200 });
      if (url.pathname === '/system_stats') return Response.json({ devices: [{ vram_total: 100, vram_free: 95 }] });
      if (url.pathname === '/prompt' && req.method === 'POST') {
        return req.json().then((body) => {
          expect((body as { extra_data?: unknown }).extra_data).toEqual({ preview_method: 'auto' });
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

function imageProvider(baseUrl: string, maxResponseBytes = 50 * 1024 * 1024, samplerClass = 'KSampler') {
  return createComfyuiProvider({
    baseUrl,
    privacy: privateWorkerTestPrivacy,
    workflowText: JSON.stringify({ ...IMG_GRAPH, '8': { class_type: samplerClass, inputs: {} } }),
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
  const provider = imageProvider(startMock({ saveNode: '9', count: 3, socketOpenDelayMs: 40 }));
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => nativeTimeout(ms === 4_000 ? 10 : ms));
  try {
    const signal = AbortSignal.timeout(2_000);
    const results = await Array.fromAsync(provider.generate(REQ, signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    expect(results.map((event) => event.status)).toEqual(['ready', 'ready', 'ready']);
    expect(signal.aborted).toBe(false);
  } finally { timeout.mockRestore(); }
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
