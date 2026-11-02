import { afterEach, expect, spyOn, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { createPrivacyTransport, drainPrivacyLeases } from './privacy';
import { TEST_EXECUTION_TIMEOUT_MS, currentWorkerPrivacy } from '../../test/private-worker-fixture';
import { abortReason } from '../../lifecycle/abort';

const BASE = 'https://worker.test:7860';
const config = { token: 'synthetic-worker-token', ca: 'synthetic-trust-anchor' };
const signal = () => AbortSignal.timeout(2_000);
let restore: (() => void) | undefined;
afterEach(async () => { await drainPrivacyLeases(); restore?.(); });

test('unconfigured/plaintext transport never sends content', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ready: true, protocol: 1 }));
  restore = () => { fetch.mockRestore(); };
  await rejects(createPrivacyTransport('http://worker.test', config).handshake(signal()), /TLS/);
  await rejects(createPrivacyTransport(BASE, { ...config, token: undefined }).handshake(signal()), /TLS/);
  expect(fetch).not.toHaveBeenCalled();
});

test('requires active privacy controls and rejects incompatible workers', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ready: false, protocol: 1 }));
  restore = () => { fetch.mockRestore(); };
  await rejects(createPrivacyTransport(BASE, config).handshake(signal()), /not ready/);
});

test('uses raw input, owned memory outputs and explicit storage acknowledgment', async () => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    calls.push({ path, init });
    if (path.includes('/outputs/')) return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
    return Promise.resolve(Response.json({ previous_prompt_id: null, ...currentWorkerPrivacy, ok: true }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  const transport = createPrivacyTransport(BASE, config);
  await transport.handshake(signal());
  const job = await transport.createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
  const payload = new Uint8Array([8, 9]);
  const reference = await job.upload(payload, signal());
  const workflow = {
    '1': { class_type: 'LoadImage', inputs: { image: reference } },
    '2': { class_type: 'SaveVideo', inputs: { filename_prefix: 'video/atelier', codec: 'h264' } },
  };
  job.transform(workflow);
  expect(workflow['1'].class_type).toBe('AtelierLoadImage');
  expect(workflow['2'].inputs).not.toHaveProperty('filename_prefix');
  expect(workflow['2'].inputs).toHaveProperty('job_id', job.id);
  expect(calls.find((call) => call.init?.method === 'PUT')?.init?.body).toBe(payload);
  await rejects(job.download({ filename: 'secret.mp4', subfolder: '', type: 'output' }, 50, signal()), /persistent/);
  const output = { filename: crypto.randomUUID(), subfolder: job.id, type: 'atelier-memory' };
  expect(await job.download(output, 50, signal())).toEqual(new Uint8Array([1, 2, 3]));
  expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
  await rejects(job.download(output, 2, signal()), /too large/);
  await job.release();
  expect(calls.at(-1)?.init?.method).toBe('DELETE');
  for (const call of calls) {
    expect(new Headers(call.init?.headers).get('Authorization')).toBe(`Bearer ${config.token}`);
    expect(call.init).toHaveProperty('redirect', 'error');
    expect(call.init).toHaveProperty('tls.ca', config.ca);
  }
});

test('private requests cannot redirect credentials to another origin', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
  restore = () => { fetch.mockRestore(); };
  await rejects(createPrivacyTransport(BASE, config).fetch('https://other.test'), /origin/);
  expect(fetch).not.toHaveBeenCalled();
});

test('memory sinks are capability gated, preserve image edges and keep image/video preview policy', async () => {
  const leases: unknown[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') leases.push(typeof init.body === 'string' ? JSON.parse(init.body) : null);
    return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  const transport = createPrivacyTransport(BASE, config);
  const image = await transport.createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
  const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    '9': { class_type: 'SaveImageWebsocket', inputs: { images: ['8', 0] } },
  };
  image.transform(graph);
  expect(graph['9']).toEqual({ class_type: 'AtelierSaveImages', inputs: { images: ['8', 0], job_id: image.id } });
  const video = await transport.createJob(signal(), TEST_EXECUTION_TIMEOUT_MS, 'video');
  expect(leases).toEqual([
    { previews: true, imageOutputs: true, executionTimeoutSeconds: TEST_EXECUTION_TIMEOUT_MS / 1_000 },
    { previews: false, imageOutputs: false, executionTimeoutSeconds: TEST_EXECUTION_TIMEOUT_MS / 1_000 },
  ]);
  await image.release();
  await video.release();
});

test('scoped status rejects duplicate identities and invalid media/byte handles', async () => {
  let status: unknown = { state: 'completed', outputs: [] };
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    return Promise.resolve(Response.json(path.includes('/jobs/') && !init?.method ? status : { ...currentWorkerPrivacy, previous_prompt_id: null }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  const job = await createPrivacyTransport(BASE, config).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
  const handle = { id: crypto.randomUUID(), bytes: 3, mediaType: 'image/png' };
  for (const outputs of [[handle, handle], [{ ...handle, id: 'other-job/file' }],
    [{ ...handle, bytes: 0 }], [{ ...handle, bytes: 1.5 }], [{ ...handle, mediaType: 'text/plain' }]]) {
    status = { state: 'completed', outputs };
    await rejects(job.status(signal()), /invalid memory output/);
  }
  status = { state: 'completed', outputs: [{ ...handle, mediaType: 'video/mp4' }] };
  expect((await job.status(signal())).outputs[0]?.mediaType).toBe('video/mp4');
  await job.release();
});

test('download checks the advertised media type and exact byte count', async () => {
  let contentType = 'image/png';
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    return Promise.resolve(path.includes('/outputs/') ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': contentType } })
      : Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  const job = await createPrivacyTransport(BASE, config).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
  const ref = { filename: crypto.randomUUID(), subfolder: job.id, type: 'atelier-memory', mediaType: 'image/png', bytes: 4 };
  await rejects(job.download(ref, 20, signal()), /byte count mismatch/);
  contentType = 'video/mp4';
  await rejects(job.download({ ...ref, bytes: 3 }, 20, signal()), /media type mismatch/);
  await job.release();
});

test('completion awaits initial renewal; abort stops it and releases the original lease once', async () => {
  let renewSignal: AbortSignal | undefined;
  let startedRenew: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { startedRenew = resolve; });
  const deletes: string[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    if (path.endsWith('/renew')) {
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeUndefined();
      renewSignal = init?.signal ?? undefined;
      const pendingSignal = renewSignal;
      startedRenew?.();
      return new Promise<Response>((_resolve, reject) => {
        pendingSignal?.addEventListener('abort', () => { reject(abortReason(pendingSignal)); }, { once: true });
      });
    }
    if (init?.method === 'DELETE') deletes.push(path);
    return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  const controller = new AbortController();
  const job = await createPrivacyTransport(BASE, config).createJob(controller.signal, TEST_EXECUTION_TIMEOUT_MS);
  let completed = false;
  const owned = job.own(controller.signal).then(() => { completed = true; });
  const rejected = rejects(owned);
  await started;
  expect(completed).toBe(false);
  controller.abort();
  await rejected;
  await job.release();
  expect(renewSignal?.aborted).toBe(true);
  expect(deletes).toEqual([`/atelier/v1/jobs/${job.id}`]);
});

for (const status of [404, 503]) {
  test(`renewal ${status} ${status === 404 ? 'is terminal' : 'has at most three total attempts'}`, async () => {
    let attempts = 0;
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (path.endsWith('/renew')) { attempts += 1; return Promise.resolve(new Response(null, { status })); }
      return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
    }, { preconnect: globalThis.fetch.preconnect }));
    restore = () => { fetch.mockRestore(); };
    const job = await createPrivacyTransport(BASE, config).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
    try {
      await rejects(job.own(AbortSignal.timeout(3000)), /privacy request failed/);
      expect(attempts).toBe(status === 404 ? 1 : 3);
    } finally { await job.release(); }
  });
}

for (const statuses of [[408, 429, 200], [503, 503, 503], [401], [403], [404]]) {
  test(`download HTTP retry boundary ${statuses.join(',')}`, async () => {
    let attempts = 0;
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (!path.includes('/outputs/')) return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
      const status = statuses[attempts++] ?? 503;
      return Promise.resolve(new Response(status === 200 ? new Uint8Array([1, 2, 3]) : null, { status }));
    }, { preconnect: globalThis.fetch.preconnect }));
    restore = () => { fetch.mockRestore(); };
    const job = await createPrivacyTransport(BASE, config).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
    try {
      const ref = { filename: crypto.randomUUID(), subfolder: job.id, type: 'atelier-memory', bytes: 3 };
      const downloaded = job.download(ref, 20, signal());
      if (statuses.at(-1) === 200) expect(await downloaded).toEqual(new Uint8Array([1, 2, 3]));
      else await rejects(downloaded, /privacy request failed/);
      expect(attempts).toBe(statuses.length);
    } finally { await job.release(); }
  });
}

test('network/body failures retry with fresh readers and preserve exact bytes', async () => {
  let attempts = 0;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request) => {
    if (!new URL(input instanceof Request ? input.url : input).pathname.includes('/outputs/')) return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
    attempts += 1;
    if (attempts === 1) return Promise.reject(new TypeError('synthetic connection lost'));
    if (attempts === 2) return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new TypeError('synthetic body disconnect')); },
    })));
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  const job = await createPrivacyTransport(BASE, config).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
  try {
    expect(await job.download({ filename: crypto.randomUUID(), subfolder: job.id, type: 'atelier-memory', bytes: 3 }, 20, signal()))
      .toEqual(new Uint8Array([1, 2, 3]));
    expect(attempts).toBe(3);
  } finally { await job.release(); }
});

test('each stalled output body has a sixty-second deadline and at most three attempts, using short fake deadlines', async () => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const deadlines: number[] = [];
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    deadlines.push(ms);
    return nativeTimeout(ms === 60_000 ? 10 : ms);
  });
  let attempts = 0;
  let canceled = 0;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request) => {
    if (!new URL(input instanceof Request ? input.url : input).pathname.includes('/outputs/')) return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
    attempts += 1;
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { canceled += 1; },
    })));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { timeout.mockRestore(); fetch.mockRestore(); };
  const job = await createPrivacyTransport(BASE, config).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
  try {
    await rejects(job.download({ filename: crypto.randomUUID(), subfolder: job.id, type: 'atelier-memory' }, 20, signal()));
    expect(attempts).toBe(3);
    expect(canceled).toBe(3);
    expect(deadlines.filter((ms) => ms === 60_000)).toHaveLength(3);
  } finally { await job.release(); }
});

test('retrieval keeps the worker absolute cap across later completed observations', async () => {
  let now = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  let reads = 0;
  let canceled = 0;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request) => {
    if (!new URL(input instanceof Request ? input.url : input).pathname.includes('/outputs/')) return Promise.resolve(Response.json({ previous_prompt_id: null,
      ...currentWorkerPrivacy, limits: { ...currentWorkerPrivacy.limits, terminal_max_seconds: 90 },
    }));
    reads += 1;
    return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { canceled += 1; } })));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { clock.mockRestore(); fetch.mockRestore(); };
  const job = await createPrivacyTransport(BASE, config).createJob(new AbortController().signal, TEST_EXECUTION_TIMEOUT_MS);
  try {
    job.boundRetrieval(0);
    now = 89_995;
    job.boundRetrieval(now); // A later completion observation cannot restart retention.
    await rejects(job.download({ filename: crypto.randomUUID(), subfolder: job.id, type: 'atelier-memory' }, 20, signal()));
    expect(reads).toBe(1);
    expect(canceled).toBe(1);
    now = 90_001;
    expect(() => { job.boundRetrieval(now); }).toThrow(/retrieval expired/);
  } finally { await job.release(); }
});

for (const missing of ['job_status', 'image_outputs', 'preview_control', 'lease_renewal', 'job_admission', 'execution_budget', 'residency_tracking']) {
  test(`protocol 2 rejects missing ${missing} before leasing or uploading`, async () => {
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ previous_prompt_id: null, ...currentWorkerPrivacy,
      capabilities: { ...currentWorkerPrivacy.capabilities, [missing]: false } }));
    restore = () => { fetch.mockRestore(); };
    await rejects(createPrivacyTransport(BASE, config).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS), /capabilities required/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
}

for (const metadata of [{ protocol: 1 }, { worker_build: undefined }, { worker_build: 'secret' },
  { allowed_nodes: undefined }, { limits: {} }, { limits: { ...currentWorkerPrivacy.limits, max_images: 0 } },
  { limits: { ...currentWorkerPrivacy.limits, max_execution_seconds: undefined } }]) {
  test(`incomplete current worker contract fails closed: ${JSON.stringify(metadata)}`, async () => {
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ previous_prompt_id: null, ...currentWorkerPrivacy, ...metadata }));
    restore = () => { fetch.mockRestore(); };
    await rejects(createPrivacyTransport(BASE, config).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
}

test('video requires current video status capability', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ previous_prompt_id: null, ...currentWorkerPrivacy,
    capabilities: { ...currentWorkerPrivacy.capabilities, video_outputs: false } }));
  restore = () => { fetch.mockRestore(); };
  await rejects(createPrivacyTransport(BASE, config).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS, 'video'), /video outputs required/);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('release retries failed network delivery after abort and coalesces with drain and concurrent callers', async () => {
  let deletes = 0;
  let recovery: (() => void) | undefined;
  const retry = new Promise<void>((resolve) => { recovery = resolve; });
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== 'DELETE') return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
    expect(init.signal?.aborted).toBe(false);
    deletes += 1;
    if (deletes === 1) return Promise.reject(new TypeError('offline'));
    recovery?.();
    return Promise.resolve(new Response(null, { status: 404 }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  const controller = new AbortController();
  const job = await createPrivacyTransport(BASE, config).createJob(controller.signal, TEST_EXECUTION_TIMEOUT_MS);
  controller.abort();
  await Promise.all([job.release(), job.release(), drainPrivacyLeases(), retry]);
  expect(deletes).toBe(2);
  await job.release();
  await drainPrivacyLeases();
  expect(deletes).toBe(2);
});

test('exhausted release remains drainable after recovery and logs no identifiers or content', async () => {
  let online = false;
  let deletes = 0;
  const warnings: unknown[] = [];
  const nativeTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeTimeout(fn, ms === 30_000 ? 20 : ms, ...args)) as typeof setTimeout);
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== 'DELETE') return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
    deletes += 1;
    if (!online) return Promise.reject(new TypeError('private network failure'));
    return Promise.resolve(new Response(null));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { timer.mockRestore(); fetch.mockRestore(); };
  const job = await createPrivacyTransport(BASE, config, { info: () => undefined, warn(fields, message) { warnings.push({ fields, message }); } }).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
  await job.release();
  expect(warnings).toEqual([{ fields: { event: 'comfyui_lease_release', outcome: 'exhausted' }, message: 'ComfyUI lease release delivery exhausted' }]);
  online = true;
  await drainPrivacyLeases();
  expect(deletes).toBe(2);
  await job.release();
  expect(deletes).toBe(2);
});

test('lease admission retries only definite busy, keeps identity/body and clamps Retry-After', async () => {
  const posts: Request[] = [];
  const delays: number[] = [];
  const nativeTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 250 || ms === 5_000) { delays.push(ms); return nativeTimeout(fn, 1, ...args); }
    return nativeTimeout(fn, ms, ...args);
  }) as typeof setTimeout);
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input.url : String(input), init);
    if (request.method !== 'POST') return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
    posts.push(request);
    if (posts.length < 3) return Promise.resolve(Response.json({ error: 'worker_busy' }, { status: 429, headers: { 'Retry-After': posts.length === 1 ? '0' : '9000' } }));
    return Promise.resolve(Response.json({ previous_prompt_id: null, protocol: 2, ready: true }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { timer.mockRestore(); fetch.mockRestore(); };
  const job = await createPrivacyTransport(BASE, config).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
  expect(posts).toHaveLength(3);
  expect(new Set(posts.map((request) => request.url)).size).toBe(1);
  expect(await Promise.all(posts.map((request) => request.json()))).toEqual(Array(3).fill({
    previews: true, imageOutputs: true, executionTimeoutSeconds: TEST_EXECUTION_TIMEOUT_MS / 1_000,
  }));
  expect(delays).toEqual([250, 5_000]);
  await job.release();
});

test('admission cancellation promptly stops waiting without DELETE for a refused lease', async () => {
  const calls: string[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: string | URL | Request, init?: RequestInit) => {
    calls.push(init?.method ?? 'GET');
    return Promise.resolve(init?.method === 'POST' ? Response.json({ error: 'worker_busy' }, { status: 429, headers: { 'Retry-After': '5' } }) : Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  const controller = new AbortController();
  const started = performance.now();
  await rejects(createPrivacyTransport(BASE, config).createJob(controller.signal, TEST_EXECUTION_TIMEOUT_MS, 'image', () => { controller.abort(new Error('cancel queue')); }), /cancel queue/);
  expect(performance.now() - started).toBeLessThan(500);
  await drainPrivacyLeases();
  expect(calls).toEqual(['GET', 'POST']);
});

for (const retryAfter of ['Mon, 26 Oct 2026 12:00:00 GMT', 'invalid', '1e2', '-2']) {
  test(`nonnumeric Retry-After uses one second: ${retryAfter}`, async () => {
    let posts = 0;
    const delays: number[] = [];
    const nativeTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === 1_000) { delays.push(ms); return nativeTimeout(fn, 1, ...args); }
      return nativeTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST' && ++posts === 1) return Promise.resolve(Response.json({ error: 'worker_busy' }, { status: 429, headers: { 'Retry-After': retryAfter } }));
      return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
    }, { preconnect: globalThis.fetch.preconnect }));
    restore = () => { timer.mockRestore(); fetch.mockRestore(); };
    const job = await createPrivacyTransport(BASE, config).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
    expect(posts).toBe(2);
    expect(delays).toEqual([1_000]);
    await job.release();
  });
}

test('admission has its own bound inside the unchanged overall request deadline', async () => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => nativeTimeout(ms === 120_000 ? 20 : ms));
  let posts = 0;
  let deletes = 0;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') { posts += 1; return Promise.resolve(Response.json({ error: 'worker_busy' }, { status: 429, headers: { 'Retry-After': '5' } })); }
    if (init?.method === 'DELETE') deletes += 1;
    return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { timeout.mockRestore(); fetch.mockRestore(); };
  const overall = new AbortController();
  await rejects(createPrivacyTransport(BASE, config).createJob(overall.signal, TEST_EXECUTION_TIMEOUT_MS), (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError');
  expect(overall.signal.aborted).toBe(false);
  await drainPrivacyLeases();
  expect(posts).toBe(1);
  expect(deletes).toBe(0);
});

for (const refusal of ['network', 'invalid-body', 'conflict', 'generic-429', 'malformed-429', 'oversized-429'] as const) {
  test(`ambiguous or definitive nonbusy lease POST is never retried: ${refusal}`, async () => {
    let posts = 0;
    const accepted = new Set<string>();
    const released: string[] = [];
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === 'DELETE') { released.push(url); accepted.delete(url); }
      if (init?.method !== 'POST') return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
      posts += 1;
      if (refusal !== 'conflict') accepted.add(url);
      if (refusal === 'network') return Promise.reject(new TypeError('lost acknowledgment'));
      if (refusal.endsWith('429')) return Promise.resolve(new Response(refusal === 'generic-429' ? '{"error":"rate_limited"}'
        : refusal === 'oversized-429' ? 'x'.repeat(1_025) : '{', { status: 429 }));
      return Promise.resolve(new Response(refusal === 'invalid-body' ? '{' : null, { status: refusal === 'conflict' ? 409 : 200 }));
    }, { preconnect: globalThis.fetch.preconnect }));
    restore = () => { fetch.mockRestore(); };
    await rejects(createPrivacyTransport(BASE, config).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS));
    await drainPrivacyLeases();
    expect(posts).toBe(1);
    expect(accepted.size).toBe(0);
    expect(released.length).toBe(refusal === 'conflict' ? 0 : 1);
  });
}

test('repeated ambiguous creation failures bound retained cleanup entries and timers', async () => {
  let online = false;
  let posts = 0;
  const accepted = new Set<string>();
  const deadlines = new Set<unknown>();
  const nativeTimeout = globalThis.setTimeout;
  const nativeClear = globalThis.clearTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = nativeTimeout(fn, ms === 30_000 ? 10 : ms, ...args);
    if (ms === 30_000) deadlines.add(handle);
    return handle;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
    if (handle) deadlines.delete(handle);
    Reflect.apply(nativeClear, globalThis, [handle]);
  });
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === 'POST') { posts += 1; accepted.add(url); return Promise.reject(new TypeError('accepted but acknowledgment lost')); }
    if (init?.method === 'DELETE') {
      if (!online) return Promise.reject(new TypeError('network unavailable'));
      accepted.delete(url);
    }
    return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { timer.mockRestore(); clear.mockRestore(); fetch.mockRestore(); };
  try {
    const transport = createPrivacyTransport(BASE, config);
    for (let index = 0; index < 128; index += 1) await rejects(transport.createJob(new AbortController().signal, TEST_EXECUTION_TIMEOUT_MS));
    expect(posts).toBeGreaterThan(0);
    expect(posts).toBeLessThan(128);
    expect(deadlines.size).toBeLessThanOrEqual(posts);
    await drainPrivacyLeases();
    expect(deadlines.size).toBe(0);
  } finally {
    online = true;
    await drainPrivacyLeases();
  }
  expect(accepted.size).toBe(0);
  expect(deadlines.size).toBe(0);
});

test('a real request recovers an exhausted full registry without shutdown drain', async () => {
  let online = false;
  let warnings = 0;
  let markExhausted: () => void = () => undefined;
  const exhausted = new Promise<void>((resolve) => { markExhausted = resolve; });
  const accepted = new Set<string>();
  const nativeTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeTimeout(fn, ms === 30_000 ? 50 : ms, ...args)) as typeof setTimeout);
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === 'POST') {
      if (online) expect(accepted.size).toBe(0);
      accepted.add(url);
      return online ? Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null })) : Promise.reject(new TypeError('accepted without acknowledgment'));
    }
    if (init?.method === 'DELETE') {
      if (!online) return Promise.reject(new TypeError('offline'));
      accepted.delete(url);
    }
    return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { timer.mockRestore(); fetch.mockRestore(); };
  const transport = createPrivacyTransport(BASE, config, { info: () => undefined, warn() {
    warnings += 1;
    if (warnings === 64) markExhausted();
  } });
  try {
    const failed = await Promise.allSettled(Array.from({ length: 64 }, () => transport.createJob(new AbortController().signal, TEST_EXECUTION_TIMEOUT_MS)));
    expect(failed.every((result) => result.status === 'rejected')).toBe(true);
    await exhausted;
    expect(accepted.size).toBe(64);
    online = true;
    const successor = await transport.createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
    expect(accepted).toEqual(new Set([`${BASE}/atelier/v1/jobs/${successor.id}`]));
    await successor.release();
    expect(accepted.size).toBe(0);
  } finally { online = true; }
});

test('exhausted cleanup coalesces across new callers, survives wait cancellation and excludes live storage', async () => {
  let offline = false;
  let stale = '';
  let recoveryDeletes = 0;
  let recoveryStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => { recoveryStarted = resolve; });
  let finishDelete: (response: Response) => void = () => undefined;
  const liveDeletes: string[] = [];
  const nativeTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeTimeout(fn, ms === 30_000 ? 50 : ms, ...args)) as typeof setTimeout);
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/renew')) return Promise.resolve(Response.json({ ok: true }));
    if (init?.method === 'DELETE') {
      if (url.endsWith(stale)) {
        if (offline) return Promise.reject(new TypeError('offline'));
        recoveryDeletes += 1;
        recoveryStarted();
        return new Promise<Response>((resolve) => { finishDelete = resolve; });
      }
      liveDeletes.push(url);
    }
    return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { timer.mockRestore(); fetch.mockRestore(); };
  const transport = createPrivacyTransport(BASE, config);
  const live = await transport.createJob(new AbortController().signal, TEST_EXECUTION_TIMEOUT_MS);
  await live.own(new AbortController().signal);
  const abandoned = await transport.createJob(new AbortController().signal, TEST_EXECUTION_TIMEOUT_MS);
  stale = abandoned.id;
  offline = true;
  await abandoned.release();
  offline = false;
  const caller = new AbortController();
  const canceled = transport.createJob(caller.signal, TEST_EXECUTION_TIMEOUT_MS);
  const rejected = rejects(canceled, /stop waiting/);
  await started;
  const successor = transport.createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
  caller.abort(new Error('stop waiting'));
  await rejected;
  expect(liveDeletes).toEqual([]);
  expect(recoveryDeletes).toBe(1);
  finishDelete(Response.json({ ok: true }));
  const next = await successor;
  expect(recoveryDeletes).toBe(1);
  expect(liveDeletes).toEqual([]);
  await next.release();
  await live.release();
});

test('busy admission recovers an intent that exhausted after the initial recovery pass', async () => {
  let online = true;
  let stale = '';
  let posts = 0;
  let staleDeleted = false;
  let waitingPost: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => { waitingPost = resolve; });
  let refuse: (response: Response) => void = () => undefined;
  const nativeTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeTimeout(fn, ms === 30_000 ? 50 : ms === 250 ? 1 : ms, ...args)) as typeof setTimeout);
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (init?.method === 'DELETE' && url.endsWith(stale)) {
      if (!online) return Promise.reject(new TypeError('offline'));
      staleDeleted = true;
    }
    if (init?.method === 'POST') {
      posts += 1;
      if (posts === 2) { waitingPost(); return new Promise<Response>((resolve) => { refuse = resolve; }); }
      if (posts === 3) expect(staleDeleted).toBe(true);
    }
    return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { timer.mockRestore(); fetch.mockRestore(); };
  const transport = createPrivacyTransport(BASE, config);
  const old = await transport.createJob(new AbortController().signal, TEST_EXECUTION_TIMEOUT_MS);
  stale = old.id;
  online = false;
  const releasing = old.release();
  const creating = transport.createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
  await waiting;
  await releasing;
  online = true;
  refuse(Response.json({ error: 'worker_busy' }, { status: 429, headers: { 'Retry-After': '0' } }));
  const next = await creating;
  expect(posts).toBe(3);
  await next.release();
});

for (const outcome of ['accepted', 'busy'] as const) {
  test(`drain wins a deferred ${outcome} reservation and no job or retry escapes`, async () => {
    let postSignal: AbortSignal | undefined;
    let posted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { posted = resolve; });
    let finish: (response: Response) => void = () => undefined;
    let posts = 0;
    const accepted = new Set<string>();
    const deleted: string[] = [];
    let reservedUrl = '';
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === 'POST') {
        posts += 1;
        reservedUrl = url;
        postSignal = init.signal ?? undefined;
        posted();
        // Deliberately ignore abort, modeling an already delivered POST whose
        // completion crosses shutdown drain's cancellation intent.
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      if (init?.method === 'DELETE') { deleted.push(url); accepted.delete(url); }
      return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
    }, { preconnect: globalThis.fetch.preconnect }));
    restore = () => { fetch.mockRestore(); };
    const creating = createPrivacyTransport(BASE, config).createJob(new AbortController().signal, TEST_EXECUTION_TIMEOUT_MS);
    const rejected = rejects(creating, /released|drained/);
    await started;
    const draining = drainPrivacyLeases();
    try {
      expect(postSignal?.aborted).toBe(true);
      expect(deleted).toEqual([]);
    } finally {
      if (outcome === 'accepted') accepted.add(reservedUrl);
      finish(outcome === 'accepted' ? Response.json({ previous_prompt_id: null, protocol: 2, ready: true })
        : Response.json({ error: 'worker_busy' }, { status: 429 }));
    }
    await Promise.all([rejected, draining]);
    expect(posts).toBe(1);
    expect(deleted).toEqual([reservedUrl]);
    expect(accepted.size).toBe(0);
  });
}

test('drained leases cannot upload, renew or transform a workflow after cleanup', async () => {
  const methods: string[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    return Promise.resolve(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  const job = await createPrivacyTransport(BASE, config).createJob(signal(), TEST_EXECUTION_TIMEOUT_MS);
  await drainPrivacyLeases();
  await rejects(job.upload(new Uint8Array([1]), signal()), /released/);
  await rejects(job.own(signal()), /released/);
  expect(() => { job.transform({}); }).toThrow(/released/);
  expect(methods).toEqual(['GET', 'POST', 'DELETE']);
});

test('drain fences a deferred readiness handshake before any reservation can be sent', async () => {
  let finish: (response: Response) => void = () => undefined;
  const methods: string[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    return new Promise<Response>((resolve) => { finish = resolve; });
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  const creating = createPrivacyTransport(BASE, config).createJob(new AbortController().signal, TEST_EXECUTION_TIMEOUT_MS);
  const rejected = rejects(creating, /drained/);
  await drainPrivacyLeases();
  finish(Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
  await rejected;
  expect(methods).toEqual(['GET']);
});

test('drain fences busy admission waits without retrying or canceling a refused UUID', async () => {
  const methods: string[] = [];
  let draining: Promise<void> | undefined;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((_input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    return Promise.resolve(init?.method === 'POST'
      ? Response.json({ error: 'worker_busy' }, { status: 429, headers: { 'Retry-After': '5' } })
      : Response.json({ ...currentWorkerPrivacy, previous_prompt_id: null }));
  }, { preconnect: globalThis.fetch.preconnect }));
  restore = () => { fetch.mockRestore(); };
  await rejects(createPrivacyTransport(BASE, config).createJob(new AbortController().signal, TEST_EXECUTION_TIMEOUT_MS, 'image', () => {
    draining = drainPrivacyLeases();
  }), /drained/);
  await draining;
  expect(methods).toEqual(['GET', 'POST']);
});
