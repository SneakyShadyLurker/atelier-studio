import { afterEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { __resetComfyuiResidentModels, createComfyuiProvider, drainComfyUi } from './comfyui';
import { TEST_EXECUTION_TIMEOUT_MS, currentWorkerPrivacy, privateWorkerFixture, privateWorkerTestPrivacy, privateWorkerTestServerOptions } from '../test/private-worker-fixture';
import type { Provider, ProviderRequest, ProviderResult } from './types';

interface Node {
  class_type: string;
  inputs: Record<string, unknown>;
}

const BASE_GRAPH = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
  '2': { class_type: 'EmptySD3LatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{count}}' } },
  '3': { class_type: 'KSampler', inputs: { seed: '{{seed}}' } },
  '9': { class_type: 'SaveImageWebsocket', inputs: { images: ['3', 0] } },
};
const REFERENCE_GRAPH = {
  ...BASE_GRAPH,
  '4': { class_type: 'LoadImage', inputs: { image: '{{referenceImage}}' } },
  '5': { class_type: 'Krea2OstrisEditModelPatch', inputs: { model: ['3', 0], kv_cache: true } },
  '6': { class_type: 'TextEncodeKrea2OstrisEdit', inputs: { image1: ['4', 0], prompt: '{{prompt}}' } },
};
const REQUIRED = ['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{count}}'];
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC'),
  (c) => c.charCodeAt(0),
);
const REQUEST: ProviderRequest = {
  prompt: 'portrait', modelId: 'krea-2-gonzalomo', seed: 7, ratio: '1:1', tileIndex: 0, count: 1,
};
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await drainComfyUi();
  __resetComfyuiResidentModels();
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

/** `holdUploads`: each input PUT waits (up to one second) until that many are in flight. */
function startMock(metadata = currentWorkerPrivacy, uploadControl: { holdUploads?: number; rejectUpload?: number } = {}) {
  const worker = privateWorkerFixture();
  let arrived = 0;
  let releaseUploads = () => { /* Replaced when uploads are held. */ };
  const uploadsReleased = new Promise<void>((resolve) => { releaseUploads = resolve; });
  const sockets = new Map<string, ServerWebSocket<{ clientId: string }>>();
  const state = {
    log: [] as string[],
    uploads: [] as { token: string; bytes: Uint8Array }[],
    prompt: undefined as Record<string, Node> | undefined,
    ostrisAvailable: true,
    maxUploadsInFlight: 0,
  };
  let uploadsInFlight = 0;
  const server = Bun.serve<{ clientId: string }>({
    port: 0,
    ...privateWorkerTestServerOptions,
    idleTimeout: 0,
    async fetch(req, srv) {
      if (new URL(req.url).pathname === '/atelier/v1/privacy') return Response.json(metadata);
      const handled = worker.handle(req);
      if (handled) return handled;
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (srv.upgrade(req, { data: { clientId: url.searchParams.get('clientId') ?? '' } })) return undefined;
        return new Response('upgrade required', { status: 426 });
      }
      state.log.push(`${req.method} ${url.pathname}`);
      if (url.pathname === '/system_stats') {
        return Response.json({ devices: [{ vram_total: 100, vram_free: 95 }] });
      }
      if (url.pathname === '/object_info') {
        return Response.json(Object.fromEntries(Object.values(REFERENCE_GRAPH)
          .filter((node) => state.ostrisAvailable || !node.class_type.includes('Ostris'))
          .map((node) => [node.class_type === 'LoadImage' ? 'AtelierLoadImage' : node.class_type === 'SaveImageWebsocket' ? 'AtelierSaveImages' : node.class_type, {}])));
      }
      if (url.pathname === '/free') return Response.json({});
      if (/^\/atelier\/v1\/jobs\/[^/]+\/inputs\/[^/]+$/.test(url.pathname) && req.method === 'PUT') {
        const parts = url.pathname.split('/');
        const bytes = new Uint8Array(await req.arrayBuffer());
        arrived += 1;
        const order = arrived;
        uploadsInFlight += 1;
        state.maxUploadsInFlight = Math.max(state.maxUploadsInFlight, uploadsInFlight);
        if (uploadControl.holdUploads !== undefined) {
          if (arrived >= uploadControl.holdUploads) releaseUploads();
          await Promise.race([uploadsReleased, Bun.sleep(1_000)]);
        }
        uploadsInFlight -= 1;
        if (order === uploadControl.rejectUpload) return Response.json({ error: 'invalid_input' }, { status: 400 });
        state.uploads.push({ token: `${parts[4]}:${parts[6]}`, bytes });
        return Response.json({ ok: true });
      }
      if (url.pathname === '/prompt' && req.method === 'POST') {
        const body = await req.json() as { prompt: Record<string, Node>; client_id: string; prompt_id: string };
        state.prompt = body.prompt;
        setTimeout(() => {
          worker.complete(body.prompt_id, [PNG]);
          const ws = sockets.get(body.client_id);
          ws?.send(JSON.stringify({ type: 'executing', data: { node: '9', prompt_id: body.prompt_id } }));
          const frame = new Uint8Array(PNG.length + 8);
          const header = new DataView(frame.buffer);
          header.setUint32(0, 1, false);
          header.setUint32(4, 2, false);
          frame.set(PNG, 8);
          ws?.send(frame);
          ws?.send(JSON.stringify({ type: 'executing', data: { node: null, prompt_id: body.prompt_id } }));
        }, 5);
        return Response.json({ prompt_id: body.prompt_id, number: 0, node_errors: {} });
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) { sockets.set(ws.data.clientId, ws); },
      message() {
        // The adapter does not send websocket messages.
      },
      close(ws) { sockets.delete(ws.data.clientId); },
    },
  });
  stops.push(async () => { await server.stop(true); });
  return { state, baseUrl: `https://127.0.0.1:${server.port}` };
}

function providerFor(baseUrl: string, withReference = true, slots = 1): Provider {
  return createComfyuiProvider({
    baseUrl,
    privacy: privateWorkerTestPrivacy,
    workflowText: JSON.stringify(BASE_GRAPH),
    ...(withReference ? {
      referenceWorkflowText: JSON.stringify(slots === 1 ? REFERENCE_GRAPH : {
        ...REFERENCE_GRAPH,
        '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', 'images.image_1': ['4', 0], 'images.image_2': ['12', 0], 'images.image_3': ['13', 0] } },
        '12': { class_type: 'LoadImage', inputs: { image: '{{referenceImage2}}' } },
        '13': { class_type: 'LoadImage', inputs: { image: '{{referenceImage3}}' } },
        '14': { class_type: 'ImageScaleBy', inputs: { image: ['3', 0], upscale_method: 'lanczos', scale_by: '{{outputScale}}' } },
      }),
      referenceRequiredPlaceholders: [...REQUIRED, '{{referenceImage}}'],
      maxReferenceImages: slots,
      ...(slots === 1 ? {} : { referenceRatioDims: { '1:1': { width: 512, height: 768 } }, outputLongEdge: 384 }),
    } : {}),
    maxResponseBytes: 1024 * 1024,
    saveImageNodeId: '9',
    requiredPlaceholders: REQUIRED,
    requiredModelFiles: [],
    ratioDims: { '1:1': { width: 1024, height: 1024 } },
    modelId: REQUEST.modelId,
  });
}

async function collect(provider: Provider, request: ProviderRequest): Promise<ProviderResult[]> {
  const results: ProviderResult[] = [];
  for await (const result of provider.generate(request, AbortSignal.timeout(5000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) results.push(result);
  return results;
}

test('image reference uploads first, uses a job-owned token and gates reference node readiness', async () => {
  const { state, baseUrl } = startMock();
  const provider = providerFor(baseUrl);
  expect((await provider.healthCheck?.(AbortSignal.timeout(5000)))?.ok).toBe(true);
  state.ostrisAvailable = false;
  const health = await provider.healthCheck?.(AbortSignal.timeout(5000));
  expect(health).toMatchObject({ ok: false });
  if (health && !health.ok) expect(health.reason).toContain('Krea2OstrisEditModelPatch');
  state.ostrisAvailable = true;
  const results = await collect(provider, { ...REQUEST, refImages: [{ bytes: PNG, mime: 'image/png' }] });
  expect(results).toMatchObject([{ status: 'ready' }]);
  expect(state.uploads).toHaveLength(1);
  expect(state.uploads[0]?.bytes).toEqual(PNG);
  expect(state.uploads[0]?.token).toMatch(/^[0-9a-f-]{36}:[0-9a-f-]{36}$/);
  expect(state.log.findIndex((call) => call.startsWith('PUT /atelier/v1/jobs/'))).toBeLessThan(state.log.indexOf('POST /prompt'));
  expect(state.prompt?.['4']).toEqual({ class_type: 'AtelierLoadImage', inputs: { image: state.uploads[0]?.token } });
  expect(JSON.stringify(state.prompt)).not.toContain('{{');
});

test('a multi-slot graph uploads every reference concurrently, keeps slot order and drops the slots left empty', async () => {
  const { state, baseUrl } = startMock(currentWorkerPrivacy, { holdUploads: 2 });
  const second = new Uint8Array([...PNG, 2]);
  const results = await collect(providerFor(baseUrl, true, 3), {
    ...REQUEST,
    refImages: [{ bytes: PNG, mime: 'image/png' }, { bytes: second, mime: 'image/png' }],
  });
  expect(results).toMatchObject([{ status: 'ready' }]);
  expect(state.maxUploadsInFlight).toBe(2);
  const tokenOf = (bytes: Uint8Array) => state.uploads.find((upload) => upload.bytes.length === bytes.length)?.token;
  expect(state.uploads).toHaveLength(2);
  expect(state.prompt?.['4']).toEqual({ class_type: 'AtelierLoadImage', inputs: { image: tokenOf(PNG) } });
  expect(state.prompt?.['12']).toEqual({ class_type: 'AtelierLoadImage', inputs: { image: tokenOf(second) } });
  expect(state.prompt?.['13']).toBeUndefined();
  // The reference graph renders at its own size, not the base graph's.
  expect(state.prompt?.['2']?.inputs).toMatchObject({ width: 512, height: 768 });
  // The delivered long edge is taken against the size this request renders at.
  expect(state.prompt?.['14']?.inputs.scale_by).toBe(384 / 768);
  expect(state.prompt?.['1']).toEqual({
    class_type: 'CLIPTextEncode',
    inputs: { text: 'portrait', 'images.image_1': ['4', 0], 'images.image_2': ['12', 0] },
  });
  expect(JSON.stringify(state.prompt)).not.toContain('{{');
});

test('one failed reference upload fails the request before posting, with no stray rejection', async () => {
  const { state, baseUrl } = startMock(currentWorkerPrivacy, { holdUploads: 2, rejectUpload: 2 });
  const results = await collect(providerFor(baseUrl, true, 3), {
    ...REQUEST,
    refImages: [{ bytes: PNG, mime: 'image/png' }, { bytes: new Uint8Array([...PNG, 2]), mime: 'image/png' }],
  });
  expect(results).toMatchObject([{ status: 'failed', index: 0 }]);
  expect(state.maxUploadsInFlight).toBe(2);
  expect(state.log).not.toContain('POST /prompt');
  expect(state.prompt).toBeUndefined();
});

test('more references than the graph has slots fail before posting anything', async () => {
  const { state, baseUrl } = startMock();
  const refImages: NonNullable<ProviderRequest['refImages']> = [{ bytes: PNG, mime: 'image/png' }, { bytes: new Uint8Array([2]), mime: 'image/jpeg' }];
  expect(await collect(providerFor(baseUrl), { ...REQUEST, refImages }))
    .toMatchObject([{ status: 'failed', error: "model 'krea-2-gonzalomo' takes at most 1 reference images" }]);
  expect(state.log).toEqual([]);
  expect(state.prompt).toBeUndefined();
});

test('without references the unchanged base graph is submitted without an upload', async () => {
  const { state, baseUrl } = startMock();
  expect(await collect(providerFor(baseUrl), REQUEST)).toMatchObject([{ status: 'ready' }]);
  expect(state.uploads).toEqual([]);
  expect(state.log.some((call) => call.startsWith('PUT '))).toBe(false);
  expect(state.prompt).toEqual({
    ...BASE_GRAPH,
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'portrait' } },
    '2': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '3': { class_type: 'KSampler', inputs: { seed: 7 } },
    '9': { class_type: 'AtelierSaveImages', inputs: { images: ['3', 0], job_id: expect.any(String) } },
  });
});

for (const kind of ['count', 'input-size', 'payload-size'] as const) {
  test(`advertised ${kind} rejects before uploading references`, async () => {
    const { state, baseUrl } = startMock({ ...currentWorkerPrivacy,
      limits: { ...currentWorkerPrivacy.limits,
        ...(kind === 'count' ? { max_images: 1 } : kind === 'input-size' ? { max_image_bytes: 1 } : { max_payload_bytes: 1 }),
      } });
    const results = await collect(providerFor(baseUrl), { ...REQUEST, count: kind === 'count' ? 2 : 1,
      refImages: [{ bytes: PNG, mime: 'image/png' }] });
    expect(results.every((result) => result.status === 'failed')).toBe(true);
    expect(state.uploads).toHaveLength(0);
    expect(state.prompt).toBeUndefined();
    expect(state.log).not.toContain('POST /free');
  });
}

test('references without a reference graph fail before posting anything', async () => {
  const { state, baseUrl } = startMock();
  expect(await collect(providerFor(baseUrl, false), { ...REQUEST, refImages: [{ bytes: PNG, mime: 'image/png' }] }))
    .toMatchObject([{ status: 'failed', error: "model 'krea-2-gonzalomo' has no reference-image graph" }]);
  expect(state.log).toEqual([]);
  expect(state.prompt).toBeUndefined();
});

const SCALE_NODE = { class_type: 'ImageScaleBy', inputs: { image: ['3', 0], upscale_method: 'lanczos', scale_by: '{{outputScale}}' } };

/** A row offering render sizes: each graph ends in the `{{outputScale}}` downscale. */
function sizedProviderFor(baseUrl: string): Provider {
  return createComfyuiProvider({
    baseUrl,
    privacy: privateWorkerTestPrivacy,
    workflowText: JSON.stringify({ ...BASE_GRAPH, '14': SCALE_NODE }),
    referenceWorkflowText: JSON.stringify({ ...REFERENCE_GRAPH, '14': SCALE_NODE }),
    referenceRequiredPlaceholders: [...REQUIRED, '{{referenceImage}}'],
    maxReferenceImages: 1,
    referenceRatioDims: { '1:1': { width: 256, height: 256 } },
    resolutionDims: {
      '4mp': { '1:1': { width: 256, height: 256 } },
      '8mp': { '1:1': { width: 512, height: 640 } },
      '16mp': { '1:1': { width: 1024, height: 1024 } },
    },
    outputLongEdge: 128,
    maxResponseBytes: 1024 * 1024,
    saveImageNodeId: '9',
    requiredPlaceholders: REQUIRED,
    requiredModelFiles: [],
    ratioDims: { '1:1': { width: 1024, height: 1024 } },
    modelId: REQUEST.modelId,
  });
}

for (const withReferences of [false, true]) {
  const graph = withReferences ? 'reference' : 'base';
  const extra: Partial<ProviderRequest> = withReferences ? { refImages: [{ bytes: PNG, mime: 'image/png' }] } : {};

  test(`a requested render size picks its dims for the ${graph} graph and the output scale follows`, async () => {
    const { state, baseUrl } = startMock();
    expect(await collect(sizedProviderFor(baseUrl), { ...REQUEST, ...extra, resolution: '8mp' }))
      .toMatchObject([{ status: 'ready' }]);
    expect(state.prompt?.['4'] !== undefined).toBe(withReferences);
    expect(state.prompt?.['2']?.inputs).toMatchObject({ width: 512, height: 640 });
    expect(state.prompt?.['14']?.inputs.scale_by).toBe(128 / 640);
  });

  test(`without a requested size the ${graph} graph keeps its own default dims`, async () => {
    const { state, baseUrl } = startMock();
    expect(await collect(sizedProviderFor(baseUrl), { ...REQUEST, ...extra })).toMatchObject([{ status: 'ready' }]);
    const size = withReferences ? 256 : 1024;
    expect(state.prompt?.['2']?.inputs).toMatchObject({ width: size, height: size });
    expect(state.prompt?.['14']?.inputs.scale_by).toBe(128 / size);
  });

  test(`with downsizing off the ${graph} graph delivers its rendered size at the requested dims`, async () => {
    const { state, baseUrl } = startMock();
    expect(await collect(sizedProviderFor(baseUrl), { ...REQUEST, ...extra, resolution: '8mp', nativeOutput: true }))
      .toMatchObject([{ status: 'ready' }]);
    expect(state.prompt?.['2']?.inputs).toMatchObject({ width: 512, height: 640 });
    // Factor 1 is an identity resample, so the downscale node is left out.
    expect(state.prompt?.['14']).toBeUndefined();
  });
}

test('a requested size on a row without sizes keeps the row dims', async () => {
  const { state, baseUrl } = startMock();
  expect(await collect(providerFor(baseUrl), { ...REQUEST, resolution: '8mp' })).toMatchObject([{ status: 'ready' }]);
  expect(state.prompt?.['2']?.inputs).toMatchObject({ width: 1024, height: 1024 });
});
