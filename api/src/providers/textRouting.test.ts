import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { textBackendReasoningEfforts } from '@atelier/shared';
import { allowJevForProviderTests, resetJevForProviderTests } from '../test/jev-fixture';

beforeEach(allowJevForProviderTests);
afterEach(resetJevForProviderTests);
import {
  aiFillTextProviderForConfig,
  motionEnhanceTextProviderForConfig,
} from './textRouting';
import {
  cliproxyTextForConfig,
  cliproxyTextForBackend,
  setCliproxyTextProviderForTests,
} from './cliproxyText';
import { textBackendModels } from './cliproxyText.config';
import {
  BRAINSTORM_FIELD_SEPARATOR,
  BRAINSTORM_RECORD_SEPARATOR,
} from '../prompts/brainstormCharactersSystemPrompt';
import { testConfig } from '../test/helpers';

const TEXT_MODELS = textBackendModels(testConfig());

afterEach(() => {
  setCliproxyTextProviderForTests(null);
});

describe('aiFillTextProviderForConfig', () => {
  test('a user-pinned effort replaces each backend default on every workload path; GPT keeps its pin', async () => {
    const original = globalThis.fetch;
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<string, unknown>);
      const data = JSON.stringify({ choices: [{ delta: { content: 'red' }, finish_reason: 'stop' }] });
      return Promise.resolve(new Response(`data: ${data}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;
    try {
      const pins = [
        ['kimi', 'max', 'max'],
        ['mimo', 'high', 'high'],
        ['grok', 'xhigh', 'xhigh'],
        ['gemini-argon', 'medium', 'medium'],
        ['deepseek-abliterated', 'minimal', 'minimal'],
        ['glm-abliterated', 'high', 'high'],
        ['gpt', 'max', 'medium'],
      ] as const;
      for (const [backend, reasoningEffort, wire] of pins) {
        const provider = aiFillTextProviderForConfig(testConfig(), backend);
        for await (const _chunk of provider.enhance('prompt', [], new AbortController().signal, 'system', { reasoningEffort })) { /* drain */ }
        expect(sent.at(-1)).toMatchObject({ reasoning_effort: wire });
      }

      const mimo = aiFillTextProviderForConfig(testConfig(), 'mimo');
      await mimo.aiFill({ systemPrompt: 'system', userContent: 'user', reasoningEffort: 'high' }, new AbortController().signal);
      expect(sent.at(-1)).toMatchObject({ reasoning_effort: 'high' });
      await mimo.aiFill({ systemPrompt: 'system', userContent: 'user' }, new AbortController().signal);
      expect(sent.at(-1)).toMatchObject({ reasoning_effort: 'none' });

      const kimi = aiFillTextProviderForConfig(testConfig(), 'kimi');
      for await (const _chunk of kimi.brainstormCharacters(
        { count: 4, modelId: 'flux-2-pro', reasoningEffort: 'high' },
        new AbortController().signal,
      )) { /* drain */ }
      expect(sent.at(-1)).toMatchObject({ reasoning_effort: 'high', max_completion_tokens: 2_400 + 16_000 });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a pinned effort above low lifts the enhance raw-stream cap; the default keeps it', async () => {
    const original = globalThis.fetch;
    const padding = JSON.stringify({ choices: [{ delta: { reasoning_content: 'x'.repeat(4096) } }] });
    const answer = JSON.stringify({ choices: [{ delta: { content: 'red' }, finish_reason: 'stop' }] });
    globalThis.fetch = (() => Promise.resolve(new Response(`data: ${padding}\n\ndata: ${answer}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))) as unknown as typeof fetch;
    try {
      const provider = aiFillTextProviderForConfig(testConfig({ CLIPROXY_TEXT_MAX_RESPONSE_BYTES: '2048' }), 'kimi');
      const run = async (reasoningEffort?: 'low' | 'high') => {
        const types: string[] = [];
        for await (const chunk of provider.enhance('prompt', [], new AbortController().signal, 'system',
          reasoningEffort === undefined ? {} : { reasoningEffort })) types.push(chunk.type);
        return types;
      };
      expect(await run()).toContain('failed');
      expect(await run('low')).toContain('failed');
      expect(await run('high')).toContain('done');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('GPT pins medium, preserves strict schema and vision, and omits other hosts wire controls', async () => {
    const original = globalThis.fetch;
    let sentBody: Record<string, unknown> = {};
    let sentHeaders = new Headers();
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<string, unknown>;
      sentHeaders = new Headers(init?.headers);
      const reasoning = JSON.stringify({ choices: [{ delta: { reasoning_content: 'private reasoning' } }] });
      const answer = JSON.stringify({ choices: [{ delta: { content: 'red' }, finish_reason: 'stop' }], usage: { completion_tokens: 12 } });
      return Promise.resolve(new Response(`data: ${reasoning}\n\ndata: ${answer}\n\ndata: [DONE]\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;
    try {
      const provider = aiFillTextProviderForConfig(testConfig(), 'gpt');
      const responseFormat = {
        type: 'json_schema',
        json_schema: { name: 'gpt_shape', strict: true, schema: { type: 'string' } },
      } as const;
      const chunks = [];
      for await (const chunk of provider.enhance('prompt', [{ mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }],
        new AbortController().signal, 'system', {
          defaults: { reasoning_effort: 'max', verbosity: 'high', max_completion_tokens: 36_000 },
          responseFormat,
        })) chunks.push(chunk);
      expect(chunks.some((chunk) => chunk.type === 'done')).toBe(true);
      expect(JSON.stringify(chunks)).not.toContain('private reasoning');
      expect(sentBody).toMatchObject({
        model: TEXT_MODELS.gpt, stream: true, reasoning_effort: 'medium',
        max_completion_tokens: 36_000, response_format: responseFormat,
      });
      const user = (sentBody.messages as { role: string; content: unknown }[]).find((message) => message.role === 'user');
      expect(user?.content).toEqual(expect.arrayContaining([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      ]));
      for (const key of ['thinking', 'verbosity', 'temperature', 'top_p', 'top_k', 'safe_tokenization', 'max_tokens', 'prompt_cache_key', 'perf_metrics_in_response']) {
        expect(sentBody).not.toHaveProperty(key);
      }
      expect(sentHeaders.has('x-session-affinity')).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('each backend sends its configured model id and keeps its own wire shape', async () => {
    const original = globalThis.fetch;
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<string, unknown>);
      const data = JSON.stringify({ choices: [{ delta: { content: 'red' }, finish_reason: 'stop' }] });
      return Promise.resolve(new Response(`data: ${data}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;
    try {
      const config = testConfig({
        CLIPROXY_TEXT_MODEL_KIMI: 'custom/a',
        CLIPROXY_TEXT_MODEL_MIMO: 'custom/b',
        CLIPROXY_TEXT_MODEL_GROK: 'custom/c',
        CLIPROXY_TEXT_MODEL_GEMINI_ARGON: 'custom/d',
        CLIPROXY_TEXT_MODEL_DEEPSEEK_ABLITERATED: 'custom/e',
        CLIPROXY_TEXT_MODEL_GLM_ABLITERATED: 'custom/f',
        CLIPROXY_TEXT_MODEL_GPT: 'custom/g',
      });
      const send = async (backend: Parameters<typeof aiFillTextProviderForConfig>[1]) => {
        const provider = aiFillTextProviderForConfig(config, backend);
        for await (const _chunk of provider.enhance('prompt', [], new AbortController().signal, 'system', {
          responseFormat: 'json_object',
        })) { /* drain */ }
        return sent.at(-1);
      };
      expect(await send('kimi')).toMatchObject({ model: 'custom/a', reasoning_effort: 'low' });
      expect(sent.at(-1)).not.toHaveProperty('verbosity');
      expect(await send('mimo')).toMatchObject({ model: 'custom/b', reasoning_effort: 'none' });
      expect(await send('grok')).toMatchObject({ model: 'custom/c', temperature: 0.7, top_p: 0.95 });
      expect(await send('gemini-argon')).toMatchObject({ model: 'custom/d', reasoning_effort: 'low' });
      expect(await send('deepseek-abliterated')).toMatchObject({ model: 'custom/e', reasoning_effort: 'none' });
      expect(await send('glm-abliterated')).toMatchObject({ model: 'custom/f', max_completion_tokens: 32_768 });
      expect(sent.at(-1)).not.toHaveProperty('response_format');
      expect(await send('gpt')).toMatchObject({ model: 'custom/g', reasoning_effort: 'medium' });
      expect(sent.at(-1)).not.toHaveProperty('verbosity');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('pins every backend to its own cached provider', () => {
    const config = testConfig();
    for (const backend of ['kimi', 'mimo', 'grok', 'gemini-argon', 'deepseek-abliterated', 'glm-abliterated', 'gpt'] as const) {
      expect(aiFillTextProviderForConfig(config, backend)).toBe(cliproxyTextForBackend(config, backend));
    }
  });

  test('resolves the generic text provider to Kimi K3', () => {
    const config = testConfig();
    expect(cliproxyTextForConfig(config)).toBe(
      cliproxyTextForBackend(config, 'kimi'),
    );
  });

  test('test-provider override wins over the routed backend', () => {
    const fake = { aiFill: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: '' }) } as never;
    setCliproxyTextProviderForTests(fake);
    const config = testConfig();
    expect(aiFillTextProviderForConfig(config, 'kimi')).toBe(cliproxyTextForConfig(config));
  });

  test('sends Kimi K3 to the CLIProxy base URL with the per-path low effort and no thinking field', async () => {
    const original = globalThis.fetch;
    let sentBody: Record<string, unknown> = {};
    let sentUrl: string | undefined;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      sentUrl = url;
      const body = typeof init?.body === 'string' ? init.body : '';
      sentBody = JSON.parse(body) as Record<string, unknown>;
      const data = JSON.stringify({ choices: [{ delta: { content: 'red' }, finish_reason: 'stop' }] });
      return Promise.resolve(
        new Response(`data: ${data}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    }) as unknown as typeof fetch;
    try {
      const config = testConfig();
      const provider = aiFillTextProviderForConfig(config, 'kimi');
      await provider.aiFill({ systemPrompt: 'fill', userContent: '[[0]]' }, new AbortController().signal);
      expect(sentBody).toMatchObject({
        model: TEXT_MODELS.kimi,
        reasoning_effort: 'low',
        max_completion_tokens: 36_000,
      });
      expect(sentBody).not.toHaveProperty('thinking');
      expect(sentBody).not.toHaveProperty('verbosity');
      expect(sentUrl).toContain(config.CLIPROXY_BASE_URL);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('each chat backend sends its model, own default effort, per-path ceiling and strict schema; only Grok samples', async () => {
    const original = globalThis.fetch;
    let sentBody: Record<string, unknown> = {};
    let sentHeaders = new Headers();
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      sentBody = JSON.parse(body) as Record<string, unknown>;
      sentHeaders = new Headers(init?.headers);
      const data = JSON.stringify({ choices: [{ delta: { content: 'red' }, finish_reason: 'stop' }] });
      return Promise.resolve(new Response(`data: ${data}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;
    const responseFormat = {
      type: 'json_schema',
      json_schema: { name: 'chat_shape', strict: true, schema: { type: 'string' } },
    } as const;
    try {
      const cases = [
        ['kimi', 'kimi-latest', 'low'],
        ['mimo', 'mimo-v2.6-pro', 'none'],
        ['grok', 'grok-latest', 'low'],
        ['gemini-argon', 'gemini-4-argon', 'low'],
        ['deepseek-abliterated', 'abliterated-model-large-flash', 'none'],
      ] as const;
      for (const [backend, model, defaultEffort] of cases) {
        const provider = aiFillTextProviderForConfig(testConfig(), backend);
        const chunks = [];
        for await (const chunk of provider.enhance('prompt', [], new AbortController().signal, 'system', {
          // The per-path 'low' must not reach a backend with its own default.
          defaults: { reasoning_effort: 'low', verbosity: 'high', max_completion_tokens: 36_000 },
          responseFormat,
        })) chunks.push(chunk);
        expect(chunks.some((chunk) => chunk.type === 'done')).toBe(true);
        expect(sentBody).toMatchObject({
          model,
          stream: true,
          reasoning_effort: defaultEffort,
          max_completion_tokens: 36_000,
          response_format: responseFormat,
        });
        if (backend === 'grok') {
          expect(sentBody).toMatchObject({ temperature: 0.7, top_p: 0.95 });
        } else {
          expect(sentBody).not.toHaveProperty('temperature');
          expect(sentBody).not.toHaveProperty('top_p');
        }
        for (const key of ['verbosity', 'thinking', 'top_k', 'max_tokens', 'safe_tokenization', 'prompt_cache_key', 'perf_metrics_in_response']) {
          expect(sentBody).not.toHaveProperty(key);
        }
        expect(sentHeaders.has('x-session-affinity')).toBe(false);

        // A user pin wins over the backend default.
        const pinned = textBackendReasoningEfforts(backend).at(-1);
        if (pinned === undefined) throw new Error(`${backend} lists no effort`);
        for await (const _chunk of provider.enhance('prompt', [], new AbortController().signal, 'system', {
          reasoningEffort: pinned,
        })) { /* drain */ }
        expect(sentBody).toMatchObject({ model, reasoning_effort: pinned });

        // json_object is forwarded as-is.
        for await (const _chunk of provider.enhance('prompt', [], new AbortController().signal, 'system', {
          responseFormat: 'json_object',
        })) { /* drain */ }
        expect(sentBody).toMatchObject({ response_format: { type: 'json_object' } });
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test('MiMo ai-fill sends its own none effort, never the AI_FILL_DEFAULTS low the proxy would remap', async () => {
    const original = globalThis.fetch;
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<string, unknown>);
      const data = JSON.stringify({ choices: [{ delta: { content: 'red' }, finish_reason: 'stop' }] });
      return Promise.resolve(new Response(`data: ${data}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;
    try {
      const provider = aiFillTextProviderForConfig(testConfig(), 'mimo');
      await provider.aiFill({ systemPrompt: 'fill', userContent: '[[0]]' }, new AbortController().signal);
      await provider.aiFill({ systemPrompt: 'fill', userContent: '[[0]]', batchSize: 3 }, new AbortController().signal);
      for await (const _chunk of provider.brainstormCharacters({ count: 2, modelId: 'flux-2-pro' }, new AbortController().signal)) { /* drain */ }
      expect(sent).toHaveLength(3);
      for (const body of sent) {
        expect(body).toMatchObject({ model: 'mimo-v2.6-pro', reasoning_effort: 'none' });
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test('pins GLM low at the wire and omits response_format and host-specific fields', async () => {
    const original = globalThis.fetch;
    let sentBody: Record<string, unknown> = {};
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      sentBody = JSON.parse(body) as Record<string, unknown>;
      const data = JSON.stringify({ choices: [{ delta: { content: 'red' }, finish_reason: 'stop' }] });
      return Promise.resolve(new Response(`data: ${data}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;
    try {
      const provider = aiFillTextProviderForConfig(testConfig(), 'glm-abliterated');
      const chunks = [];
      for await (const chunk of provider.enhance(
        'prompt',
        [],
        new AbortController().signal,
        'system',
        {
          // Per-path effort and ceiling must not reach the wire: the wire
          // branch owns GLM's default effort and 32,768-token budget.
          defaults: { reasoning_effort: 'max', verbosity: 'high', max_completion_tokens: 36_000 },
          responseFormat: {
            type: 'json_schema',
            json_schema: { name: 'glm_shape', strict: true, schema: { type: 'string' } },
          },
        },
      )) chunks.push(chunk);

      expect(chunks.some((chunk) => chunk.type === 'done')).toBe(true);
      expect(sentBody).toMatchObject({
        model: TEXT_MODELS['glm-abliterated'],
        reasoning_effort: 'low',
        max_completion_tokens: 32_768,
      });
      // The upstream answers any response_format on this model with HTTP 400.
      expect(sentBody).not.toHaveProperty('response_format');
      expect(sentBody).not.toHaveProperty('verbosity');
      expect(sentBody).not.toHaveProperty('thinking');
      expect(sentBody).not.toHaveProperty('safe_tokenization');
      expect(sentBody).not.toHaveProperty('max_tokens');
      expect(sentBody).not.toHaveProperty('prompt_cache_key');
      expect(sentBody).not.toHaveProperty('perf_metrics_in_response');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('GLM provider byte cap wiring', () => {
  test('the routed GLM provider streams past the shared 1 MiB cap that still bounds every other backend', async () => {
    const original = globalThis.fetch;
    const reasoning = JSON.stringify({ choices: [{ delta: { reasoning: 'r'.repeat(2_000) }, finish_reason: null }] });
    const answer = JSON.stringify({ choices: [{ delta: { content: 'red' }, finish_reason: 'stop' }] });
    // ~1.2 MiB of reasoning frames ahead of a short answer.
    const body = `${`data: ${reasoning}\n\n`.repeat(620)}data: ${answer}\n\ndata: [DONE]\n\n`;
    globalThis.fetch = (() => Promise.resolve(new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))) as unknown as typeof fetch;
    try {
      const drain = async (backend: 'glm-abliterated' | 'mimo' | 'kimi'): Promise<string[]> => {
        const types: string[] = [];
        const provider = aiFillTextProviderForConfig(testConfig(), backend);
        for await (const chunk of provider.enhance('prompt', [], new AbortController().signal, 'system')) {
          types.push(chunk.type);
        }
        return types;
      };
      expect(body.length).toBeGreaterThan(1024 * 1024);
      expect(await drain('glm-abliterated')).toEqual(['delta', 'done']);
      expect(await drain('mimo')).toContain('failed');
      expect(await drain('kimi')).toContain('failed');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('routed brainstorm provider contracts', () => {
  test('sends Kimi brainstorm with low reasoning', async () => {
    const original = globalThis.fetch;
    let sentBody: Record<string, unknown> = {};
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      sentBody = JSON.parse(body) as Record<string, unknown>;
      const data = JSON.stringify({
        choices: [{
          delta: {
            content: `scene\n${BRAINSTORM_FIELD_SEPARATOR}\nsubject\n${BRAINSTORM_FIELD_SEPARATOR}\ndetails\n${BRAINSTORM_RECORD_SEPARATOR}\n`,
          },
          finish_reason: null,
        }],
      });
      return Promise.resolve(new Response(`data: ${data}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as unknown as typeof fetch;
    try {
      const provider = aiFillTextProviderForConfig(testConfig(), 'kimi');
      const chunks = [];
      for await (const chunk of provider.brainstormCharacters(
        { count: 1, modelId: 'gpt-image-2.5-sunburst' },
        new AbortController().signal,
      )) chunks.push(chunk);

      expect(chunks.some((chunk) => chunk.type === 'done')).toBe(true);
      expect(sentBody).toMatchObject({
        model: TEXT_MODELS.kimi,
        reasoning_effort: 'low',
      });
      expect(sentBody).not.toHaveProperty('thinking');
      expect(sentBody).not.toHaveProperty('verbosity');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('motionEnhanceTextProviderForConfig', () => {
  test('uses the same explicit per-backend providers as ai-fill', () => {
    const config = testConfig({ I2V_MOTION_ENHANCE: 'true' });
    expect(motionEnhanceTextProviderForConfig(config, 'kimi')).toBe(
      aiFillTextProviderForConfig(config, 'kimi'),
    );
    expect(motionEnhanceTextProviderForConfig(config, 'mimo')).toBe(
      aiFillTextProviderForConfig(config, 'mimo'),
    );
  });

  test('returns null when motion enhancement is disabled', () => {
    const config = testConfig({ I2V_MOTION_ENHANCE: 'false' });
    expect(motionEnhanceTextProviderForConfig(config, 'kimi')).toBeNull();
  });
});
