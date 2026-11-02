import { afterEach, describe, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import pino from 'pino';
import { TEST_EXECUTION_TIMEOUT_MS, privateWorkerFixture, privateWorkerTestPrivacy, privateWorkerTestTls, privateImageFrames } from './private-worker-fixture';
import type { ServerWebSocket } from 'bun';
import { __resetComfyuiResidentModels, ComfyuiUpstreamError, createComfyuiProvider, drainComfyUi } from '../providers/comfyui';
import { buildWorkflow } from '../providers/comfyui/template';
import { sanitizeProviderError } from '../orchestrator/sanitize';
import type { ProviderRequest, ProviderResult } from '../providers/types';
import { grayCardPng, pngBytes } from './image-fixtures';

interface MockBehavior {
  promptHandler?: (body: PromptBody, request: Request) => Response | Promise<Response>;
  framesFor?: (promptId: string) => readonly object[];
  // If set, frames are flushed BEFORE the POST returns to exercise the
  // early-frame race: a fast cache-hit can finish before the HTTP acknowledgment.
  preflushFramesBeforePostResponse?: boolean;
  imageBytes?: Uint8Array;
  // If set, the first N `/prompt` POSTs return 500 (the job fails at runJob);
  // subsequent ones use the normal framesFor path. Lets tests exercise the
  // "a failed job must not pin the resident-model tracker" path.
  failFirstNPrompts?: number;
  failPrompts?: readonly number[];
}

interface PromptBody {
  prompt: Record<string, unknown>;
  client_id: string;
  prompt_id?: string;
}

interface MockServer {
  baseUrl: string;
  lastPromptBody: PromptBody | undefined;
  released: readonly string[];
  calls: readonly string[];
  freeCallCount: number;
  stop: () => Promise<void>;
  recordPrompt: (id: string | null) => void;
}

interface WsCtx {
  clientId: string;
}

const png = pngBytes();
const silentLogger = pino({ level: 'silent' });

const servers: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  await drainComfyUi();
  __resetComfyuiResidentModels();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function startMock(behavior: MockBehavior): MockServer {
  // Track open WS per clientId. Buffer frames keyed by clientId; flush on
  // whichever happens later (WS open vs POST handler). This avoids the race
  // where the POST handler runs before the server's websocket.open callback
  // has registered the socket.
  const worker = privateWorkerFixture();
  const sockets = new Map<string, ServerWebSocket<WsCtx>>();
  const pending = new Map<string, object[]>();
  const flush = (clientId: string) => {
    const ws = sockets.get(clientId);
    const frames = pending.get(clientId);
    if (!ws || !frames) return;
    pending.delete(clientId);
    for (const frame of frames) ws.send(frame instanceof Uint8Array ? frame : JSON.stringify(frame));
  };

  const state: {
    lastPromptBody: PromptBody | undefined;
    freeCallCount: number;
    promptCount: number;
  } = {
    lastPromptBody: undefined,
    freeCallCount: 0,
    promptCount: 0,
  };

  const server = Bun.serve<WsCtx>({
    port: 0,
    tls: privateWorkerTestTls,
    idleTimeout: 0,
    async fetch(req, srv) {
      const handled = worker.handle(req);
      if (handled) return handled;
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        const clientId = url.searchParams.get('clientId') ?? '';
        if (srv.upgrade(req, { data: { clientId } })) return undefined;
        return new Response('upgrade required', { status: 426 });
      }
      if (url.pathname === '/prompt' && req.method === 'POST') {
        const body = (await req.json()) as PromptBody;
        state.lastPromptBody = body;
        state.promptCount += 1;
        if ((behavior.failFirstNPrompts !== undefined && state.promptCount <= behavior.failFirstNPrompts)
          || behavior.failPrompts?.includes(state.promptCount)) {
          if (body.prompt_id) worker.fail(body.prompt_id);
          return new Response('boom', { status: 500 });
        }
        if (behavior.promptHandler) {
          const response = await behavior.promptHandler(body, req);
          if (response.status >= 500 && body.prompt_id) worker.fail(body.prompt_id);
          return response;
        }
        const promptId = body.prompt_id;
        if (!promptId) throw new Error('missing client-chosen job id');
        const responseBody = JSON.stringify({ prompt_id: promptId, number: 0, node_errors: {} });
        const responseInit = { status: 200, headers: { 'Content-Type': 'application/json' } };
        if (behavior.framesFor) {
          const frames = behavior.framesFor(promptId).map((frame) => {
            if (!(frame instanceof Uint8Array) || behavior.imageBytes === undefined) return frame;
            return privateImageFrames(promptId, '15', behavior.imageBytes)[1] as Uint8Array;
          });
          const sinks = new Set(Object.entries(body.prompt).filter(([, node]) =>
            typeof node === 'object' && node !== null && 'class_type' in node && node.class_type === 'AtelierSaveImages').map(([id]) => id));
          let current: string | undefined;
          const bytes: Uint8Array[] = [];
          for (const frame of frames) {
            if (frame instanceof Uint8Array) {
              if (current && sinks.has(current)) bytes.push(frame.subarray(8));
            } else if ('data' in frame && typeof frame.data === 'object' && frame.data !== null && 'node' in frame.data) {
              current = typeof frame.data.node === 'string' ? frame.data.node : undefined;
            }
          }
          if (frames.some((frame) => 'type' in frame && frame.type === 'execution_error')) worker.fail(promptId);
          else worker.complete(promptId, bytes);
          pending.set(body.client_id, frames);
          if (behavior.preflushFramesBeforePostResponse) {
            // Delay acknowledgment so the binary frames arrive first.
            flush(body.client_id);
            await Bun.sleep(20);
            return new Response(responseBody, responseInit);
          }
          // Flush on the next tick so the adapter has time to attach its
          // message listener after consuming the POST response (the common
          // case in production where frames arrive after POST returns).
          setTimeout(() => {
            flush(body.client_id);
          }, 5);
        }
        return new Response(responseBody, responseInit);
      }
      if (url.pathname === '/free' && req.method === 'POST') {
        state.freeCallCount += 1;
        return new Response(null, { status: 200 });
      }
      if (url.pathname === '/system_stats' && req.method === 'GET') {
        // Report a cleared card so the eviction poll returns on its first read.
        return Response.json({ devices: [{ vram_total: 100, vram_free: 95 }] });
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.set(ws.data.clientId, ws);
        flush(ws.data.clientId);
      },
      message() {
        // we never receive client messages in this contract
      },
      close(ws) {
        sockets.delete(ws.data.clientId);
      },
    },
  });

  const stop = async () => {
    // Bun (1.3.x) hangs on server.stop(true) when a WS was closed server-side
    // mid-test — its WS teardown waits on the close handshake even with
    // force=true. Race against a short timeout so afterEach doesn't block;
    // the server is GC-eligible once we return from this function.
    await Promise.race([
      server.stop(true),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
  };
  servers.push({ stop });

  return {
    baseUrl: `https://127.0.0.1:${server.port}`,
    get lastPromptBody() {
      return state.lastPromptBody;
    },
    released: worker.released,
    calls: worker.calls,
    recordPrompt: (id) => { worker.recordPrompt(id); },
    get freeCallCount() {
      return state.freeCallCount;
    },
    stop,
  };
}

function simpleWorkflow(saveNodeId: string): string {
  return JSON.stringify({
    '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'fixture.safetensors' } },
    '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 1], text: '{{prompt}}' } },
    '7': {
      class_type: 'EmptySD3LatentImage',
      inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{count}}' },
    },
    '8': {
      class_type: 'KSampler',
      inputs: {
        seed: '{{seed}}',
        steps: 8,
        cfg: 1.0,
        sampler_name: 'res_multistep',
        scheduler: 'simple',
        denoise: 1.0,
        model: ['2', 0],
        positive: ['5', 0],
        negative: ['5', 0],
        latent_image: ['7', 0],
      },
    },
    '10': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['2', 2] } },
    [saveNodeId]: { class_type: 'SaveImageWebsocket', inputs: { images: ['10', 0] } },
    // SeedVR2 upscale node: present so the {{upscaleShort}} placeholder buildWorkflow
    // requires is satisfied (the real workflow carries it on the SeedVR2 chain, kept
    // configured even while the upscale stage is operator-disabled).
    '20': {
      class_type: 'SeedVR2VideoUpscaler',
      inputs: { resolution: '{{upscaleShort}}' },
    },
  });
}

const SIMPLE_WORKFLOW = simpleWorkflow('15');
const KREA_WORKFLOW = simpleWorkflow('9');

function providerReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    prompt: 'a quiet workstation at dusk',
    modelId: 'krea-2-gonzalomo',
    ratio: '1:1',
    tileIndex: 0,
    seed: 1234,
    ...overrides,
  };
}

async function runProvider(
  baseUrl: string,
  overrides: Partial<ProviderRequest> = {},
  signal?: AbortSignal,
  maxResponseBytes = 50 * 1024 * 1024,
): Promise<ProviderResult[]> {
  const provider = createComfyuiProvider({
    baseUrl,
    privacy: privateWorkerTestPrivacy,
    workflowText: SIMPLE_WORKFLOW,
    maxResponseBytes,
    saveImageNodeId: '15',
    requiredPlaceholders: ['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{count}}', '{{upscaleShort}}'],
    ratioDims: {
      '1:1': { width: 2048, height: 2048 },
      '4:5': { width: 1600, height: 2000 },
      '3:4': { width: 1536, height: 2048 },
      '16:9': { width: 2048, height: 1152 },
      '9:16': { width: 1152, height: 2048 },
    },
    modelId: 'krea-2-gonzalomo',
    requiredModelFiles: [],
  });
  const collected: ProviderResult[] = [];
  for await (const result of provider.generate(providerReq(overrides), signal ?? new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) {
    collected.push(result);
  }
  return collected;
}

function executedFrames(promptId: string, bytes = png): readonly object[] {
  return privateImageFrames(promptId, '15', bytes);
}

function nodeInputs(body: PromptBody | undefined, nodeId: string): Record<string, unknown> {
  const prompt = body?.prompt ?? {};
  const node = prompt[nodeId];
  if (typeof node !== 'object' || node === null) throw new Error(`missing node ${nodeId}`);
  const inputs = (node as { inputs?: unknown }).inputs;
  if (typeof inputs !== 'object' || inputs === null) throw new Error(`missing inputs for ${nodeId}`);
  return inputs as Record<string, unknown>;
}

describe('ComfyUI provider', () => {
  test('happy path: POSTs workflow with substituted params, awaits executed, returns PNG', async () => {
    const mock = startMock({
      framesFor: (promptId) => executedFrames(promptId),
    });

    const results = await runProvider(mock.baseUrl, { ratio: '1:1', seed: 42, prompt: 'paint a teapot' });

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result?.status).toBe('ready');
    if (result?.status !== 'ready') return;
    expect(result.ext).toBe('png');
    expect(result.mime).toBe('image/png');
    expect(result.seed).toBe(42);
    expect(result.bytes).toEqual(png);

    expect(typeof mock.lastPromptBody?.client_id).toBe('string');
    const samplerInputs = nodeInputs(mock.lastPromptBody, '8');
    expect(samplerInputs.seed).toBe(42);
    const latentInputs = nodeInputs(mock.lastPromptBody, '7');
    expect(latentInputs.width).toBe(2048);
    expect(latentInputs.height).toBe(2048);
    const textInputs = nodeInputs(mock.lastPromptBody, '5');
    expect(textInputs.text).toBe('paint a teapot');

    expect(mock.lastPromptBody?.prompt_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('substitutes ratio dims per request', async () => {
    const mock = startMock({
      framesFor: (promptId) => executedFrames(promptId),
    });

    await runProvider(mock.baseUrl, { ratio: '9:16' });

    const latentInputs = nodeInputs(mock.lastPromptBody, '7');
    // 9:16 base render is native ≤2048/side (SeedVR2 upscales to 4K downstream).
    expect(latentInputs.width).toBe(1152);
    expect(latentInputs.height).toBe(2048);
  });

  test('POST /prompt 5xx → failed, sanitizes to internal error', async () => {
    const mock = startMock({
      promptHandler: () => new Response('boom', { status: 500 }),
    });

    const results = await runProvider(mock.baseUrl);

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result?.status).toBe('failed');
    if (result?.status !== 'failed') return;
    expect(sanitizeProviderError(result.error, silentLogger)).toBe('internal error');
  });

  test('POST /prompt returns node_errors → failed, sanitizes to upstream rejected', async () => {
    const mock = startMock({
      promptHandler: () =>
        new Response(
          JSON.stringify({
            prompt_id: 'pmt-x',
            number: 0,
            node_errors: { '1': { errors: [{ type: 'value_not_in_list' }] } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    });

    const results = await runProvider(mock.baseUrl, { count: 3 });

    expect(results).toHaveLength(3);
    expect(results.map((result) => result.index)).toEqual([0, 1, 2]);
    for (const result of results) {
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') continue;
      expect(sanitizeProviderError(result.error, silentLogger)).toBe('upstream rejected');
    }
  });

  test('POST /prompt success body is bounded before JSON parsing', async () => {
    const mock = startMock({
      promptHandler: () => Response.json({
        prompt_id: 'pmt-oversized',
        node_errors: {},
        padding: 'x'.repeat(256),
      }),
    });

    const results = await runProvider(mock.baseUrl, { count: 3 }, undefined, 64);
    await drainComfyUi();

    expect(results).toHaveLength(3);
    expect(results.map((result) => result.index)).toEqual([0, 1, 2]);
    for (const result of results) {
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') continue;
      expect(String(result.error)).toContain('ComfyUI response exceeded 64 bytes');
    }
    const promptId = mock.lastPromptBody?.prompt_id;
    if (promptId === undefined) throw new Error('missing submitted job id');
    expect(mock.released).toEqual([promptId]);
  });

  test('WS execution_error frame → failed, sanitizes to internal error', async () => {
    const mock = startMock({
      framesFor: (promptId) => [
        {
          type: 'execution_error',
          data: {
            prompt_id: promptId,
            node_id: '8',
            exception_message: 'CUDA out of memory',
            exception_type: 'RuntimeError',
          },
        },
      ],
    });

    const results = await runProvider(mock.baseUrl);

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result?.status).toBe('failed');
    if (result?.status !== 'failed') return;
    expect(sanitizeProviderError(result.error, silentLogger)).toBe('internal error');
  });

  test('sanitizer maps comfyui websocket failure phrases to connection lost', () => {
    // The adapter throws these phrases verbatim from runOne / awaitCompletion;
    // verifying them against the sanitizer here avoids depending on a real
    // WS teardown handshake (Bun's server.stop blocks on it in tests).
    expect(
      sanitizeProviderError(new Error('comfyui websocket closed before completion'), silentLogger),
    ).toBe('connection lost');
    expect(
      sanitizeProviderError(new Error('comfyui websocket connect failed'), silentLogger),
    ).toBe('connection lost');
    expect(
      sanitizeProviderError(new Error('comfyui websocket error'), silentLogger),
    ).toBe('connection lost');
    expect(
      sanitizeProviderError(new Error('comfyui websocket closed before open'), silentLogger),
    ).toBe('connection lost');
  });

  test('memory output returns non-PNG bytes → failed', async () => {
    const mock = startMock({
      framesFor: (promptId) => executedFrames(promptId),
      imageBytes: new Uint8Array([0x47, 0x49, 0x46, 0x38]),
    });

    const results = await runProvider(mock.baseUrl);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('failed');
  });

  test('Krea accepts a valid low-variance PNG', async () => {
    const gray = await grayCardPng();
    const mock = startMock({
      framesFor: (promptId) => executedFrames(promptId),
      imageBytes: gray,
    });
    const provider = createComfyuiProvider({
      baseUrl: mock.baseUrl,
      privacy: privateWorkerTestPrivacy,
      workflowText: SIMPLE_WORKFLOW,
      maxResponseBytes: 50 * 1024 * 1024,
      saveImageNodeId: '15',
      requiredPlaceholders: ['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{count}}', '{{upscaleShort}}'],
      ratioDims: {
        '1:1': { width: 2048, height: 2048 },
        '4:5': { width: 1600, height: 2000 },
        '3:4': { width: 1536, height: 2048 },
        '16:9': { width: 2048, height: 1152 },
        '9:16': { width: 1152, height: 2048 },
      },
      modelId: 'krea-2-gonzalomo',
      requiredModelFiles: [],
    });
    const out: ProviderResult[] = [];
    for await (const r of provider.generate(providerReq({ ratio: '1:1' }), new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) {
      out.push(r);
    }
    expect(out[0]?.status).toBe('ready');
  });

  test('unsupported ratio yields failed without touching the upstream', async () => {
    const mock = startMock({});
    const results = await runProvider(mock.baseUrl, { ratio: 'banana' as unknown as ProviderRequest['ratio'] });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('failed');
    expect(mock.lastPromptBody).toBeUndefined();
  });

  test('abort signal: in-flight call throws AbortError, does not yield', async () => {
    const mock = startMock({});

    const controller = new AbortController();
    setTimeout(() => { controller.abort(); }, 50);

    const provider = createComfyuiProvider({
      baseUrl: mock.baseUrl,
      privacy: privateWorkerTestPrivacy,
      workflowText: SIMPLE_WORKFLOW,
      maxResponseBytes: 50 * 1024 * 1024,
      saveImageNodeId: '15',
      requiredPlaceholders: ['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{count}}', '{{upscaleShort}}'],
      ratioDims: {
        '1:1': { width: 2048, height: 2048 },
        '4:5': { width: 1600, height: 2000 },
        '3:4': { width: 1536, height: 2048 },
        '16:9': { width: 2048, height: 1152 },
        '9:16': { width: 1152, height: 2048 },
      },
      modelId: 'krea-2-gonzalomo',
      requiredModelFiles: [],
    });
    const iterator = provider.generate(providerReq(), controller.signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS });
    let threw: unknown;
    try {
      for await (const _ of iterator) {
        // should not reach here
      }
    } catch (error) {
      threw = error;
    }

    expect(threw).toBeDefined();
  });

  for (const executing of [false, true]) {
    test(`abort ${executing ? 'during execution' : 'while queued'} releases only its private lease`, async () => {
      const controller = new AbortController();
      const mock = startMock({
        framesFor: (promptId) => {
          // Submission proves the lease is reserved; abort after the frames.
          setTimeout(() => { controller.abort(); }, 20);
          return executing ? [{ type: 'executing', data: { node: '8', prompt_id: promptId } }] : [];
        },
      });
      await rejects(runProvider(mock.baseUrl, {}, controller.signal), Error);
      await drainComfyUi();
      const promptId = mock.lastPromptBody?.prompt_id;
      if (promptId === undefined) throw new Error('missing submitted job id');
      expect(mock.released).toEqual([promptId]);
      expect(mock.calls.some((call) => /\/(queue|interrupt|history|view)(?:$|\/)/.test(call))).toBe(false);
    });
  }

  test('template safely escapes prompts with special chars', () => {
    const filled = buildWorkflow(SIMPLE_WORKFLOW, {
      prompt: 'a "quoted" thing\\nwith\\backslashes',
      seed: 7,
      width: 1024,
      height: 1024,
      count: 1,
    });
    const textInputs = nodeInputs({ prompt: filled, client_id: '' }, '5');
    expect(textInputs.text).toBe('a "quoted" thing\\nwith\\backslashes');
  });

  test('template rejects non-integer seed', () => {
    expect(() =>
      buildWorkflow(SIMPLE_WORKFLOW, { prompt: 'x', seed: 1.5, width: 64, height: 64, count: 1 }),
    ).toThrow(/seed/);
  });

  test('template rejects workflow with an unknown placeholder', () => {
    // Regression: a workflow author introducing a new placeholder (typo,
    // rename, or new param without wiring here) must fail loudly.
    const withUnknown = JSON.stringify({
      '5': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      '7': {
        class_type: 'EmptySD3LatentImage',
        inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 },
      },
      '8': { class_type: 'KSampler', inputs: { seed: '{{seed}}', cfg: 1 } },
      '9': { class_type: 'CustomNode', inputs: { value: '{{somethingElse}}' } },
    });
    expect(() =>
      buildWorkflow(withUnknown, { prompt: 'x', seed: 1, width: 64, height: 64, count: 1 }),
    ).toThrow(/unknown placeholder/);
  });

  test('template rejects workflow that drops a known placeholder', () => {
    // Regression: String.prototype.replace was first-match-only and silently
    // no-op on absence. A workflow that drops a placeholder must fail loudly
    // here, not produce silent semantic corruption (e.g., default seed=0).
    const missingSeed = JSON.stringify({
      '5': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      '7': {
        class_type: 'EmptySD3LatentImage',
        inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 },
      },
      // KSampler missing seed placeholder — the bug we're guarding against
      '8': { class_type: 'KSampler', inputs: { steps: 8, cfg: 1 } },
    });
    expect(() =>
      buildWorkflow(missingSeed, { prompt: 'x', seed: 1, width: 64, height: 64, count: 1 }),
    ).toThrow(/missing placeholder/);
  });

  test('template handles duplicate placeholders via replaceAll', () => {
    // Regression: a workflow with the same placeholder twice (e.g., positive
    // and refiner prompt nodes) must fill BOTH occurrences. The pre-fix
    // single-replace would leave the second `{{prompt}}` as literal text and
    // either crash JSON.parse (because the surrounding quotes were already
    // consumed by replaceAll? actually no — the placeholder is `"{{prompt}}"`
    // including quotes, so JSON stays parseable, but the second node would
    // encode the literal "{{prompt}}" through CLIP).
    const dupWorkflow = JSON.stringify({
      '5': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      '7': {
        class_type: 'EmptySD3LatentImage',
        inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{count}}' },
      },
      '8': { class_type: 'KSampler', inputs: { seed: '{{seed}}', cfg: 1 } },
      '20': { class_type: 'SeedVR2VideoUpscaler', inputs: { resolution: '{{upscaleShort}}' } },
    });
    const filled = buildWorkflow(dupWorkflow, {
      prompt: 'shared text',
      seed: 1,
      width: 64,
      height: 64,
      count: 1,
    });
    expect(nodeInputs({ prompt: filled, client_id: '' }, '5').text).toBe('shared text');
    expect(nodeInputs({ prompt: filled, client_id: '' }, '6').text).toBe('shared text');
  });

  test('ComfyuiUpstreamError carries bounded diagnostics so sanitizer can text-match', () => {
    // Regression: stringifyError emits only `name: message` for Error
    // instances, so a 502 with body "Gateway Timeout" was previously
    // categorized as 'internal error' because the body never reached the
    // sanitizer regex. Folding the body into the message keeps signal.
    const error = new ComfyuiUpstreamError('comfyui rejected', 502, 'Gateway Timeout');
    expect(sanitizeProviderError(error, silentLogger)).toBe('timed out');
  });

  test('template handles a user prompt that mimics a scalar placeholder', () => {
    // Regression: with the prompt substituted first, a prompt of `{{seed}}`
    // would shadow the seed placeholder downstream. Scalars must substitute
    // before the prompt so the user text is JSON-quoted before any further
    // String.replace sees it.
    const filled = buildWorkflow(SIMPLE_WORKFLOW, {
      prompt: '{{seed}}',
      seed: 9999,
      width: 1024,
      height: 1024,
      count: 1,
    });
    expect(nodeInputs({ prompt: filled, client_id: '' }, '5').text).toBe('{{seed}}');
    expect(nodeInputs({ prompt: filled, client_id: '' }, '8').seed).toBe(9999);
  });

  test('recovers memory output completed before the POST response is consumed', async () => {
    // The lease UUID lets the adapter attribute executing/binary/terminal
    // frames before learning the HTTP acknowledgment.
    const mock = startMock({
      framesFor: (promptId) => executedFrames(promptId),
      preflushFramesBeforePostResponse: true,
    });

    const results = await runProvider(mock.baseUrl);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('ready');
    expect(results[0]).toMatchObject({ bytes: png });
  });

  test('drainComfyUi resolves cleanly when nothing is in flight', async () => {
    // The private release drain is awaitable and idempotent when empty.
    await drainComfyUi();
    await drainComfyUi();
  });
});

// ---------------------------------------------------------------------------
// KREA save-node tests: non-'15' saveImageNodeId is honored for binary frames.
// ---------------------------------------------------------------------------

function kreaProvider(baseUrl: string, modelId = 'krea-2-gonzalomo') {
  return createComfyuiProvider({
    baseUrl,
    privacy: privateWorkerTestPrivacy,
    workflowText: KREA_WORKFLOW,
    maxResponseBytes: 50 * 1024 * 1024,
    saveImageNodeId: '9',
    requiredPlaceholders: ['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{count}}', '{{upscaleShort}}'],
    ratioDims: { '1:1': { width: 1024, height: 1024 } },
    requiredModelFiles: [],
    modelId,
  });
}

describe('KREA save-node (saveImageNodeId: "9")', () => {
  test('honors a non-15 save node id in WS executed frame', async () => {
    const mock = startMock({ framesFor: (id) => privateImageFrames(id, '9', png) });
    const out: ProviderResult[] = [];
    for await (const r of kreaProvider(mock.baseUrl).generate(providerReq({ ratio: '1:1' }), new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) {
      out.push(r);
    }
    expect(out[0]?.status).toBe('ready');
  });

});

describe('VRAM eviction (model-switch guard, all local jobs)', () => {
  // Declare one terminal per graph; the other graph's frames remain uncorrelated.
  const bothNodeFrames = (id: string) => [...executedFrames(id).slice(0, -1), ...privateImageFrames(id, '9', png)];

  async function drain(iter: AsyncIterable<ProviderResult>): Promise<void> {
    for await (const _ of iter) { /* drain */ }
  }

  test('an image job evicts resident VRAM (POST /free) before its first /prompt', async () => {
    const mock = startMock({ framesFor: (id) => executedFrames(id) });
    await runProvider(mock.baseUrl); // GonzaLomo on a fresh host → model switch
    expect(mock.freeCallCount).toBe(1);
    expect(mock.lastPromptBody).toBeDefined();
  });

  test('repeat generation with the same model skips eviction (no second /free)', async () => {
    const mock = startMock({ framesFor: (id) => executedFrames(id) });
    await runProvider(mock.baseUrl);
    await runProvider(mock.baseUrl); // same model, same host → already resident
    expect(mock.freeCallCount).toBe(1);
  });

  for (const previous of ['another-producer', 'restart'] as const) {
    test(`${previous} invalidates an otherwise matching warm model`, async () => {
      const mock = startMock({ framesFor: (id) => executedFrames(id) });
      await runProvider(mock.baseUrl);
      mock.recordPrompt(previous === 'restart' ? null : crypto.randomUUID());
      await runProvider(mock.baseUrl);
      expect(mock.freeCallCount).toBe(2);
    });
  }

  test('A success then B failure requires eviction when returning to A', async () => {
    const mock = startMock({ framesFor: bothNodeFrames, failPrompts: [2] });
    expect((await runProvider(mock.baseUrl))[0]?.status).toBe('ready');
    await drain(kreaProvider(mock.baseUrl, 'minimax-h3-i2v').generate(
      providerReq({ ratio: '1:1', modelId: 'minimax-h3-i2v' }), new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS },
    ));
    expect((await runProvider(mock.baseUrl))[0]?.status).toBe('ready');
    expect(mock.freeCallCount).toBe(3);
  });

  test('switching models on the same host evicts again', async () => {
    const mock = startMock({ framesFor: bothNodeFrames });
    await runProvider(mock.baseUrl); // GonzaLomo
    await drain(kreaProvider(mock.baseUrl, 'minimax-h3-i2v').generate(
      providerReq({ ratio: '1:1', modelId: 'minimax-h3-i2v' }),
      new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS },
    ));
    expect(mock.freeCallCount).toBe(2);
  });

  test('models sharing a residency key skip eviction between them', async () => {
    const mock = startMock({ framesFor: bothNodeFrames });
    const h3Provider = (modelId: string) => createComfyuiProvider({
      baseUrl: mock.baseUrl,
      privacy: privateWorkerTestPrivacy,
      workflowText: KREA_WORKFLOW,
      maxResponseBytes: 50 * 1024 * 1024,
      saveImageNodeId: '9',
      requiredPlaceholders: ['{{prompt}}', '{{seed}}', '{{width}}', '{{height}}', '{{count}}', '{{upscaleShort}}'],
      ratioDims: { '1:1': { width: 1024, height: 1024 } },
      requiredModelFiles: [],
      modelId,
      residencyKey: 'minimax-h3',
    });

    await drain(h3Provider('minimax-h3-i2v').generate(
      providerReq({ ratio: '1:1', modelId: 'minimax-h3-i2v' }),
      new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS },
    ));
    await drain(h3Provider('minimax-h3-t2v').generate(
      providerReq({ ratio: '1:1', modelId: 'minimax-h3-t2v' }),
      new AbortController().signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS },
    ));

    expect(mock.freeCallCount).toBe(1);
  });

  test('a failed job does NOT pin the model — the next same-model job re-evicts', async () => {
    // Regression guard: residency is recorded only after a successful runJob.
    // If the load fails (here a 500 at /prompt), the model must not be pinned,
    // or every same-model retry would skip the eviction that could clear VRAM.
    const mock = startMock({ framesFor: (id) => executedFrames(id), failFirstNPrompts: 1 });
    const first = await runProvider(mock.baseUrl); // evict (free #1), /prompt 500 → failed, NOT pinned
    expect(first[0]?.status).toBe('failed');
    const second = await runProvider(mock.baseUrl); // not pinned → evict again (free #2), succeeds
    expect(second[0]?.status).toBe('ready');
    expect(mock.freeCallCount).toBe(2);
  });
});
