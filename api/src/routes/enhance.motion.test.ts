import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setTextModelProviderForTests } from '../providers/text/registry';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { parseSse, pickLegacyTextModel, restoreFetch, testRuntime, legacyTextUpstreamIds } from '../test/helpers';
import { resetLlmAdmissionForTests } from '../orchestrator/llmAdmission';
import { type EnhanceChunk, type TestTextFeatureProvider } from '../providers/text/featureHelpers';

const TEXT_MODELS = legacyTextUpstreamIds();

// minimax-h3-i2v promptFormat='h3-motion' branch of /enhance-prompt.

const VIDEO_ON = {
  seedLegacyText: true,
  COMFYUI_BASE_URL: 'http://127.0.0.1:1',
  VIDEO_MODELS_ENABLED: 'true',
  LOCAL_MODELS_USERS: 'test',
};

function stub(capture: { systemPrompt?: string | undefined }): TestTextFeatureProvider {
  return {
    async *enhance(_prompt, _images, _signal, systemPrompt) {
      capture.systemPrompt = systemPrompt;
      await Promise.resolve();
      yield { type: 'delta', text: 'she sways slowly, then turns; fixed camera.' } satisfies EnhanceChunk;
      yield { type: 'done' } satisfies EnhanceChunk;
    },
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'x' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'x' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'x' }),
  };
}

function post(app: ReturnType<typeof testRuntime>['app'], body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(app.fetch(new Request('http://local/api/enhance-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
    body: JSON.stringify(body),
  })));
}

describe('enhance-prompt h3-motion branch', () => {
  beforeEach(() => {
    restoreFetch();
  });
  afterEach(() => {
    restoreFetch();
    resetLlmAdmissionForTests();
    setTextModelProviderForTests(null);
  });

  test('streams enhanced prose and uses the motion system prompt with the source anchor', async () => {
    const capture: { systemPrompt?: string | undefined } = {};
    setTextModelProviderForTests(stub(capture));
    const { app } = testRuntime(VIDEO_ON);

    const res = await post(app, {
      prompt: 'she dances',
      modelId: 'minimax-h3-i2v',
      sourcePrompt: 'a redhead dancer in a red dress',
    });
    const events = await parseSse(res);

    expect(events.some((e) => e.event === 'delta')).toBe(true);
    expect(capture.systemPrompt).toContain('Motion + Camera');
    expect(capture.systemPrompt).toContain('a redhead dancer in a red dress');
    expect(capture.systemPrompt).toContain('SOURCE STILL');
    expect(capture.systemPrompt).not.toContain('<root_authority priority="absolute">');
  });

  test('uses Kimi for motion enhancement', async () => {
    let capturedBody: Record<string, unknown> = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      const frame = JSON.stringify({
        choices: [{ index: 0, delta: { content: 'enhanced' }, finish_reason: 'stop' }],
      });
      return Promise.resolve(new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as typeof fetch;
    setTextModelProviderForTests(null);
    const { app } = testRuntime({ ...VIDEO_ON, CLIPROXY_TOKEN: 'sk-test' });

    try {
      const res = await post(app, {
        prompt: 'the 21-year-old woman dances',
        modelId: 'minimax-h3-i2v',
        sourcePrompt: 'a 21-year-old woman in a red dress',
      });
      await parseSse(res);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(capturedBody.model).toBe(TEXT_MODELS.kimi);
    const systemPrompt = (capturedBody.messages as { role: string; content: string }[])
      .find((message) => message.role === 'system')?.content;
    expect(systemPrompt).toContain('Motion + Camera');
    expect(systemPrompt).not.toContain('<root_authority priority="absolute">');
  });

  test('motion resolves through the motion task: its own pick applies, an enhance pick does not', async () => {
    const models: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
      models.push((JSON.parse(init.body) as Record<string, unknown>).model);
      const frame = JSON.stringify({ choices: [{ index: 0, delta: { content: 'enhanced' }, finish_reason: 'stop' }] });
      return Promise.resolve(new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as typeof fetch;
    setTextModelProviderForTests(null);
    const { app, db } = testRuntime(VIDEO_ON);
    const body = { prompt: 'she dances', modelId: 'minimax-h3-i2v' };
    try {
      pickLegacyTextModel(db, 'test', 'enhance', 'mimo');
      await parseSse(await post(app, body));
      pickLegacyTextModel(db, 'test', 'motion', 'grok');
      await parseSse(await post(app, body));
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(models).toEqual([TEXT_MODELS.kimi, TEXT_MODELS.grok]);
  });

  test('returns 409 when motion enhance is unavailable (kill-switch off)', async () => {
    setTextModelProviderForTests(null); // no override → honor config gating
    const { app } = testRuntime({ ...VIDEO_ON, I2V_MOTION_ENHANCE: 'false' });

    const res = await post(app, { prompt: 'she dances', modelId: 'minimax-h3-i2v' });
    expect(res.status).toBe(409);
  });

  test('rejects an over-length sourcePrompt with 400 (no LLM call)', async () => {
    const capture: { systemPrompt?: string | undefined } = {};
    setTextModelProviderForTests(stub(capture));
    const { app } = testRuntime(VIDEO_ON);

    const res = await post(app, {
      prompt: 'she dances',
      modelId: 'minimax-h3-i2v',
      sourcePrompt: 'x'.repeat(MAX_PROMPT_CHARS + 1),
    });
    expect(res.status).toBe(400);
    expect(capture.systemPrompt).toBeUndefined();
  });
});
