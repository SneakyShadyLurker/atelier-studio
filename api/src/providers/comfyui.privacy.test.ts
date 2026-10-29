import { afterEach, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import type { ServerWebSocket } from 'bun';
import { createComfyuiProvider, drainComfyUi } from './comfyui';
import { TEST_EXECUTION_TIMEOUT_MS, currentWorkerPrivacy, privateWorkerTestPrivacy, privateWorkerTestTls } from '../test/private-worker-fixture';
import { pngBytes } from '../test/image-fixtures';

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { await drainComfyUi(); await Promise.all(stops.splice(0).map((stop) => stop())); });
const REQUEST = { prompt: 'synthetic privacy canary', modelId: 'private-test', ratio: '1:1' as const, tileIndex: 0, seed: 4 };

function fixture(options: { metadata?: unknown; running?: boolean; lostDelete?: boolean; holdFree?: boolean;
  previousPromptId?: unknown; omitPrevious?: boolean } = {}) {
  const calls: string[] = [];
  const leaseBodies: unknown[] = [];
  let submitted = '';
  let deletes = 0;
  let completed = false;
  const output = crypto.randomUUID();
  const png = pngBytes();
  let markFree: () => void = () => undefined;
  const freeStarted = new Promise<void>((resolve) => { markFree = resolve; });
  let resumeFree: () => void = () => undefined;
  const freeGate = new Promise<void>((resolve) => { resumeFree = resolve; });
  const sockets = new Set<ServerWebSocket>();
  const server = Bun.serve({
    port: 0, tls: privateWorkerTestTls,
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      calls.push(`${req.method} ${path}`);
      if (req.headers.get('Authorization') !== `Bearer ${privateWorkerTestPrivacy.token}`) return new Response(null, { status: 401 });
      if (path === '/atelier/v1/privacy') return Response.json(options.metadata ?? currentWorkerPrivacy);
      if (path === '/ws') return server.upgrade(req) ? undefined : new Response(null, { status: 426 });
      if (path === '/free') {
        if (options.holdFree) { markFree(); await freeGate; }
        return new Response(null);
      }
      if (path === '/system_stats') return Response.json({ devices: [{ vram_total: 100, vram_free: 100 }] });
      if (path.endsWith('/renew')) return Response.json({ ok: true });
      if (path.includes('/outputs/')) return new Response(png, { headers: { 'Content-Type': 'image/png' } });
      if (path.startsWith('/atelier/v1/jobs/')) {
        if (req.method === 'POST') {
          leaseBodies.push(await req.json());
          return Response.json({ protocol: 2, ready: true,
            ...(!options.omitPrevious ? { previous_prompt_id: options.previousPromptId ?? null } : {}) });
        }
        if (req.method === 'DELETE') {
          deletes += 1;
          if (options.lostDelete && deletes === 1) { server.timeout(req, 0); return new Response(null, { status: 503 }); }
          return Response.json({ ok: true });
        }
        return Response.json({ state: completed ? 'completed' : 'running', outputs: completed ? [{ id: output, bytes: png.length, mediaType: 'image/png' }] : [] });
      }
      if (path === '/prompt') {
        const body = await req.json() as { prompt_id: string; prompt: Record<string, { class_type: string }> };
        submitted = body.prompt_id;
        expect(body.prompt['9']?.class_type).toBe('AtelierSaveImages');
        completed = !options.running;
        for (const socket of sockets) socket.send(JSON.stringify({ type: 'execution_success', data: { prompt_id: submitted } }));
        return Response.json({ prompt_id: submitted });
      }
      return new Response(null, { status: 404 });
    },
    websocket: { open(ws) { sockets.add(ws); }, message: () => undefined, close(ws) { sockets.delete(ws); } },
  });
  stops.push(async () => { resumeFree(); for (const socket of sockets) socket.close(); await server.stop(true); });
  const provider = createComfyuiProvider({
    baseUrl: `https://127.0.0.1:${server.port}`, privacy: privateWorkerTestPrivacy,
    workflowText: '{"9":{"class_type":"SaveImageWebsocket","inputs":{"text":"{{prompt}}"}}}',
    maxResponseBytes: 1024 * 1024, saveImageNodeId: '9', requiredPlaceholders: ['{{prompt}}'],
    ratioDims: { '1:1': { width: 32, height: 32 } }, modelId: 'private-test', requiredModelFiles: [],
  });
  return { provider, calls, leaseBodies, freeStarted, resumeFree, get submitted() { return submitted; }, get deletes() { return deletes; } };
}

test('negotiates the canonical long-video budget without clamping steps or frames', async () => {
  const worker = fixture();
  const results = await Array.fromAsync(worker.provider.generate(REQUEST, AbortSignal.timeout(2_000), { executionTimeoutMs: 47_903_226 }));
  expect(results).toMatchObject([{ status: 'ready' }]);
  expect(worker.leaseBodies).toEqual([{ previews: true, imageOutputs: true, executionTimeoutSeconds: 47_904 }]);
});

test('a missing canonical execution budget fails before contacting the worker', async () => {
  const worker = fixture();
  const results = await Array.fromAsync(worker.provider.generate(REQUEST, AbortSignal.timeout(2_000)));
  expect(results).toMatchObject([{ status: 'failed' }]);
  expect(worker.calls).toEqual([]);
});

for (const [metadata, executionTimeoutMs] of [
  [currentWorkerPrivacy, 86_400_001], [currentWorkerPrivacy, 0], [currentWorkerPrivacy, -1], [currentWorkerPrivacy, Infinity],
  [{ ...currentWorkerPrivacy, limits: { ...currentWorkerPrivacy.limits, max_execution_seconds: 1 } }, 1_001],
  [{ ...currentWorkerPrivacy, limits: { ...currentWorkerPrivacy.limits, max_execution_seconds: 0 } }, 1_000],
] as const) {
  test(`incompatible execution budget ${executionTimeoutMs} fails before lease allocation or GPU preparation`, async () => {
    const worker = fixture({ metadata });
    const results = await Array.fromAsync(worker.provider.generate(REQUEST, AbortSignal.timeout(2_000), { executionTimeoutMs }));
    expect(results).toMatchObject([{ status: 'failed' }]);
    expect(worker.calls).toEqual(['GET /atelier/v1/privacy']);
    expect(worker.leaseBodies).toEqual([]);
  });
}

for (const options of [{ omitPrevious: true }, { previousPromptId: 'not-a-uuid' }, { previousPromptId: 4 }]) {
  test(`advertised residency tracking requires a valid admission identity: ${JSON.stringify(options)}`, async () => {
    const worker = fixture(options);
    const results = await Array.fromAsync(worker.provider.generate(REQUEST, AbortSignal.timeout(2_000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    expect(results).toMatchObject([{ status: 'failed' }]);
    await drainComfyUi();
    expect(worker.deletes).toBe(1);
    expect(worker.calls).not.toContain('POST /free');
    expect(worker.calls).not.toContain('POST /prompt');
  });
}

for (const metadata of [{ ...currentWorkerPrivacy, ready: false }, { protocol: 1, ready: true },
  { ...currentWorkerPrivacy, capabilities: { ...currentWorkerPrivacy.capabilities, job_admission: false } }]) {
  test(`generation rejects incomplete private baseline before any content: ${JSON.stringify(metadata)}`, async () => {
    const worker = fixture({ metadata });
    const results = await Array.fromAsync(worker.provider.generate(REQUEST, AbortSignal.timeout(2_000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
    expect(results).toMatchObject([{ status: 'failed' }]);
    expect(worker.calls).toEqual(['GET /atelier/v1/privacy']);
  });
}

test('successful output waits for storage acknowledgment and cancellation retries through real HTTP', async () => {
  const worker = fixture({ lostDelete: true });
  for await (const result of worker.provider.generate(REQUEST, AbortSignal.timeout(2_000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })) {
    expect(result.status).toBe('ready');
    expect(worker.deletes).toBe(0);
    if (result.status === 'ready') await Promise.all([result.afterStored?.(), drainComfyUi()]);
  }
  await drainComfyUi();
  expect(worker.deletes).toBe(2);
  expect(worker.calls.filter((call) => call === 'POST /prompt')).toHaveLength(1);
  expect(worker.calls.some((call) => /\/view|\/history|\/interrupt|\/upload/.test(call))).toBe(false);
});

test('running cancellation delivers DELETE after request abort and retries refusal', async () => {
  const worker = fixture({ running: true, lostDelete: true });
  const signal = AbortSignal.timeout(150);
  const started = performance.now();
  await rejects(Array.fromAsync(worker.provider.generate(REQUEST, signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS })), (error: unknown) => error === signal.reason);
  expect(performance.now() - started).toBeLessThan(500);
  await drainComfyUi();
  expect(worker.submitted).not.toBe('');
  expect(worker.deletes).toBe(2);
  expect(worker.calls.filter((call) => call === 'POST /prompt')).toHaveLength(1);
});

test('fresh allowlist fails readiness and generation before uploads or GPU preparation', async () => {
  const worker = fixture({ metadata: { ...currentWorkerPrivacy, allowed_nodes: ['CLIPTextEncode'] } });
  expect(await worker.provider.healthCheck?.(AbortSignal.timeout(2_000))).toMatchObject({ ok: false, probeCode: 'privacy_not_ready' });
  const results = await Array.fromAsync(worker.provider.generate(REQUEST, AbortSignal.timeout(2_000), { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
  expect(results).toMatchObject([{ status: 'failed' }]);
  expect(worker.calls.some((call) => /\/inputs\/|\/free|\/prompt|\/object_info/.test(call))).toBe(false);
});

test('shutdown drain cancels in-flight preparation and never submits a released lease', async () => {
  const worker = fixture({ holdFree: true });
  const signal = AbortSignal.timeout(2_000);
  const generation = Array.fromAsync(worker.provider.generate(REQUEST, signal, { executionTimeoutMs: TEST_EXECUTION_TIMEOUT_MS }));
  try {
    await worker.freeStarted;
    await drainComfyUi();
    const results = await generation;
    expect(results).toMatchObject([{ status: 'failed' }]);
    expect(signal.aborted).toBe(false);
    expect(worker.calls).not.toContain('POST /prompt');
    expect(worker.calls.some((call) => call.includes('/ws'))).toBe(false);
    expect(worker.deletes).toBe(1);
  } finally { worker.resumeFree(); }
});
