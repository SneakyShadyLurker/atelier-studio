import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { AdminModel, AdminProvider, ConnectionReport, ListedModel, TestReport } from '@atelier/shared';
import type { TextAvailabilityHandle } from '../lifecycle/text-availability';
import { UNKNOWN_TEXT_AVAILABILITY } from '../routing/textServices';
import { testRuntime } from '../test/helpers';
import { hostPortProbeResponse, isHostPortProbe } from '../test/hostProbe';
import { resetTextProbeAdmissionForTests } from './textProviders';

// Admin API (spec § 10.2) against a scripted local upstream. The upstream
// decides each answer from the request; tests assert on what the API returns,
// stores and logs.

const ADMINS = 'alice,bob,carol';
// Not a token shape redactSecrets knows: only the per-provider scrub catches it.
const KEY = 'plain-provider-credential-0042';

type Runtime = ReturnType<typeof testRuntime>;
type Handler = (req: Request) => Response | Promise<Response>;

const okList: Handler = () => Response.json({ data: [{ id: 'm-1' }, { id: 'm-2', architecture: { input_modalities: ['text', 'image'] } }] });
const okChat: Handler = () => Response.json({
  id: 'c1',
  created: 0,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: '{"answer":"OK"}' }, finish_reason: 'stop' }],
});

let server: ReturnType<typeof Bun.serve>;
let base = '';
let list: Handler = okList;
let chat: Handler = okChat;
const seenAuth: (string | null)[] = [];
const gates: (() => void)[] = [];
let arrivals: (() => void)[] = [];

/** A handler that waits until `open()`; `arrived` resolves when a request reaches it. */
function gated(then: Handler): { handler: Handler; arrived: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  gates.push(open);
  let arrive = (): void => undefined;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  arrivals.push(arrive);
  return {
    handler: async (req) => {
      arrive();
      await gate;
      return then(req);
    },
    arrived,
    open,
  };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      if (isHostPortProbe(req)) return hostPortProbeResponse();
      seenAuth.push(req.headers.get('authorization'));
      return req.method === 'GET' ? list(req) : chat(req);
    },
  });
  base = `http://127.0.0.1:${server.port}/v1`;
});

afterAll(() => {
  void server.stop(true);
});

afterEach(() => {
  for (const open of gates) open();
  gates.length = 0;
  arrivals = [];
  seenAuth.length = 0;
  list = okList;
  chat = okChat;
  resetTextProbeAdmissionForTests();
});

function headers(user = 'alice'): Record<string, string> {
  return { 'Content-Type': 'application/json', 'Remote-User': user };
}

function call(rt: Runtime, method: string, path: string, body?: unknown, user = 'alice', init: RequestInit = {}): Promise<Response> {
  return rt.fetch(`/api${path}`, {
    method,
    headers: headers(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...init,
  });
}

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

function admin(overrides: Record<string, unknown> = {}): Runtime {
  return testRuntime({ TEXT_PROVIDER_ADMINS: ADMINS, ...overrides });
}

async function createProvider(rt: Runtime, body: Record<string, unknown> = {}): Promise<AdminProvider> {
  return json<AdminProvider>(
    await call(rt, 'POST', '/text-providers', { name: 'Local', protocol: 'openai-compatible', baseUrl: base, ...body }),
    201,
  );
}

async function createModels(rt: Runtime, providerId: string, models: unknown[]): Promise<AdminModel[]> {
  return json<AdminModel[]>(await call(rt, 'POST', `/text-providers/${providerId}/models`, { models }), 201);
}

async function providers(rt: Runtime): Promise<AdminProvider[]> {
  return (await json<{ providers: AdminProvider[] }>(await call(rt, 'GET', '/text-providers'), 200)).providers;
}

function draftTest(rt: Runtime, body: Record<string, unknown> = {}, user = 'alice', init: RequestInit = {}): Promise<Response> {
  return call(rt, 'POST', '/text-providers/test', { protocol: 'openai-compatible', baseUrl: base, ...body }, user, init);
}

describe('admin gate and CSRF', () => {
  const routes: readonly [string, string][] = [
    ['GET', '/text-providers'],
    ['POST', '/text-providers'],
    ['POST', '/text-providers/test'],
    ['PATCH', '/text-providers/p1'],
    ['DELETE', '/text-providers/p1'],
    ['POST', '/text-providers/p1/test'],
    ['POST', '/text-providers/p1/refresh'],
    ['GET', '/text-providers/p1/models/available'],
    ['POST', '/text-providers/p1/models'],
    ['PATCH', '/text-providers/p1/models/m1'],
    ['DELETE', '/text-providers/p1/models/m1'],
    ['POST', '/text-providers/p1/models/m1/test'],
    ['PUT', '/text-routing/defaults/default'],
    ['PUT', '/text-routing/writers/gpt-image-2.5-sunburst'],
  ];

  test.each(routes)('a non-admin gets 404 on %s %s', async (method, path) => {
    const rt = admin();
    const res = await call(rt, method, path, method === 'GET' || method === 'DELETE' ? undefined : {}, 'mallory');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  test('nobody is an admin by default', async () => {
    const rt = testRuntime();
    expect((await call(rt, 'GET', '/text-providers')).status).toBe(404);
  });

  test('an admin write without Origin is refused by the CSRF guard; a same-origin one passes', async () => {
    const rt = admin({ CSRF_PROTECT: 'true' });
    const body = { name: 'Local', protocol: 'openai-compatible', baseUrl: base };
    expect((await call(rt, 'POST', '/text-providers', body, 'alice', {
      headers: { ...headers(), Host: 'atelier.local' },
    })).status).toBe(403);
    expect((await call(rt, 'POST', '/text-providers', body, 'alice', {
      headers: { ...headers(), Host: 'atelier.local', Origin: 'https://atelier.local' },
    })).status).toBe(201);
  });
});

describe('GET /api/text-providers', () => {
  test('returns providers with nested models, usage, status and credential metadata only', async () => {
    const rt = admin();
    const created = await createProvider(rt, { apiKey: KEY });
    const [model] = await createModels(rt, created.id, [{ modelId: 'm-1' }]);
    await json(await call(rt, 'PUT', '/text-routing/defaults/default', { modelId: model?.id }), 200);

    const res = await call(rt, 'GET', '/text-providers');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const raw = await res.text();
    expect(raw).not.toContain(KEY);
    expect(raw).not.toMatch(/ciphertext|nonce|secret/i);
    const [provider] = (JSON.parse(raw) as { providers: AdminProvider[] }).providers;
    expect(provider).toMatchObject({
      id: created.id,
      name: 'Local',
      auth: 'stored',
      fingerprint: expect.any(String) as string,
      listedCount: null,
      warnings: [],
    });
    expect(provider?.models).toHaveLength(1);
    expect(provider?.models[0]).toMatchObject({
      modelId: 'm-1',
      status: 'unknown',
      usage: { isDefault: true, tasks: [], writers: [], userPicks: 0 },
    });
    expect(provider?.models[0]).not.toHaveProperty('legacyKey');
  });

  test('an env-auth provider reports its variable name, never its value', async () => {
    const rt = admin({ seedLegacyText: true });
    const [provider] = await providers(rt);
    expect(provider).toMatchObject({ auth: 'env', envVar: 'CLIPROXY_TOKEN' });
    expect(provider).not.toHaveProperty('fingerprint');
    expect(JSON.stringify(provider)).not.toContain(rt.config.CLIPROXY_TOKEN);
  });

  test('warns when a model screens requests without OPENROUTER_API_KEY', async () => {
    const rt = admin();
    const provider = await createProvider(rt);
    const [model] = await createModels(rt, provider.id, [{ modelId: 'm-1' }]);
    expect((await providers(rt))[0]?.warnings).toEqual([]);
    await json(await call(rt, 'PATCH', `/text-providers/${provider.id}/models/${model?.id}`, { screenRequests: true }), 200);
    expect((await providers(rt))[0]?.warnings).toEqual(['screen-requests-without-key']);

    const keyed = admin({ OPENROUTER_API_KEY: 'or-key' });
    const other = await createProvider(keyed);
    await createModels(keyed, other.id, [{ modelId: 'm-1' }]);
    const [m] = (await providers(keyed))[0]?.models ?? [];
    await json(await call(keyed, 'PATCH', `/text-providers/${other.id}/models/${m?.id}`, { screenRequests: true }), 200);
    expect((await providers(keyed))[0]?.warnings).toEqual([]);
  });

  test('warns that stored keys are unavailable without a master key', async () => {
    const rt = admin({ disableByok: true });
    await createProvider(rt);
    expect((await providers(rt))[0]?.warnings).toEqual(['byok-not-configured']);
  });
});

describe('provider writes', () => {
  test('POST creates a provider (201) and bumps the revision; a duplicate name is 409', async () => {
    const rt = admin();
    const before = rt.text.store.revision();
    const provider = await createProvider(rt, { preset: 'ollama', tokenField: 'max_tokens', listModels: false });
    expect(provider).toMatchObject({ auth: 'none', preset: 'ollama', tokenField: 'max_tokens', listModels: false, models: [] });
    expect(rt.text.store.revision()).toBeGreaterThan(before);
    const dup = await call(rt, 'POST', '/text-providers', { name: 'local', protocol: 'openai-compatible', baseUrl: base });
    expect(dup.status).toBe(409);
  });

  test('POST rejects a base URL with a query string with the shared plain message', async () => {
    const rt = admin();
    const res = await call(rt, 'POST', '/text-providers', { name: 'X', protocol: 'anthropic', baseUrl: `${base}?a=1` });
    expect(res.status).toBe(400);
  });

  test('POST and PATCH with apiKey answer 503 byok-not-configured without a master key', async () => {
    const rt = admin({ disableByok: true });
    const res = await call(rt, 'POST', '/text-providers', { name: 'X', protocol: 'openai-compatible', baseUrl: base, apiKey: KEY });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'byok-not-configured' });
    const provider = await createProvider(rt);
    const patched = await call(rt, 'PATCH', `/text-providers/${provider.id}`, { apiKey: KEY });
    expect(patched.status).toBe(503);
    expect(await patched.json()).toEqual({ error: 'byok-not-configured' });
  });

  test('PATCH replaces and removes the key, renames, and 404s an unknown id', async () => {
    const rt = admin();
    const provider = await createProvider(rt);
    const keyed = await json<AdminProvider>(await call(rt, 'PATCH', `/text-providers/${provider.id}`, { apiKey: KEY, name: 'Renamed' }), 200);
    expect(keyed).toMatchObject({ auth: 'stored', name: 'Renamed', fingerprint: expect.any(String) as string });
    const cleared = await json<AdminProvider>(await call(rt, 'PATCH', `/text-providers/${provider.id}`, { apiKey: null }), 200);
    expect(cleared.auth).toBe('none');
    expect(cleared).not.toHaveProperty('fingerprint');
    expect((await call(rt, 'PATCH', '/text-providers/missing', { name: 'X' })).status).toBe(404);
  });

  test('PATCH apiKey on an env-auth provider is 400', async () => {
    const rt = admin({ seedLegacyText: true });
    const [provider] = await providers(rt);
    const res = await call(rt, 'PATCH', `/text-providers/${provider?.id}`, { apiKey: KEY });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('environment');
  });

  test('DELETE cascades models and routing; an unknown id is 404', async () => {
    const rt = admin();
    const provider = await createProvider(rt);
    const [model] = await createModels(rt, provider.id, [{ modelId: 'm-1' }]);
    await json(await call(rt, 'PUT', '/text-routing/defaults/enhance', { modelId: model?.id }), 200);
    const before = rt.text.store.revision();
    expect(await json<{ ok: boolean }>(await call(rt, 'DELETE', `/text-providers/${provider.id}`), 200)).toEqual({ ok: true });
    expect(rt.text.store.revision()).toBeGreaterThan(before);
    expect(await providers(rt)).toEqual([]);
    expect(rt.text.store.readDefaults()).toEqual({ byTask: {} });
    expect((await call(rt, 'DELETE', `/text-providers/${provider.id}`)).status).toBe(404);
  });
});

describe('model writes', () => {
  test('POST adds models (201) with list hints as starting values; a duplicate id is 409', async () => {
    const rt = admin();
    const provider = await createProvider(rt);
    const [plain, hinted] = await createModels(rt, provider.id, [
      { modelId: 'm-1' },
      { modelId: 'm-2', displayName: 'Vision', hints: { vision: true, structuredOutput: 'json_schema', reasoningLevels: ['low', 'high'], contextLength: 8000 } },
    ]);
    expect(plain).toMatchObject({ modelId: 'm-1', displayName: 'm-1', vision: false, structuredOutput: 'json_object', status: 'unknown' });
    expect(hinted).toMatchObject({ displayName: 'Vision', vision: true, structuredOutput: 'json_schema', reasoningLevels: ['low', 'high'], reasoningDefault: null });
    const dup = await call(rt, 'POST', `/text-providers/${provider.id}/models`, { models: [{ modelId: 'm-1' }] });
    expect(dup.status).toBe(409);
    expect((await call(rt, 'POST', '/text-providers/missing/models', { models: [{ modelId: 'x' }] })).status).toBe(404);
  });

  test('PATCH validates combinations and accepts fixed effort and screenRequests', async () => {
    const rt = admin();
    const provider = await createProvider(rt);
    const [model] = await createModels(rt, provider.id, [{ modelId: 'm-1' }]);
    const path = `/text-providers/${provider.id}/models/${model?.id}`;

    const notListed = await call(rt, 'PATCH', path, { reasoningLevels: ['low', 'high'], reasoningDefault: 'medium' });
    expect(notListed.status).toBe(400);
    expect(((await notListed.json()) as { error: string }).error).toContain('reasoning');
    expect((await call(rt, 'PATCH', path, { maxImages: 2 })).status).toBe(400);
    expect((await call(rt, 'PATCH', path, { reasoningLevels: ['bogus'] })).status).toBe(400);

    const fixed = await json<AdminModel>(await call(rt, 'PATCH', path, { reasoningLevels: [], reasoningDefault: 'medium' }), 200);
    expect(fixed).toMatchObject({ reasoningLevels: [], reasoningDefault: 'medium' });
    const edited = await json<AdminModel>(await call(rt, 'PATCH', path, {
      vision: true, maxImages: 4, screenRequests: true, displayName: 'M', enabled: false, sortOrder: 3, temperature: 0.7,
    }), 200);
    expect(edited).toMatchObject({ vision: true, maxImages: 4, screenRequests: true, displayName: 'M', enabled: false, sortOrder: 3, temperature: 0.7 });
  });

  test('a model is addressed only under its own provider', async () => {
    const rt = admin();
    const a = await createProvider(rt, { name: 'A' });
    const b = await createProvider(rt, { name: 'B' });
    const [model] = await createModels(rt, a.id, [{ modelId: 'm-1' }]);
    expect((await call(rt, 'PATCH', `/text-providers/${b.id}/models/${model?.id}`, { enabled: false })).status).toBe(404);
    expect((await call(rt, 'DELETE', `/text-providers/${b.id}/models/${model?.id}`)).status).toBe(404);
    expect((await call(rt, 'POST', `/text-providers/${b.id}/models/${model?.id}/test`)).status).toBe(404);
  });

  test('GET reports usage before DELETE, which cascades and bumps the revision', async () => {
    const rt = admin();
    const provider = await createProvider(rt);
    const [model] = await createModels(rt, provider.id, [{ modelId: 'm-1' }]);
    const id = model?.id ?? '';
    await json(await call(rt, 'PUT', '/text-routing/defaults/rescue', { modelId: id }), 200);
    await json(await call(rt, 'PUT', '/text-routing/writers/gpt-image-2.5-sunburst', { modelId: id, mode: 'lock' }), 200);
    rt.text.store.writeUserPick('bob', 'enhance', { modelId: id, effort: null });

    expect((await providers(rt))[0]?.models[0]?.usage).toEqual({
      isDefault: false, tasks: ['rescue'], writers: ['gpt-image-2.5-sunburst'], userPicks: 1,
    });
    const before = rt.text.store.revision();
    expect(await json<{ ok: boolean }>(await call(rt, 'DELETE', `/text-providers/${provider.id}/models/${id}`), 200)).toEqual({ ok: true });
    expect(rt.text.store.revision()).toBeGreaterThan(before);
    expect(rt.text.store.readDefaults()).toEqual({ byTask: {} });
    expect(rt.text.store.readWriters()).toEqual({});
    expect(rt.text.store.readUserPicks('bob')).toEqual({});
  });
});

describe('connection test and model list', () => {
  test('an unsaved draft is tested against the local server', async () => {
    const rt = admin();
    const report = await json<ConnectionReport>(await draftTest(rt, { apiKey: KEY }), 200);
    expect(report).toMatchObject({ ok: true, listedCount: 2 });
    expect(seenAuth).toEqual([`Bearer ${KEY}`]);
  });

  test('a foreign GET / port probe on the upstream is not counted as provider traffic', async () => {
    const rt = admin();
    const provider = await createProvider(rt, { apiKey: KEY });
    // What a desktop port scanner sends to every new localhost listener.
    await fetch(`http://127.0.0.1:${server.port}/`);
    const report = await json<ConnectionReport>(await call(rt, 'POST', `/text-providers/${provider.id}/test`), 200);
    expect(report.ok).toBe(true);
    expect(seenAuth).toEqual([`Bearer ${KEY}`]);
  });

  test('a redirecting server fails the report, which says redirects are not followed', async () => {
    const rt = admin();
    list = () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:1/v1/models' } });
    const report = await json<ConnectionReport>(await draftTest(rt), 200);
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.message).toMatch(/redirect/i);
  });

  test('listing off without probeModelId is 400 with a plain message; with one it sends a completion', async () => {
    const rt = admin();
    const res = await draftTest(rt, { listModels: false });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Name a model to test with/);
    const report = await json<ConnectionReport>(await draftTest(rt, { listModels: false, probeModelId: 'm-1' }), 200);
    expect(report).toMatchObject({ ok: true, checks: [{ id: 'completion', status: 'pass' }] });
  });

  test('a draft test sends the token field the provider will use', async () => {
    const rt = admin();
    const bodies: Record<string, unknown>[] = [];
    chat = async (req) => {
      bodies.push(await req.json() as Record<string, unknown>);
      return okChat(req);
    };
    const probe = { listModels: false, probeModelId: 'm-1' };
    expect(await json<ConnectionReport>(await draftTest(rt, { ...probe, tokenField: 'max_tokens' }), 200)).toMatchObject({ ok: true });
    expect(await json<ConnectionReport>(await draftTest(rt, probe), 200)).toMatchObject({ ok: true });
    expect(bodies[0]).toHaveProperty('max_tokens');
    expect(bodies[0]).not.toHaveProperty('max_completion_tokens');
    expect(bodies[1]).toHaveProperty('max_completion_tokens');
    expect((await draftTest(rt, { tokenField: 'bogus' })).status).toBe(400);
  });

  test('a saved provider is tested with its stored key', async () => {
    const rt = admin();
    const provider = await createProvider(rt, { apiKey: KEY });
    const report = await json<ConnectionReport>(await call(rt, 'POST', `/text-providers/${provider.id}/test`), 200);
    expect(report.ok).toBe(true);
    expect(seenAuth).toEqual([`Bearer ${KEY}`]);
    expect((await call(rt, 'POST', '/text-providers/missing/test')).status).toBe(404);
  });

  test('models/available lists with hints; a failing list is 502 with a plain message', async () => {
    const rt = admin();
    const provider = await createProvider(rt);
    const listed = await json<{ models: ListedModel[]; listUnsupported: boolean }>(
      await call(rt, 'GET', `/text-providers/${provider.id}/models/available`),
      200,
    );
    expect(listed.listUnsupported).toBe(false);
    expect(listed.models.map((m) => m.id)).toEqual(['m-1', 'm-2']);
    expect(listed.models[1]?.hints?.vision).toBe(true);

    list = () => new Response('boom', { status: 500 });
    const failed = await call(rt, 'GET', `/text-providers/${provider.id}/models/available`);
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toContain('500');
  });
});

describe('shared admission limiter', () => {
  test('a second concurrent call by one admin is 429 across endpoint types', async () => {
    const rt = admin();
    const provider = await createProvider(rt);
    const [model] = await createModels(rt, provider.id, [{ modelId: 'm-1' }]);
    const slow = gated(okList);
    list = slow.handler;
    const first = draftTest(rt);
    await slow.arrived;

    expect((await draftTest(rt)).status).toBe(429);
    expect((await call(rt, 'POST', `/text-providers/${provider.id}/test`)).status).toBe(429);
    expect((await call(rt, 'GET', `/text-providers/${provider.id}/models/available`)).status).toBe(429);
    expect((await call(rt, 'POST', `/text-providers/${provider.id}/models/${model?.id}/test`)).status).toBe(429);

    slow.open();
    expect((await first).status).toBe(200);
  });

  test('a third concurrent call across admins is 429', async () => {
    const rt = admin();
    const slow = gated(okList);
    list = slow.handler;
    const first = draftTest(rt, {}, 'alice');
    const second = draftTest(rt, {}, 'bob');
    await slow.arrived;
    // Both reached the limiter; the gate holds both upstream.
    await Bun.sleep(20);

    const third = await draftTest(rt, {}, 'carol');
    expect(third.status).toBe(429);
    slow.open();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect((await draftTest(rt, {}, 'carol')).status).toBe(200);
  });

  test('slots are released after success and after failure', async () => {
    const rt = admin();
    const provider = await createProvider(rt);
    expect((await draftTest(rt)).status).toBe(200);
    list = () => new Response('down', { status: 500 });
    expect((await call(rt, 'GET', `/text-providers/${provider.id}/models/available`)).status).toBe(502);
    expect((await draftTest(rt)).status).toBe(200);
    list = okList;
    expect((await call(rt, 'GET', `/text-providers/${provider.id}/models/available`)).status).toBe(200);
  });

  test('a client abort releases the slot', async () => {
    const rt = admin();
    const slow = gated(okList);
    list = slow.handler;
    const controller = new AbortController();
    const aborted = draftTest(rt, {}, 'alice', { signal: controller.signal });
    await slow.arrived;
    controller.abort();
    await aborted.catch(() => undefined);

    list = okList;
    expect((await draftTest(rt)).status).toBe(200);
  });
});

describe('POST /api/text-providers/:id/models/:mid/test', () => {
  async function setupModel(rt: Runtime, providerBody: Record<string, unknown> = {}) {
    const provider = await createProvider(rt, providerBody);
    const [model] = await createModels(rt, provider.id, [{ modelId: 'm-1' }]);
    if (!model) throw new Error('no model');
    return { provider, model, path: `/text-providers/${provider.id}/models/${model.id}` };
  }

  test('a passing run persists the report and verifiedAt without bumping the revision', async () => {
    const rt = admin();
    const { model, path } = await setupModel(rt);
    const before = rt.text.store.revision();
    const report = await json<TestReport>(await call(rt, 'POST', `${path}/test`), 200);
    expect(report.checks.map((check) => check.id)).toEqual(['plain', 'json', 'image', 'reasoning']);
    expect(report.checks.some((check) => check.status === 'fail')).toBe(false);

    const stored = rt.text.store.getModel(model.id);
    expect(stored?.lastTest).toEqual(report);
    expect(stored?.verifiedAt).toEqual(expect.any(Number) as number);
    expect(rt.text.store.revision()).toBe(before);
  });

  test('a failing run persists the report and leaves verifiedAt unset', async () => {
    const rt = admin();
    const { model, path } = await setupModel(rt);
    chat = () => new Response('nope', { status: 500 });
    const report = await json<TestReport>(await call(rt, 'POST', `${path}/test`), 200);
    expect(report.checks[0]).toMatchObject({ id: 'plain', status: 'fail' });
    const stored = rt.text.store.getModel(model.id);
    expect(stored?.lastTest).toEqual(report);
    expect(stored?.verifiedAt).toBeNull();
  });

  test('capability edits made while the test runs are kept', async () => {
    const rt = admin();
    const { model, path } = await setupModel(rt);
    const slow = gated(okChat);
    chat = slow.handler;
    const running = call(rt, 'POST', `${path}/test`);
    await slow.arrived;
    await json(await call(rt, 'PATCH', path, { vision: true, displayName: 'Edited' }, 'bob'), 200);
    chat = okChat;
    slow.open();
    await json<TestReport>(await running, 200);

    expect(rt.text.store.getModel(model.id)).toMatchObject({ vision: true, displayName: 'Edited', verifiedAt: expect.any(Number) as number });
  });

  test('an upstream echoing the key leaks it into no report, response or log', async () => {
    const rt = admin({ LOG_LEVEL: 'debug' });
    const { provider, path } = await setupModel(rt, { apiKey: KEY });
    const echo: Handler = (req) => new Response(`rejected credential ${req.headers.get('authorization') ?? ''}`, { status: 500 });
    list = echo;
    chat = echo;

    const bodies = [
      await (await call(rt, 'POST', `${path}/test`)).text(),
      await (await call(rt, 'POST', `/text-providers/${provider.id}/test`)).text(),
      await (await call(rt, 'GET', `/text-providers/${provider.id}/models/available`)).text(),
      await (await draftTest(rt, { apiKey: KEY })).text(),
    ];
    for (const body of bodies) {
      expect(body).not.toContain(KEY);
      expect(body).toContain('[redacted]');
    }
    const stored = rt.text.store.listModels(provider.id)[0]?.lastTest;
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect(rt.logs.length).toBeGreaterThan(0);
    expect(rt.logs.join('\n')).not.toContain(KEY);
    expect(rt.logs.join('\n')).toContain('[redacted]');
  });
});

describe('POST /api/text-providers/:id/refresh', () => {
  /** Availability whose poll for a provider waits for `open()`, then lists `m-1`. */
  function scriptedAvailability() {
    const listed = new Map<string, ReadonlySet<string>>();
    const polled: string[] = [];
    let open = (): void => undefined;
    let gate: Promise<void> = Promise.resolve();
    const handle: TextAvailabilityHandle = {
      ...UNKNOWN_TEXT_AVAILABILITY,
      snapshot: (providerId) => listed.get(providerId) ?? null,
      statusOf: (model) => {
        const set = listed.get(model.providerId);
        if (set === undefined) return 'unknown';
        return set.has(model.modelId) ? 'available' : 'offline';
      },
      refresh: async (providerId) => {
        polled.push(providerId);
        await gate;
        listed.set(providerId, new Set(['m-1']));
      },
    };
    return {
      handle,
      polled,
      hold: () => { gate = new Promise<void>((resolve) => { open = resolve; }); },
      open: () => { open(); },
    };
  }

  test('awaits one poll and answers the fresh provider without bumping the revision', async () => {
    const availability = scriptedAvailability();
    const rt = admin({ textAvailability: availability.handle });
    const provider = await createProvider(rt);
    await createModels(rt, provider.id, [{ modelId: 'm-1' }, { modelId: 'm-2' }]);
    availability.polled.length = 0;
    const before = rt.text.store.revision();

    availability.hold();
    let settled = false;
    const pending = call(rt, 'POST', `/text-providers/${provider.id}/refresh`).then((res) => {
      settled = true;
      return res;
    });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    availability.open();

    const fresh = await json<AdminProvider>(await pending, 200);
    expect(availability.polled).toEqual([provider.id]);
    expect(fresh).toMatchObject({ id: provider.id, listedCount: 1 });
    expect(fresh.models.map((model) => [model.modelId, model.status])).toEqual([['m-1', 'available'], ['m-2', 'offline']]);
    expect(rt.text.store.revision()).toBe(before);
  });

  test('an unknown provider is 404', async () => {
    const rt = admin();
    expect((await call(rt, 'POST', '/text-providers/missing/refresh')).status).toBe(404);
  });
});
