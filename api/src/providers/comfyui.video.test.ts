import { afterEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { __resetComfyuiResidentModels, createComfyuiProvider, drainComfyUi } from './comfyui';
import { TEST_EXECUTION_TIMEOUT_MS, privateWorkerFixture, privateWorkerTestPrivacy, privateWorkerTestTls } from '../test/private-worker-fixture';
import type { ProviderResult } from './types';

interface PromptBody {
  prompt: Record<string, unknown>;
  client_id: string;
  prompt_id: string;
}

interface VideoMockServer {
  baseUrl: string;
  uploadedBytes: Uint8Array | undefined;
  submittedPrompt: Record<string, unknown> | undefined;
  lastOutputPath: string | undefined;
  requestLog: string[];
  stop: () => Promise<void>;
}

interface WsCtx {
  clientId: string;
}

const servers: { stop: () => Promise<void> }[] = [];

afterEach(async () => {
  await drainComfyUi();
  __resetComfyuiResidentModels();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

const VIDEO_WORKFLOW = JSON.stringify({
  '3': {
    class_type: 'LoadImage',
    inputs: { image: '{{sourceImage}}' },
  },
  '5': {
    class_type: 'CLIPTextEncode',
    inputs: { text: '{{motionPrompt}}' },
  },
  '7': {
    class_type: 'EmptySD3LatentImage',
    inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{count}}' },
  },
  '8': {
    class_type: 'KSampler',
    inputs: { seed: '{{seed}}', cfg: 1.0 },
  },
  '15': {
    class_type: 'SaveVideo',
    inputs: { images: ['8', 0] },
  },
});

const sourceBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const mp4Bytes = new Uint8Array([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x00,
]);

interface VideoMockOptions {
  // HTTP status the mock /free returns (default 200).
  freeStatus?: number;
  // vram_free value per successive /system_stats read (total is always 100).
  // The last entry repeats once exhausted; default keeps the card cleared (95).
  statsFreeSequence?: number[];
}

function startVideoMock(options: VideoMockOptions = {}): VideoMockServer {
  const freeStatus = options.freeStatus ?? 200;
  const statsFreeSequence = options.statsFreeSequence ?? [95];
  let statsReadIndex = 0;
  const worker = privateWorkerFixture();
  const outputId = crypto.randomUUID();
  const sockets = new Map<string, ServerWebSocket<WsCtx>>();
  const state: {
    uploadedBytes: Uint8Array | undefined;
    submittedPrompt: Record<string, unknown> | undefined;
    lastOutputPath: string | undefined;
    requestLog: string[];
  } = {
    uploadedBytes: undefined,
    submittedPrompt: undefined,
    lastOutputPath: undefined,
    requestLog: [],
  };

  const server = Bun.serve<WsCtx>({
    port: 0,
    tls: privateWorkerTestTls,
    idleTimeout: 0,
    async fetch(req, srv) {
      if (new URL(req.url).pathname.includes('/outputs/')) state.lastOutputPath = new URL(req.url).pathname;
      const handled = worker.handle(req);
      if (handled) return handled;
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        const clientId = url.searchParams.get('clientId') ?? '';
        if (srv.upgrade(req, { data: { clientId } })) return undefined;
        return new Response('upgrade required', { status: 426 });
      }
      if (url.pathname === '/free' && req.method === 'POST') {
        state.requestLog.push('free');
        return new Response(null, { status: freeStatus });
      }
      if (url.pathname === '/system_stats' && req.method === 'GET') {
        state.requestLog.push('system_stats');
        const idx = Math.min(statsReadIndex, statsFreeSequence.length - 1);
        statsReadIndex += 1;
        const vramFree = statsFreeSequence[idx] ?? 95;
        return Response.json({ devices: [{ vram_total: 100, vram_free: vramFree }] });
      }
      if (/^\/atelier\/v1\/jobs\/[^/]+\/inputs\/[^/]+$/.test(url.pathname) && req.method === 'PUT') {
        state.requestLog.push('upload');
        state.uploadedBytes = new Uint8Array(await req.arrayBuffer());
        return Response.json({ ok: true });
      }
      if (url.pathname === '/prompt' && req.method === 'POST') {
        state.requestLog.push('prompt');
        const body = (await req.json()) as PromptBody;
        state.submittedPrompt = body.prompt;
        const promptId = body.prompt_id;
        setTimeout(() => {
          worker.complete(promptId, [mp4Bytes], 'video/mp4');
          const ws = sockets.get(body.client_id);
          ws?.send(JSON.stringify({
            type: 'progress',
            data: {
              node: '8',
              prompt_id: promptId,
              value: 2,
              max: 8,
            },
          }));
          ws?.send(JSON.stringify({
            type: 'executed',
            data: {
              node: '15',
              display_node: '15',
              prompt_id: promptId,
              output: { gifs: [{ filename: outputId, subfolder: promptId, type: 'atelier-memory' }] },
            },
          }));
        }, 5);
        return Response.json({ prompt_id: promptId, number: 0, node_errors: {} });
      }
      if (/^\/atelier\/v1\/jobs\/[^/]+\/outputs\/[^/]+$/.test(url.pathname)) {
        state.lastOutputPath = url.pathname;
        return new Response(mp4Bytes, { headers: { 'Content-Type': 'video/mp4' } });
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

  const stop = async () => {
    await Promise.race([
      server.stop(true),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
  };
  servers.push({ stop });

  return {
    baseUrl: `https://127.0.0.1:${server.port}`,
    get uploadedBytes() {
      return state.uploadedBytes;
    },
    get submittedPrompt() {
      return state.submittedPrompt;
    },
    get lastOutputPath() {
      return state.lastOutputPath;
    },
    get requestLog() {
      return state.requestLog;
    },
    stop,
  };
}

const EXTEND_WORKFLOW = JSON.stringify({
  '3': { class_type: 'LoadVideo', inputs: { file: '{{contextVideo}}' } },
  '4': { class_type: 'GetVideoComponents', inputs: { video: ['3', 0] } },
  '5': { class_type: 'CLIPTextEncode', inputs: { text: '{{motionPrompt}}' } },
  '6': {
    class_type: 'MiniMaxH3AddGuide',
    inputs: { frame_idx: 0, image: ['4', 0], audio: ['4', 1] },
  },
  '7': {
    class_type: 'EmptySD3LatentImage',
    inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{count}}', length: '{{videoFrames}}' },
  },
  '8': { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: '{{steps}}', cfg: 1.0 } },
  '15': { class_type: 'SaveVideo', inputs: { images: ['8', 0] } },
});

function createVideoProvider(baseUrl: string, extend = false) {
  const config = {
    baseUrl,
    privacy: privateWorkerTestPrivacy,
    workflowText: VIDEO_WORKFLOW,
    maxResponseBytes: 50 * 1024 * 1024,
    saveImageNodeId: '15',
    requiredPlaceholders: ['{{motionPrompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{count}}', '{{sourceImage}}'],
    ratioDims: { '1:1': { width: 1280, height: 720 } },
    modelId: 'minimax-h3-i2v',
    requiredModelFiles: [],
    outputKind: 'video' as const,
    defaultSteps: 8,
    ...(extend
      ? {
          extendWorkflowText: EXTEND_WORKFLOW,
          extendRequiredPlaceholders: [
            '{{motionPrompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{count}}',
            '{{contextVideo}}', '{{videoFrames}}', '{{steps}}',
          ],
        }
      : {}),
  };
  return createComfyuiProvider(config);
}

describe('ComfyUI video output', () => {
  test('uploads i2v source and returns a ready mp4 result', async () => {
    const mock = startVideoMock();
    const provider = createVideoProvider(mock.baseUrl);
    const request = {
      prompt: 'hold the original composition',
      motionPrompt: 'slow camera push-in',
      modelId: 'minimax-h3-i2v',
      ratio: '1:1' as const,
      tileIndex: 0,
      seed: 77,
      count: 1,
      i2vSource: { bytes: sourceBytes, ext: 'png' },
    };

    const results: ProviderResult[] = [];
    const progress: { progress: number; phase?: string }[] = [];
    for await (const result of provider.generate(request, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS,
      onProgress: (item) => { progress.push(item); },
    })) {
      results.push(result);
    }

    expect(mock.uploadedBytes).toEqual(sourceBytes);
    expect(mock.lastOutputPath).toMatch(/^\/atelier\/v1\/jobs\/[0-9a-f-]{36}\/outputs\/[0-9a-f-]{36}$/);
    expect(progress).toEqual([{ progress: 0.25, phase: '8' }]);
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result?.status).toBe('ready');
    if (result?.status !== 'ready') return;
    expect(result.ext).toBe('mp4');
    expect(result.mime).toBe('video/mp4');
    expect(result.seed).toBe(77);
    expect(result.index).toBe(0);
    expect(result.bytes).toEqual(mp4Bytes);
  });

  test('evicts resident VRAM via /free before submitting the video prompt', async () => {
    const mock = startVideoMock();
    const provider = createVideoProvider(mock.baseUrl);
    const request = {
      prompt: 'hold the original composition',
      motionPrompt: 'slow camera push-in',
      modelId: 'minimax-h3-i2v',
      ratio: '1:1' as const,
      tileIndex: 0,
      seed: 77,
      count: 1,
      i2vSource: { bytes: sourceBytes, ext: 'png' },
    };

    const results: ProviderResult[] = [];
    for await (const result of provider.generate(request, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) {
      results.push(result);
    }

    // The video model must load into a cleared card: /free is POSTed and VRAM is
    // confirmed drained (via /system_stats) BEFORE /prompt submits the workflow.
    const freeIdx = mock.requestLog.indexOf('free');
    const statsIdx = mock.requestLog.indexOf('system_stats');
    const promptIdx = mock.requestLog.indexOf('prompt');
    expect(freeIdx).toBeGreaterThanOrEqual(0);
    expect(statsIdx).toBeGreaterThan(freeIdx);
    expect(promptIdx).toBeGreaterThan(statsIdx);
    expect(results[0]?.status).toBe('ready');
  });

  test('keeps polling until VRAM is confirmed cleared before submitting the prompt', async () => {
    // First read reports the card still ~60% occupied (40/100 free, below the
    // 0.85 threshold) → must NOT submit; second read shows it cleared (90/100).
    const mock = startVideoMock({ statsFreeSequence: [40, 90] });
    const provider = createVideoProvider(mock.baseUrl);
    const request = {
      prompt: 'hold the original composition',
      motionPrompt: 'slow camera push-in',
      modelId: 'minimax-h3-i2v',
      ratio: '1:1' as const,
      tileIndex: 0,
      seed: 77,
      count: 1,
      i2vSource: { bytes: sourceBytes, ext: 'png' },
    };

    const results: ProviderResult[] = [];
    for await (const result of provider.generate(request, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) {
      results.push(result);
    }

    // The loop must have read /system_stats more than once (kept polling while
    // the card was still occupied) and only then submitted /prompt.
    const statsReads = mock.requestLog.filter((r) => r === 'system_stats').length;
    expect(statsReads).toBeGreaterThanOrEqual(2);
    const promptIdx = mock.requestLog.indexOf('prompt');
    const lastStatsIdx = mock.requestLog.lastIndexOf('system_stats');
    expect(promptIdx).toBeGreaterThan(lastStatsIdx);
    expect(results[0]?.status).toBe('ready');
  });

  test('proceeds (best-effort) when /free is unavailable on the host', async () => {
    // Older ComfyUI builds without /free return non-2xx: the job must still run
    // rather than abort, and we should not waste a poll loop on it.
    const mock = startVideoMock({ freeStatus: 404 });
    const provider = createVideoProvider(mock.baseUrl);
    const request = {
      prompt: 'hold the original composition',
      motionPrompt: 'slow camera push-in',
      modelId: 'minimax-h3-i2v',
      ratio: '1:1' as const,
      tileIndex: 0,
      seed: 77,
      count: 1,
      i2vSource: { bytes: sourceBytes, ext: 'png' },
    };

    const results: ProviderResult[] = [];
    for await (const result of provider.generate(request, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) {
      results.push(result);
    }

    expect(mock.requestLog).toContain('free');
    expect(mock.requestLog).not.toContain('system_stats');
    expect(mock.requestLog).toContain('prompt');
    expect(results[0]?.status).toBe('ready');
  });

  test('skips eviction when the same model is already resident on the host', async () => {
    const mock = startVideoMock();
    const provider = createVideoProvider(mock.baseUrl);
    const request = {
      prompt: 'hold the original composition',
      motionPrompt: 'slow camera push-in',
      modelId: 'minimax-h3-i2v',
      ratio: '1:1' as const,
      tileIndex: 0,
      seed: 77,
      count: 1,
      i2vSource: { bytes: sourceBytes, ext: 'png' },
    };

    // First job on a fresh host → must evict (unknown → minimax-h3-i2v).
    for await (const _ of provider.generate(request, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) { /* drain */ }
    const freeAfterFirst = mock.requestLog.filter((r) => r === 'free').length;
    const promptAfterFirst = mock.requestLog.filter((r) => r === 'prompt').length;
    expect(freeAfterFirst).toBe(1);

    // Second job, same model already resident → no new /free, but a new /prompt.
    for await (const _ of provider.generate(request, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) { /* drain */ }
    const freeAfterSecond = mock.requestLog.filter((r) => r === 'free').length;
    const promptAfterSecond = mock.requestLog.filter((r) => r === 'prompt').length;
    expect(freeAfterSecond).toBe(freeAfterFirst); // no second eviction
    expect(promptAfterSecond).toBe(promptAfterFirst + 1); // job still ran
  });
});

describe('ComfyUI video continuation', () => {
  const continuationRequest = {
    prompt: 'keep walking',
    motionPrompt: 'she keeps walking, camera still tracking',
    modelId: 'minimax-h3-i2v',
    ratio: '1:1' as const,
    tileIndex: 0,
    seed: 77,
    count: 1,
    durationFrames: 124,
    i2vSource: { bytes: sourceBytes, ext: 'png' },
    i2vContext: { bytes: mp4Bytes, contextFrames: 22 },
  };

  test('runs the AddGuide graph and renders the context head on top of the clip', async () => {
    const mock = startVideoMock();
    const provider = createVideoProvider(mock.baseUrl, true);
    const results: ProviderResult[] = [];
    for await (const result of provider.generate(continuationRequest, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) {
      results.push(result);
    }
    const ready = results.find((r) => r.status === 'ready');
    expect(ready).toBeDefined();
    if (ready?.status !== 'ready') throw new Error('expected a ready result');
    // The stitcher trims exactly what the provider says it rendered.
    expect(ready.contextFrames).toBe(22);
    // The guide clip, not the still, is what got uploaded.
    expect(mock.uploadedBytes).toEqual(mp4Bytes);

    const submitted = mock.submittedPrompt;
    expect(submitted).toBeDefined();
    const nodes = submitted as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(Object.values(nodes).some((n) => n.class_type === 'MiniMaxH3AddGuide')).toBe(true);
    expect(Object.values(nodes).some((n) => n.class_type === 'AtelierLoadImage')).toBe(false);
    // 124 requested + 22 context snaps up to 158 so the delivered clip is not short.
    expect(nodes['7']?.inputs.length).toBe(158);
  });

  test('samples the request step override, else the model default', async () => {
    for (const [steps, expected] of [[undefined, 8], [20, 20]] as const) {
      const mock = startVideoMock();
      const provider = createVideoProvider(mock.baseUrl, true);
      const request = steps === undefined ? continuationRequest : { ...continuationRequest, steps };
      for await (const result of provider.generate(request, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) {
        expect(result.status).not.toBe('failed');
      }
      const nodes = mock.submittedPrompt as Record<string, { inputs: Record<string, unknown> }>;
      expect(nodes['8']?.inputs.steps).toBe(expected);
    }
  });

  test('falls back to the still-frame graph on a host without the guide node', async () => {
    const mock = startVideoMock();
    const provider = createVideoProvider(mock.baseUrl, false);
    const results: ProviderResult[] = [];
    for await (const result of provider.generate(continuationRequest, new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) {
      results.push(result);
    }
    const ready = results.find((r) => r.status === 'ready');
    if (ready?.status !== 'ready') throw new Error('expected a ready result');
    // Reporting 0 is what keeps the stitcher from trimming a head that is not there.
    expect(ready.contextFrames).toBe(0);
    expect(mock.uploadedBytes).toEqual(sourceBytes);
    const nodes = mock.submittedPrompt as Record<string, { class_type: string }>;
    expect(Object.values(nodes).some((n) => n.class_type === 'AtelierLoadImage')).toBe(true);
  });
});
