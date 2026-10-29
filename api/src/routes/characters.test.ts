import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { allowJevForProviderTests, resetJevForProviderTests } from '../test/jev-fixture';
import { setCliproxyTextProviderForTests, type BrainstormCharactersInput, type TestCliproxyTextProvider } from '../providers/cliproxyText';
import { resetLlmAdmissionForTests } from '../orchestrator/llmAdmission';
import { textBackendModels } from '../providers/cliproxyText.config';
import { parseSse, restoreFetch, testRuntime, testConfig } from '../test/helpers';
import { BRAINSTORM_FIELD_SEPARATOR, BRAINSTORM_RECORD_SEPARATOR } from '../prompts/brainstormCharactersSystemPrompt';
import { writeTextBackendOverride } from '../routing/textBackendPreference';

const TEXT_MODELS = textBackendModels(testConfig());

const servers: Bun.Server<unknown>[] = [];

beforeEach(() => {
  allowJevForProviderTests();
  restoreFetch();
});

afterEach(async () => {
  resetJevForProviderTests();
  restoreFetch();
  setCliproxyTextProviderForTests(null);
  resetLlmAdmissionForTests();
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

function serveCapture(requests: Record<string, unknown>[]): string {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>);
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

// Answers by upstream model: a status number replies with that error status
// (a 5xx maps to a transient failure), a string replies with a valid one-record
// brainstorm SSE stream. Every request body is captured for assertions.
function serveByModel(
  requests: Record<string, unknown>[],
  answers: Record<string, number | 'record' | 'content_filter' | 'insufficient_system_resource' | 'in_stream_timeout'>,
): string {
  const record = ['scene', 'subject', 'details'].join(`\n${BRAINSTORM_FIELD_SEPARATOR}\n`);
  const contentFrame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `${record}\n${BRAINSTORM_RECORD_SEPARATOR}\n` }, finish_reason: null }] })}\n\n`;
  const finishFrame = (reason: string): string => `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const answer = answers[String(body.model)] ?? 500;
      if (typeof answer === 'number') return new Response('upstream unavailable', { status: answer });
      const frames = answer === 'record'
        ? contentFrame
        : answer === 'in_stream_timeout'
          ? `data: ${JSON.stringify({ error: { message: 'upstream request timed out' } })}\n\n`
          : finishFrame(answer);
      return new Response(`${frames}data: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function* emptyEnhance(): AsyncGenerator<never, void, unknown> {
  await Promise.resolve();
  if (Date.now() < 0) yield undefined as never;
}

function fakeProvider(inputs: BrainstormCharactersInput[] = []): TestCliproxyTextProvider {
  return {
    enhance: emptyEnhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' }),
    async *brainstormCharacters(input: BrainstormCharactersInput) {
      await Promise.resolve();
      inputs.push(input);
      yield { type: 'prompt', index: 0, text: 'prompt one' };
      yield { type: 'prompt', index: 1, text: 'prompt two' };
      yield { type: 'done', count: 2 };
    },
  };
}

function post(app: ReturnType<typeof testRuntime>['app'], userId: string, body: unknown) {
  return app.fetch(new Request('http://local/api/prompts/characters/brainstorm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify(body),
  }));
}

describe('POST /api/prompts/characters/brainstorm', () => {
  test('streams prompt events then a done event for an allowlisted user', async () => {
    const inputs: BrainstormCharactersInput[] = [];
    setCliproxyTextProviderForTests(fakeProvider(inputs));
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const res = await post(app, 'alice', { count: 2, modelId: 'gpt-image-2.5-sunburst', variationSeed: 42 });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await parseSse(res);
    expect(events.map((e) => e.event)).toEqual(['prompt', 'prompt', 'done']);
    expect(events[0]?.data).toEqual({ index: 0, text: 'prompt one' });
    expect(events[2]?.data).toEqual({ count: 2 });
    expect(inputs[0]?.variationSeed).toBe(42);
  });

  test('routes Krea and MOSS brainstorm to Kimi and gpt-image brainstorm to GPT without classification', async () => {
    setCliproxyTextProviderForTests(null);
    const requests: Record<string, unknown>[] = [];
    const upstream = serveCapture(requests);
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      LOCAL_MODELS_USERS: 'alice',
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-test',
    });
    const body = { brief: 'A solitary adult cartographer.', count: 2 };
    await parseSse(await post(app, 'alice', { ...body, modelId: 'krea-2-gonzalomo' }));
    await parseSse(await post(app, 'alice', { ...body, modelId: 'moss-image-sft' }));
    await parseSse(await post(app, 'alice', { ...body, modelId: 'gpt-image-2.5-sunburst' }));

    expect(requests.map((request) => request.model)).toEqual([
      TEXT_MODELS.kimi,
      TEXT_MODELS.kimi,
      TEXT_MODELS.gpt,
    ]);
  });

  test('rejects retired wire keys before calling a provider', async () => {
    const inputs: BrainstormCharactersInput[] = [];
    setCliproxyTextProviderForTests(fakeProvider(inputs));
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    for (const textBackend of ['deepseek-pro', 'deepseek-flash', 'qwen', 'glm-flash']) {
      const res = await post(app, 'alice', {
        count: 1, modelId: 'gemini-3-pro-image-preview', textBackend,
      });
      expect(res.status).toBe(400);
    }
    expect(inputs).toEqual([]);
  });

  test('rejects an explicit GPT pin on a local image target', async () => {
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', LOCAL_MODELS_USERS: 'alice' });
    const res = await post(app, 'alice', { count: 1, modelId: 'krea-2-gonzalomo', textBackend: 'gpt' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('cloud image models only');
  });

  test('an explicit textBackend overrides the image-model routing', async () => {
    setCliproxyTextProviderForTests(null);
    const requests: Record<string, unknown>[] = [];
    const upstream = serveCapture(requests);
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      LOCAL_MODELS_USERS: 'alice',
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-test',
    });
    const body = { brief: 'A solitary adult cartographer.', count: 2 };
    await parseSse(await post(app, 'alice', { ...body, modelId: 'krea-2-gonzalomo', textBackend: 'kimi' }));
    await parseSse(await post(app, 'alice', { ...body, modelId: 'gemini-3-pro-image-preview', textBackend: 'mimo' }));
    await parseSse(await post(app, 'alice', { ...body, modelId: 'gemini-3-pro-image-preview', textBackend: 'grok' }));

    expect(requests.map((request) => request.model)).toEqual([
      TEXT_MODELS.kimi,
      TEXT_MODELS.mimo,
      TEXT_MODELS.grok,
    ]);
  });

  test('a deepseek-abliterated pin selects its configured model id', async () => {
    setCliproxyTextProviderForTests(null);
    const requests: Record<string, unknown>[] = [];
    const upstream = serveCapture(requests);
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      LOCAL_MODELS_USERS: 'alice',
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-test',
    });
    await parseSse(await post(app, 'alice', {
      brief: 'A solitary adult cartographer.', count: 1, modelId: 'gemini-3-pro-image-preview', textBackend: 'deepseek-abliterated',
    }));
    expect(requests.map((request) => request.model)).toEqual([TEXT_MODELS['deepseek-abliterated']]);
  });

  // Sunburst remains on its fixed backend, including requests from other clients.
  test('Sunburst fixes GPT despite stored and explicit text-backend preferences', async () => {
    setCliproxyTextProviderForTests(null);
    const requests: Record<string, unknown>[] = [];
    const upstream = serveCapture(requests);
    const { app, db } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      LOCAL_MODELS_USERS: 'alice',
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-test',
    });
    writeTextBackendOverride(db, 'alice', 'brainstorm', 'mimo');
    const body = { brief: 'A solitary adult cartographer.', count: 2 };
    // Sunburst fixes the backend without mutating stored preferences.
    await parseSse(await post(app, 'alice', { ...body, modelId: 'gpt-image-2.5-sunburst' }));
    // A request pin cannot move the Sunburst workflow to another backend.
    await parseSse(await post(app, 'alice', { ...body, modelId: 'gpt-image-2.5-sunburst', textBackend: 'kimi' }));

    expect(requests.map((request) => request.model)).toEqual([
      TEXT_MODELS.gpt,
      TEXT_MODELS.gpt,
    ]);
  });

  test('fails over to Kimi once when the selected backend fails transiently', async () => {
    setCliproxyTextProviderForTests(null);
    const requests: Record<string, unknown>[] = [];
    const upstream = serveByModel(requests, { [TEXT_MODELS.mimo]: 503, [TEXT_MODELS.kimi]: 'record' });
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      LOCAL_MODELS_USERS: 'alice',
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-test',
      RESILIENT_MAX_ATTEMPTS: '1',
    });
    const events = await parseSse(await post(app, 'alice', { count: 1, modelId: 'krea-2-gonzalomo', textBackend: 'mimo' }));
    expect(requests.map((request) => request.model)).toEqual([TEXT_MODELS.mimo, TEXT_MODELS.kimi]);
    expect(events.map((e) => e.event)).toEqual(['prompt', 'done']);
  });

  test('a pinned effort stays with its pin: a failover partner that matches the pin keeps its default', async () => {
    setCliproxyTextProviderForTests(null);
    const requests: Record<string, unknown>[] = [];
    const upstream = serveByModel(requests, { [TEXT_MODELS.mimo]: 503, [TEXT_MODELS.kimi]: 'record' });
    const { app, db } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      LOCAL_MODELS_USERS: 'alice',
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-test',
      RESILIENT_MAX_ATTEMPTS: '1',
    });
    writeTextBackendOverride(db, 'alice', 'brainstorm', 'kimi', 'max');
    await parseSse(await post(app, 'alice', { count: 1, modelId: 'krea-2-gonzalomo', textBackend: 'mimo' }));
    expect(requests.map((request) => [request.model, request.reasoning_effort])).toEqual([
      [TEXT_MODELS.mimo, 'none'],
      [TEXT_MODELS.kimi, 'low'],
    ]);

    requests.length = 0;
    await parseSse(await post(app, 'alice', { count: 1, modelId: 'krea-2-gonzalomo', textBackend: 'kimi' }));
    expect(requests.map((request) => [request.model, request.reasoning_effort])).toEqual([[TEXT_MODELS.kimi, 'max']]);
  });

  test('fails over on upstream capacity exhaustion and once the selected backend\'s breaker is open', async () => {
    setCliproxyTextProviderForTests(null);
    const requests: Record<string, unknown>[] = [];
    const upstream = serveByModel(requests, { [TEXT_MODELS.mimo]: 'insufficient_system_resource', [TEXT_MODELS.kimi]: 'record' });
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      LOCAL_MODELS_USERS: 'alice',
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-test',
      RESILIENT_MAX_ATTEMPTS: '1',
      RESILIENT_BREAKER_THRESHOLD: '3',
    });
    const body = { count: 1, modelId: 'krea-2-gonzalomo', textBackend: 'mimo' };
    for (let call = 0; call < 3; call += 1) {
      const events = await parseSse(await post(app, 'alice', body));
      expect(events.map((e) => e.event)).toEqual(['prompt', 'done']);
    }
    // insufficient_system_resource on the drain path is a transient failure, so
    // each call failed over: three MiMo opens, three Kimi opens.
    expect(requests.filter((request) => request.model === TEXT_MODELS.mimo).length).toBe(3);
    expect(requests.filter((request) => request.model === TEXT_MODELS.kimi).length).toBe(3);

    // An in-stream `{ error }` frame with timeout wording is transient too.
    const inStream: Record<string, unknown>[] = [];
    const inStreamUpstream = serveByModel(inStream, { [TEXT_MODELS.mimo]: 'in_stream_timeout', [TEXT_MODELS.kimi]: 'record' });
    const { app: appInStream } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      LOCAL_MODELS_USERS: 'alice',
      CLIPROXY_BASE_URL: inStreamUpstream,
      CLIPROXY_TOKEN: 'sk-test',
      RESILIENT_MAX_ATTEMPTS: '1',
    });
    const inStreamEvents = await parseSse(await post(appInStream, 'alice', body));
    expect(inStreamEvents.map((e) => e.event)).toEqual(['prompt', 'done']);
    expect(inStream.map((request) => request.model)).toEqual([TEXT_MODELS.mimo, TEXT_MODELS.kimi]);

    // Not for insufficient_system_resource though: those are drain-phase
    // failures the breaker never sees. Force three open-phase failures so the
    // MiMo breaker opens, then the next call must skip MiMo entirely.
    const down: Record<string, unknown>[] = [];
    const downstream = serveByModel(down, { [TEXT_MODELS.mimo]: 503, [TEXT_MODELS.kimi]: 'record' });
    const { app: appDown } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      LOCAL_MODELS_USERS: 'alice',
      CLIPROXY_BASE_URL: downstream,
      CLIPROXY_TOKEN: 'sk-test',
      RESILIENT_MAX_ATTEMPTS: '1',
      RESILIENT_BREAKER_THRESHOLD: '3',
    });
    for (let call = 0; call < 4; call += 1) {
      const events = await parseSse(await post(appDown, 'alice', body));
      expect(events.map((e) => e.event)).toEqual(['prompt', 'done']);
    }
    expect(down.filter((request) => request.model === TEXT_MODELS.mimo).length).toBe(3);
    expect(down.filter((request) => request.model === TEXT_MODELS.kimi).length).toBe(4);
  });

  test('does not fail over on a refusal, and a failed fallback stays terminal', async () => {
    setCliproxyTextProviderForTests(null);
    const requests: Record<string, unknown>[] = [];
    const upstream = serveByModel(requests, { [TEXT_MODELS.mimo]: 'content_filter', [TEXT_MODELS.kimi]: 503 });
    const { app } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      LOCAL_MODELS_USERS: 'alice',
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-test',
      RESILIENT_MAX_ATTEMPTS: '1',
    });
    const refused = await parseSse(await post(app, 'alice', { count: 1, modelId: 'gemini-3-pro-image-preview', textBackend: 'mimo' }));
    expect(requests.map((request) => request.model)).toEqual([TEXT_MODELS.mimo]);
    expect(refused.map((e) => e.event)).toEqual(['error']);
    expect((refused[0]?.data as { code?: string }).code).toBe('content-filter');

    const bothDown: Record<string, unknown>[] = [];
    const downstream = serveByModel(bothDown, { [TEXT_MODELS.mimo]: 503, [TEXT_MODELS.kimi]: 503 });
    const { app: appDown } = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      LOCAL_MODELS_USERS: 'alice',
      CLIPROXY_BASE_URL: downstream,
      CLIPROXY_TOKEN: 'sk-test',
      RESILIENT_MAX_ATTEMPTS: '1',
    });
    const doubleFail = await parseSse(await post(appDown, 'alice', { count: 1, modelId: 'gemini-3-pro-image-preview', textBackend: 'mimo' }));
    expect(bothDown.map((request) => request.model)).toEqual([TEXT_MODELS.mimo, TEXT_MODELS.kimi]);
    expect(doubleFail.map((e) => e.event)).toEqual(['error']);
    expect((doubleFail[0]?.data as { code?: string }).code).toBe('provider-error');

    // Kimi has no failover partner: a transient Kimi failure is terminal.
    bothDown.length = 0;
    const kimiDown = await parseSse(await post(appDown, 'alice', { count: 1, modelId: 'gemini-3-pro-image-preview', textBackend: 'kimi' }));
    expect(bothDown.map((request) => request.model)).toEqual([TEXT_MODELS.kimi]);
    expect(kimiDown.map((e) => e.event)).toEqual(['error']);
    expect((kimiDown[0]?.data as { code?: string }).code).toBe('provider-error');
  });

  test('returns 404 for a non-allowlisted user', async () => {
    setCliproxyTextProviderForTests(fakeProvider());
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const res = await post(app, 'bob', { count: 2, modelId: 'gpt-image-2.5-sunburst' });
    expect(res.status).toBe(404);
  });

  test('clamps count to BRAINSTORM_MAX_COUNT', async () => {
    const inputs: BrainstormCharactersInput[] = [];
    setCliproxyTextProviderForTests(fakeProvider(inputs));
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', BRAINSTORM_MAX_COUNT: '3' });
    const res = await post(app, 'alice', { count: 10, modelId: 'gpt-image-2.5-sunburst' });
    expect(res.status).toBe(200);
    await parseSse(res);
    expect(inputs[0]?.count).toBe(3);
  });

  test('emits a single error event when the provider fails mid-stream', async () => {
    const failing = fakeProvider();
    failing.brainstormCharacters = async function* () {
      await Promise.resolve();
      yield { type: 'failed', status: 502, detail: 'upstream boom' };
    };
    setCliproxyTextProviderForTests(failing);
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const res = await post(app, 'alice', { count: 2, modelId: 'gpt-image-2.5-sunburst' });
    expect(res.status).toBe(200);
    const events = await parseSse(res);
    expect(events.map((e) => e.event)).toEqual(['error']);
    expect((events[0]?.data as { message?: string }).message).toBeTruthy();
  });

  test('surfaces an error event when the brainstorm provider fails (no fallback)', async () => {
    setCliproxyTextProviderForTests({
      ...fakeProvider(),
      async *brainstormCharacters() {
        await Promise.resolve();
        yield { type: 'failed', status: 401, detail: 'unauthorized' };
      },
    });
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const res = await post(app, 'alice', { count: 2, modelId: 'gpt-image-2.5-sunburst' });
    const events = await parseSse(res);
    expect(events.map((e) => e.event)).toContain('error');
    expect(events.map((e) => e.event)).not.toContain('done');
  });

  test('quota failure on brainstorm → quota-exhausted code + retryAfterSeconds', async () => {
    setCliproxyTextProviderForTests({
      ...fakeProvider(),
      async *brainstormCharacters() {
        await Promise.resolve();
        yield { type: 'failed', kind: 'quota', status: 429, detail: 'quota', retryAfterSeconds: 900 };
      },
    });
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const res = await post(app, 'alice', { count: 2, modelId: 'gpt-image-2.5-sunburst' });
    expect(res.status).toBe(200);
    const events = await parseSse(res);
    expect(events.map((e) => e.event)).toEqual(['error']);
    const err = events[0]?.data as { code?: string; retryAfterSeconds?: number; message?: string };
    expect(err.code).toBe('quota-exhausted');
    expect(err.retryAfterSeconds).toBe(900);
    expect(err.message).toBe('Codex quota exhausted');
  });

  test('non-quota provider failure on brainstorm → provider-error code', async () => {
    setCliproxyTextProviderForTests({
      ...fakeProvider(),
      async *brainstormCharacters() {
        await Promise.resolve();
        yield { type: 'failed', kind: 'permanent', status: 400, detail: 'bad request' };
      },
    });
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const res = await post(app, 'alice', { count: 2, modelId: 'gpt-image-2.5-sunburst' });
    const events = await parseSse(res);
    expect(events.map((e) => e.event)).toEqual(['error']);
    const err = events[0]?.data as { code?: string };
    expect(err.code).toBe('provider-error');
  });

  test('refusal-like brainstorm output → content-filter code', async () => {
    setCliproxyTextProviderForTests({
      ...fakeProvider(),
      async *brainstormCharacters() {
        await Promise.resolve();
        yield {
          type: 'failed',
          kind: 'content-filter',
          status: null,
          detail: 'brainstorm output did not satisfy the prompt contract',
        };
      },
    });
    const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    const res = await post(app, 'alice', { count: 1, modelId: 'krea-2-gonzalomo' });
    const events = await parseSse(res);
    expect(events.map((event) => event.event)).toEqual(['error']);
    expect(events[0]?.data).toEqual({
      message: 'The model refused this request.',
      code: 'content-filter',
    });
  });
});
