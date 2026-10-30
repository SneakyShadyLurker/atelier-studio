import { afterEach, describe, expect, test } from 'bun:test';
import { setTextModelProviderForTests } from '../providers/text/registry';
import { parseSse, restoreFetch, testRuntime, legacyTextUpstreamIds } from '../test/helpers';
import { hostPortProbeResponse, isHostPortProbe } from '../test/hostProbe';
import {
  type EnhanceChunk,
  type TestTextFeatureProvider,
} from '../providers/text/featureHelpers';
import {
  ENHANCE_SYSTEM_PROMPT,
  KREA_ENHANCE_SYSTEM_PROMPT,
  MOSS_ENHANCE_SYSTEM_PROMPT,
} from '../prompts/enhanceSystemPrompt';

const TEXT_MODELS = legacyTextUpstreamIds();

const VIDEO_ON = {
  seedLegacyText: true,
  COMFYUI_BASE_URL: 'http://127.0.0.1:1',
  VIDEO_MODELS_ENABLED: 'true',
  LOCAL_MODELS_USERS: 'alice',
  I2V_MOTION_ENHANCE: 'false',
};

interface CapturedRequest {
  readonly model?: unknown;
  readonly reasoning_effort?: unknown;
  readonly max_completion_tokens?: unknown;
  readonly verbosity?: unknown;
  readonly messages?: readonly { readonly role?: unknown; readonly content?: unknown }[];
}

const servers: Bun.Server<unknown>[] = [];

function serveCapture(requests: CapturedRequest[]): string {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (isHostPortProbe(request)) return hostPortProbeResponse();
      requests.push((await request.json()) as CapturedRequest);
      const frame = JSON.stringify({
        choices: [{ index: 0, delta: { content: 'enhanced' }, finish_reason: 'stop' }],
      });
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function systemPromptOf(request: CapturedRequest): unknown {
  return request.messages?.find((message) => message.role === 'system')?.content;
}

function provider(): TestTextFeatureProvider {
  return {
    async *enhance() {
      await Promise.resolve();
      yield { type: 'delta', text: 'enhanced' } satisfies EnhanceChunk;
      yield { type: 'done' } satisfies EnhanceChunk;
    },
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'x' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'x' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'x' }),
  };
}

function postEnhance(
  app: ReturnType<typeof testRuntime>['app'],
  userId: string,
  modelId: string,
): Promise<Response> {
  return Promise.resolve(app.fetch(new Request('http://local/api/enhance-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': userId },
    body: JSON.stringify({ prompt: 'she dances', modelId }),
  })));
}

afterEach(async () => {
  restoreFetch();
  setTextModelProviderForTests(null);
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

describe('POST /api/enhance-prompt local-model allowlist', () => {
  test('a non-listed user cannot reach h3-motion through a registered local id', async () => {
    setTextModelProviderForTests(provider());
    const { app } = testRuntime(VIDEO_ON);

    const local = await postEnhance(app, 'bob', 'minimax-h3-i2v');
    const unknown = await postEnhance(app, 'bob', 'unregistered-model');

    expect(local.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await parseSse(local)).toEqual(await parseSse(unknown));
  });

  test('a listed user still reaches the h3-motion kill switch', async () => {
    const { app } = testRuntime(VIDEO_ON);

    const response = await postEnhance(app, 'alice', 'minimax-h3-i2v');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'motion enhancement unavailable',
      code: 'MOTION_ENHANCE_UNAVAILABLE',
    });
  });

  test('a non-listed user sends registered and unregistered Krea-like ids through the same generic provider', async () => {
    restoreFetch();
    const requests: CapturedRequest[] = [];
    const upstream = serveCapture(requests);
    const { app } = testRuntime({
      ...VIDEO_ON,
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-x',
    });

    const registered = await postEnhance(app, 'bob', 'krea-2-gonzalomo');
    expect(registered.status).toBe(200);
    expect((await parseSse(registered)).at(-1)?.event).toBe('done');

    const unregistered = await postEnhance(app, 'bob', 'krea-not-a-real-model');
    expect(unregistered.status).toBe(200);
    expect((await parseSse(unregistered)).at(-1)?.event).toBe('done');

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.model)).toEqual([
      TEXT_MODELS.kimi,
      TEXT_MODELS.kimi,
    ]);
    for (const request of requests) {
      expect(request).toMatchObject({
        model: TEXT_MODELS.kimi,
        reasoning_effort: 'low',
        max_completion_tokens: 36_000,
      });
    }
    expect(requests.every((request) => !Object.hasOwn(request, 'verbosity'))).toBe(true);
    expect(requests.map(systemPromptOf)).toEqual([
      ENHANCE_SYSTEM_PROMPT,
      ENHANCE_SYSTEM_PROMPT,
    ]);
    expect(requests.map(systemPromptOf)).not.toContain(KREA_ENHANCE_SYSTEM_PROMPT);
  });

  test('a listed user sends registered Krea ids through Kimi with the Krea prompt', async () => {
    restoreFetch();
    const requests: CapturedRequest[] = [];
    const upstream = serveCapture(requests);
    const { app } = testRuntime({
      ...VIDEO_ON,
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-x',
      LOCAL_MODELS_USERS: 'alice',
    });

    const response = await postEnhance(app, 'alice', 'krea-2-gonzalomo');

    expect(response.status).toBe(200);
    expect((await parseSse(response)).at(-1)?.event).toBe('done');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(TEXT_MODELS.kimi);
    expect(systemPromptOf(requests[0] ?? {})).toBe(
      KREA_ENHANCE_SYSTEM_PROMPT,
    );
  });

  test('a listed user sends MOSS through Kimi with the MOSS prompt', async () => {
    restoreFetch();
    const requests: CapturedRequest[] = [];
    const upstream = serveCapture(requests);
    const { app } = testRuntime({
      ...VIDEO_ON,
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-x',
      LOCAL_MODELS_USERS: 'alice',
    });

    const response = await postEnhance(app, 'alice', 'moss-image-sft');

    expect(response.status).toBe(200);
    expect((await parseSse(response)).at(-1)?.event).toBe('done');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(TEXT_MODELS.kimi);
    expect(systemPromptOf(requests[0] ?? {})).toBe(MOSS_ENHANCE_SYSTEM_PROMPT);
  });

  test('a non-listed user sends MOSS through the same generic provider as an unknown id', async () => {
    restoreFetch();
    const requests: CapturedRequest[] = [];
    const upstream = serveCapture(requests);
    const { app } = testRuntime({
      ...VIDEO_ON,
      CLIPROXY_BASE_URL: upstream,
      CLIPROXY_TOKEN: 'sk-x',
    });

    const response = await postEnhance(app, 'bob', 'moss-image-sft');

    expect(response.status).toBe(200);
    expect((await parseSse(response)).at(-1)?.event).toBe('done');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(TEXT_MODELS.kimi);
    expect(systemPromptOf(requests[0] ?? {})).toBe(ENHANCE_SYSTEM_PROMPT);
  });
});
