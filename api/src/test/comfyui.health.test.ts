import { describe, expect, test } from 'bun:test';
import type { Provider, HealthResult } from '../providers/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createComfyuiProvider } from '../providers/comfyui';
import { privateWorkerTestCa, privateWorkerTestTls, privateWorkerTestToken } from './private-worker-tls';
import { currentWorkerPrivacy, privateWorkerFixture, privateWorkerTestPrivacy } from './private-worker-fixture';

function checkHealth(p: Provider, signal: AbortSignal): Promise<HealthResult> {
  if (!p.healthCheck) throw new Error('expected provider to have healthCheck');
  return p.healthCheck(signal);
}

function startInventoryMock(opts: { files: string[]; ready?: boolean; clipTypes?: string[] }): { baseUrl: string; stop: () => void } {
  const worker = privateWorkerFixture();
  const server = Bun.serve({
    port: 0, tls: privateWorkerTestTls,
    fetch(req) {
      if (new URL(req.url).pathname === '/atelier/v1/privacy' && opts.ready === false) return new Response(null, { status: 503 });
      const handled = worker.handle(req);
      if (handled) return handled;
      const url = new URL(req.url);
      if (url.pathname === '/object_info') {
        return Response.json({
          UNETLoader: { input: { required: { unet_name: [opts.files] } } },
          CLIPLoader: { input: { required: { type: [opts.clipTypes ?? []] } } },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { baseUrl: `https://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}

const BASE_CONFIG = {
  privacy: privateWorkerTestPrivacy,
  workflowText: '{}',
  maxResponseBytes: 1024,
  saveImageNodeId: '1',
  requiredPlaceholders: [] as readonly string[],
  ratioDims: {} as Record<string, { width: number; height: number } | undefined>,
  modelId: 'krea-2-gonzalomo',
} as const;

describe('per-model health readiness', () => {
  test('reports available when host up and required files present', async () => {
    const mock = startInventoryMock({ files: ['krea2_turbo_bf16.safetensors', 'qwen_image_vae.safetensors'] });
    const p = createComfyuiProvider({
      ...BASE_CONFIG,
      baseUrl: mock.baseUrl,
      requiredModelFiles: ['krea2_turbo_bf16.safetensors', 'qwen_image_vae.safetensors'],
    });
    const r = await checkHealth(p,new AbortController().signal);
    expect(r.ok).toBe(true);
    mock.stop();
  });

  test('reports unavailable when required files are missing', async () => {
    const mock = startInventoryMock({ files: ['some_other_model.safetensors'] });
    const p = createComfyuiProvider({
      ...BASE_CONFIG,
      baseUrl: mock.baseUrl,
      requiredModelFiles: ['krea2_turbo_bf16.safetensors'],
    });
    const r = await checkHealth(p,new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('not loaded');
    mock.stop();
  });

  test('reports unavailable when host is down, skips file check', async () => {
    const mock = startInventoryMock({ files: [], ready: false });
    const p = createComfyuiProvider({
      ...BASE_CONFIG,
      baseUrl: mock.baseUrl,
      requiredModelFiles: ['krea2_turbo_bf16.safetensors'],
    });
    const r = await checkHealth(p,new AbortController().signal);
    expect(r.ok).toBe(false);
    mock.stop();
  });

  test('skips file check when requiredModelFiles is empty', async () => {
    // Empty list = model has no weight requirements (test helpers, future use).
    // Readiness alone suffices when the graph and inventory requirements are empty.
    const mock = startInventoryMock({ files: [] });
    const p = createComfyuiProvider({
      ...BASE_CONFIG,
      baseUrl: mock.baseUrl,
      requiredModelFiles: [],
    });
    const r = await checkHealth(p,new AbortController().signal);
    expect(r.ok).toBe(true);
    mock.stop();
  });
});

describe('private worker health readiness', () => {
  function startPrivateHost(opts: {
    ready?: boolean; file?: boolean; node?: boolean; clip?: boolean; inventoryStatus?: number;
  } = {}) {
    const calls: string[] = [];
    const server = Bun.serve({
      port: 0, tls: privateWorkerTestTls,
      fetch(req) {
        const path = new URL(req.url).pathname;
        calls.push(path);
        if (req.headers.get('Authorization') !== `Bearer ${privateWorkerTestToken}`) {
          return new Response(null, { status: 401 });
        }
        if (path === '/atelier/v1/privacy') return Response.json({ ...currentWorkerPrivacy, ready: opts.ready !== false });
        if (path === '/system_stats') throw new Error('GPU stats must never run during private health');
        if (path === '/object_info') {
          if (opts.inventoryStatus) return new Response(null, { status: opts.inventoryStatus });
          return Response.json({
            UNETLoader: { input: { required: { unet_name: [[...(opts.file === false ? [] : ['model.safetensors'])]] } } },
            CLIPLoader: { input: { required: { type: [[...(opts.clip === false ? [] : ['krea2'])]] } } },
            ...(opts.node === false ? {} : { AtelierSaveImages: { input: { required: {} } } }),
          });
        }
        return new Response(null, { status: 404 });
      },
    });
    const baseUrl = `https://127.0.0.1:${server.port}`;
    const provider = (token: string | null = privateWorkerTestToken) => createComfyuiProvider({
      ...BASE_CONFIG, baseUrl,
      privacy: { ca: privateWorkerTestCa, token: token ?? undefined },
      workflowText: JSON.stringify({ '1': { class_type: 'SaveImageWebsocket', inputs: {} } }),
      requiredModelFiles: ['model.safetensors'], requiredClipType: 'krea2',
    });
    return { calls, provider, stop: () => void server.stop(true) };
  }

  test('uncached authenticated privacy and inventory pass without CUDA stats', async () => {
    const host = startPrivateHost();
    try {
      expect((await checkHealth(host.provider(), AbortSignal.timeout(1_000))).ok).toBe(true);
      expect((await checkHealth(host.provider(), AbortSignal.timeout(1_000))).ok).toBe(true);
      expect(host.calls).toEqual([
        '/atelier/v1/privacy', '/object_info', '/atelier/v1/privacy', '/object_info',
      ]);
    } finally { host.stop(); }
  });

  test('wrong or missing credentials and unready privacy stay offline before inventory', async () => {
    const host = startPrivateHost();
    try {
      for (const token of ['wrong', null]) {
        const result = await checkHealth(host.provider(token), AbortSignal.timeout(1_000));
        expect(result).toMatchObject({ ok: false, probeCode: 'privacy_transport' });
      }
      expect(host.calls).not.toContain('/object_info');
    } finally { host.stop(); }
    const unready = startPrivateHost({ ready: false });
    try {
      expect(await checkHealth(unready.provider(), AbortSignal.timeout(1_000)))
        .toMatchObject({ ok: false, probeCode: 'privacy_not_ready' });
      expect(unready.calls).not.toContain('/object_info');
    } finally { unready.stop(); }
  });

  test('missing file, clip type or graph node and failed inventory stay offline', async () => {
    for (const [opts, code] of [
      [{ file: false }, 'missing_file'], [{ clip: false }, 'missing_clip_type'],
      [{ node: false }, 'missing_node_class'], [{ inventoryStatus: 503 }, 'inventory_transport'],
    ] as const) {
      const host = startPrivateHost(opts);
      try {
        expect(await checkHealth(host.provider(), AbortSignal.timeout(1_000)))
          .toMatchObject({ ok: false, probeCode: code });
        expect(host.calls).not.toContain('/system_stats');
      } finally { host.stop(); }
    }
  });
});

describe('terminal node class readiness', () => {
  const WS_CONFIG = {
    ...BASE_CONFIG,
    workflowText: JSON.stringify({ '9': { class_type: 'SaveImageWebsocket', inputs: { images: ['8', 0] } } }),
    saveImageNodeId: '9',
  } as const;

  function objectInfoMock(opts: { files: string[]; includeWsNode: boolean }): { baseUrl: string; stop: () => void } {
    const worker = privateWorkerFixture();
    const server = Bun.serve({
      port: 0, tls: privateWorkerTestTls,
      fetch(req) {
        const handled = worker.handle(req);
        if (handled) return handled;
        const url = new URL(req.url);
        if (url.pathname === '/object_info') {
          const info: Record<string, unknown> = {
            UNETLoader: { input: { required: { unet_name: [opts.files] } } },
            CLIPLoader: { input: { required: { type: [[]] } } },
          };
          if (opts.includeWsNode) info.AtelierSaveImages = { input: { required: { images: ['IMAGE'] } } };
          return Response.json(info);
        }
        return new Response('not found', { status: 404 });
      },
    });
    return { baseUrl: `https://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
  }

  test('unavailable when the terminal node class is missing from /object_info', async () => {
    const mock = objectInfoMock({ files: ['krea2_turbo_bf16.safetensors'], includeWsNode: false });
    const p = createComfyuiProvider({
      ...WS_CONFIG,
      baseUrl: mock.baseUrl,
      requiredModelFiles: ['krea2_turbo_bf16.safetensors'],
    });
    const r = await checkHealth(p, new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/SaveImageWebsocket/);
    mock.stop();
  });

  test('available when the terminal node class is registered', async () => {
    const mock = objectInfoMock({ files: ['krea2_turbo_bf16.safetensors'], includeWsNode: true });
    const p = createComfyuiProvider({
      ...WS_CONFIG,
      baseUrl: mock.baseUrl,
      requiredModelFiles: ['krea2_turbo_bf16.safetensors'],
    });
    const r = await checkHealth(p, new AbortController().signal);
    expect(r.ok).toBe(true);
    mock.stop();
  });
});

describe('CLIPLoader type readiness', () => {
  const KREA_FILES = [
    'krea2_turbo_bf16.safetensors',
    'qwen3vl_4b_bf16.safetensors',
    'qwen_image_vae.safetensors',
  ] as const;

  test('krea-2 unavailable when host lacks krea2 CLIPLoader type', async () => {
    // Host has all weight files but CLIPLoader type enum lacks 'krea2'
    // (e.g., old ComfyUI build without the custom CLIP type registered).
    const mock = startInventoryMock({
      files: [...KREA_FILES],
      clipTypes: ['stable_diffusion', 'sdxl'],
    });
    const p = createComfyuiProvider({
      ...BASE_CONFIG,
      baseUrl: mock.baseUrl,
      modelId: 'krea-2-gonzalomo',
      requiredModelFiles: KREA_FILES,
      requiredClipType: 'krea2',
    });
    const r = await checkHealth(p, new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("clip type 'krea2' not supported");
    mock.stop();
  });

  test('krea-2 available when host has files and krea2 CLIPLoader type', async () => {
    const mock = startInventoryMock({
      files: [...KREA_FILES],
      clipTypes: ['stable_diffusion', 'krea2'],
    });
    const p = createComfyuiProvider({
      ...BASE_CONFIG,
      baseUrl: mock.baseUrl,
      modelId: 'krea-2-gonzalomo',
      requiredModelFiles: KREA_FILES,
      requiredClipType: 'krea2',
    });
    const r = await checkHealth(p, new AbortController().signal);
    expect(r.ok).toBe(true);
    mock.stop();
  });
});

describe('extend graph readiness', () => {
  for (const missing of [null, 'MiniMaxH3AddGuide', 'GetVideoComponents', 'AtelierLoadVideo', 'AtelierSaveVideo']) {
    test(`private host ${missing ? `missing ${missing} is offline` : 'with every extend dependency is ready'}`, async () => {
      const worker = privateWorkerFixture();
      const classes = ['AtelierSaveImages', 'MiniMaxH3AddGuide', 'GetVideoComponents', 'AtelierLoadVideo', 'AtelierSaveVideo'];
      const server = Bun.serve({
        port: 0, tls: privateWorkerTestTls,
        fetch(req) {
          const handled = worker.handle(req);
          if (handled) return handled;
          if (new URL(req.url).pathname === '/object_info') return Response.json(Object.fromEntries(
            classes.filter((cls) => cls !== missing).map((cls) => [cls, {}]),
          ));
          return new Response(null, { status: 404 });
        },
      });
      try {
        const provider = createComfyuiProvider({
          ...BASE_CONFIG, requiredModelFiles: [],
          baseUrl: `https://127.0.0.1:${server.port}`,
          workflowText: '{"1":{"class_type":"SaveImageWebsocket","inputs":{}}}',
          extendWorkflowText: JSON.stringify({
            '1': { class_type: 'LoadVideo', inputs: {} },
            '2': { class_type: 'GetVideoComponents', inputs: {} },
            '3': { class_type: 'MiniMaxH3AddGuide', inputs: {} },
            '4': { class_type: 'SaveVideo', inputs: {} },
          }),
        });
        const result = await checkHealth(provider, AbortSignal.timeout(1_000));
        if (missing === null) expect(result).toEqual({ ok: true });
        else {
          expect(result).toMatchObject({ ok: false, probeCode: 'missing_node_class' });
          if (!result.ok) expect(result.reason).toContain(missing);
        }
      } finally { await server.stop(true); }
    });
  }
});

// A workflow's MID-graph nodes must all be registered on the host. Before this
// check the host passed readiness and then failed every job at /prompt. This
// mattered most when the attention patch was KJNodes' PathchSageAttentionKJ,
// since a third-party pack that silently fails to import after a ComfyUI update
// would break every local row on that host despite green readiness. Every graph
// now uses core nodes only, so the class most at risk is a core node moving or
// being renamed across ComfyUI versions, so the check is worth keeping.
// GonzaLomo's graph is the probe.
describe('mid-graph node class readiness', () => {
  const KREA_WORKFLOW = readFileSync(
    join(import.meta.dir, '..', 'providers', 'comfyui', 'models', 'krea-2-gonzalomo', 'workflow.json'),
    'utf8',
  );
  const MODEL_FILE = 'gonzalomo_krea2_v4_int8_convrot.safetensors';

  function hostMock(registered: readonly string[]): { baseUrl: string; stop: () => void } {
    const worker = privateWorkerFixture();
    const server = Bun.serve({
      port: 0, tls: privateWorkerTestTls,
      fetch(req) {
        const handled = worker.handle(req);
        if (handled) return handled;
        const url = new URL(req.url);
        if (url.pathname === '/object_info') {
          const info: Record<string, unknown> = {
            UNETLoader: { input: { required: { unet_name: [[MODEL_FILE]] } } },
            CLIPLoader: { input: { required: { type: [['krea2']] } } },
          };
          // Only fill in classes the loader stubs above don't already define —
          // overwriting UNETLoader/CLIPLoader would blank the model-file and
          // clip-type enums and make these tests fail for the wrong reason.
          for (const cls of registered) info[cls] ??= { input: { required: {} } };
          return Response.json(info);
        }
        return new Response('not found', { status: 404 });
      },
    });
    return { baseUrl: `https://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
  }

  const ALL_CLASSES = [...new Set(
    Object.values(JSON.parse(KREA_WORKFLOW) as Record<string, { class_type: string }>)
      .map((node) => node.class_type === 'SaveImageWebsocket' ? 'AtelierSaveImages' : node.class_type),
  )];

  const provider = (baseUrl: string) => createComfyuiProvider({
    ...BASE_CONFIG,
    baseUrl,
    workflowText: KREA_WORKFLOW,
    saveImageNodeId: '9',
    requiredModelFiles: [MODEL_FILE],
    requiredClipType: 'krea2',
    maxResponseBytes: 1_000_000,
  });

  test('the shipped GonzaLomo graph really does depend on the core attention node', () => {
    expect(ALL_CLASSES).toContain('ModelAttentionBackend');
    // Guards the migration off KJNodes: no graph may reintroduce a
    // third-party attention patch without this test being changed deliberately.
    expect(ALL_CLASSES).not.toContain('PathchSageAttentionKJ');
  });

  test('unavailable when the attention node class is missing even though weights and terminal node are present', async () => {
    const mock = hostMock(ALL_CLASSES.filter((cls) => cls !== 'ModelAttentionBackend'));
    const r = await checkHealth(provider(mock.baseUrl), new AbortController().signal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ModelAttentionBackend/);
    mock.stop();
  });

  test('available when every node class the graph uses is registered', async () => {
    const mock = hostMock(ALL_CLASSES);
    const r = await checkHealth(provider(mock.baseUrl), new AbortController().signal);
    expect(r.ok).toBe(true);
    mock.stop();
  });
});
