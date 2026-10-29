import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createCliproxyTextProvider } from './cliproxyText';
import { brainstormDefaults, textBackendModels } from './cliproxyText.config';
import type { ChatResponseFormat } from './cliproxyText';
// These suites use modelId 'gpt-image-2.5-sunburst' → the GPT (anatomy-safe) constraints variant.
import {
  BRAINSTORM_FIELD_SEPARATOR,
  BRAINSTORM_RECORD_SEPARATOR,
  BRAINSTORM_CONSTRAINTS_GPT,
} from '../prompts/brainstormCharactersSystemPrompt';
import { restoreFetch, testConfig } from '../test/helpers';
import { redactSecrets } from '../observability/redact';
import { testTextPolicies } from '../test/textPolicies';

const TEXT_MODELS = textBackendModels(testConfig());

const servers: Bun.Server<unknown>[] = [];
beforeEach(() => {
  restoreFetch();
});
afterEach(async () => {
  restoreFetch();
  await Promise.all(servers.splice(0).map((s) => s.stop(true)));
});

function serveCapture(bodies: unknown[], frames: string): string {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.json());
      return new Response(frames, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

// DeepSeek V4.1 Flash Abliterated: a chat backend with its own 'none'
// default, so it exercises the non-Kimi branch of the shared chat body.
function chatProvider(baseUrl: string) {
  return createCliproxyTextProvider({ ...testTextPolicies(),
    baseUrl, token: 'sk-ng', model: TEXT_MODELS['deepseek-abliterated'], backend: 'deepseek-abliterated', maxResponseBytes: 1_000_000,
  });
}

function contentFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
}
function finishFrame(reason: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
}

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const STRICT_RESPONSE_FORMAT: ChatResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'strict_labels',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { '0': { type: 'string', enum: ['LABEL'] } },
      required: ['0'],
    },
  },
};

describe('chat body over HTTP', () => {
  test('forwards strict schema and the per-path ceiling, keeps the backend default effort over a per-path one', async () => {
    const bodies: Record<string, unknown>[] = [];
    const baseUrl = serveCapture(bodies, `${contentFrame('{"0":"LABEL"}')}${finishFrame('stop')}data: [DONE]\n\n`);
    await drain(chatProvider(baseUrl).enhance('label this', [], new AbortController().signal, 'sys', {
      responseFormat: STRICT_RESPONSE_FORMAT,
      defaults: { reasoning_effort: 'max', verbosity: 'high', max_completion_tokens: 32 },
    }));
    expect(bodies[0]?.response_format).toEqual(STRICT_RESPONSE_FORMAT);
    for (const key of ['prompt_cache_key', 'perf_metrics_in_response', 'safe_tokenization', 'thinking', 'verbosity', 'max_tokens', 'temperature', 'top_p']) {
      expect(bodies[0]).not.toHaveProperty(key);
    }
    expect(bodies[0]?.max_completion_tokens).toBe(32);
    // The per-path 'max' never reaches a backend with its own default.
    expect(bodies[0]?.reasoning_effort).toBe('none');
  });
});

describe('chat backend brainstorm', () => {
  test('sends the brainstorm budget with the backend default effort and no inert defaults', async () => {
    const bodies: Record<string, unknown>[] = [];
    const out = `${contentFrame(`a\n${BRAINSTORM_RECORD_SEPARATOR}\n`)}data: [DONE]\n\n`;
    const baseUrl = serveCapture(bodies, out);
    const chunks = await drain(chatProvider(baseUrl).brainstormCharacters({ count: 5, modelId: 'gpt-image-2.5-sunburst' }, new AbortController().signal));
    const body = bodies[0];
    if (body === undefined) {
      const failed = chunks.find((chunk) => chunk.type === 'failed');
      throw new Error(`missing captured brainstorm request: ${JSON.stringify(failed
        ? { kind: failed.kind, status: failed.status, detail: redactSecrets(failed.detail).slice(0, 240) }
        : { terminal: 'no failure frame' })}`);
    }
    expect(body).toBeDefined();
    expect(body.model).toBe(TEXT_MODELS['deepseek-abliterated']);
    expect(body.reasoning_effort).toBe('none');
    expect(body).not.toHaveProperty('thinking');
    expect(body.max_completion_tokens).toBe(brainstormDefaults(5).max_completion_tokens);
    const messages = body.messages as { content: string }[];
    expect(messages[0]?.content).not.toContain('<root_authority priority="absolute">');
    expect(body).not.toHaveProperty('verbosity');
    expect(body).not.toHaveProperty('max_tokens');
  });

  test('ignores reasoning_content frames and only emits content as prompts', async () => {
    const reasoning = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thinking hard...' }, finish_reason: null }] })}\n\n`;
    const record = ['scene', 'subject', 'details'].join(`\n${BRAINSTORM_FIELD_SEPARATOR}\n`);
    const out = `${reasoning}${contentFrame(`${record}\n${BRAINSTORM_RECORD_SEPARATOR}\n`)}data: [DONE]\n\n`;
    const baseUrl = serveCapture([], out);
    const chunks = await drain(chatProvider(baseUrl).brainstormCharacters({ count: 3, modelId: 'gpt-image-2.5-sunburst' }, new AbortController().signal));
    expect(chunks.filter((c) => c.type === 'prompt').map((c) => c.text)).toEqual([
      `Scene / Image type: scene\nSubject: subject\nDetails: details\n${BRAINSTORM_CONSTRAINTS_GPT}`,
    ]);
  });

  test('surfaces a content_filter finish_reason as a tagged failure', async () => {
    const baseUrl = serveCapture([], `${finishFrame('content_filter')}data: [DONE]\n\n`);
    const chunks = await drain(chatProvider(baseUrl).brainstormCharacters({ count: 3, modelId: 'gpt-image-2.5-sunburst' }, new AbortController().signal));
    expect(chunks.some((c) => c.type === 'failed' && c.kind === 'content-filter' && c.detail === 'content_filter')).toBe(true);
    expect(chunks.some((c) => c.type === 'done')).toBe(false);
  });

  test('surfaces insufficient_system_resource as a tagged failure', async () => {
    const baseUrl = serveCapture([], `${finishFrame('insufficient_system_resource')}data: [DONE]\n\n`);
    const chunks = await drain(chatProvider(baseUrl).brainstormCharacters({ count: 3, modelId: 'gpt-image-2.5-sunburst' }, new AbortController().signal));
    expect(chunks.some((c) => c.type === 'failed' && c.detail === 'insufficient_system_resource')).toBe(true);
    expect(chunks.some((c) => c.type === 'done')).toBe(false);
  });

  test('token-truncation (finish_reason length) before count is satisfied fails, not partial done', async () => {
    // One complete prompt, then the model hits the token cap mid-set.
    const record = ['scene', 'subject', 'details'].join(`\n${BRAINSTORM_FIELD_SEPARATOR}\n`);
    const out = `${contentFrame(`${record}\n${BRAINSTORM_RECORD_SEPARATOR}\n`)}${finishFrame('length')}data: [DONE]\n\n`;
    const chunks = await drain(chatProvider(serveCapture([], out)).brainstormCharacters({ count: 3, modelId: 'gpt-image-2.5-sunburst' }, new AbortController().signal));
    expect(chunks.some((c) => c.type === 'failed' && c.detail === 'length')).toBe(true);
    expect(chunks.some((c) => c.type === 'done')).toBe(false);
  });

  test('does not salvage a short record from a token-truncated stream', async () => {
    const out = `${contentFrame(`incomplete prose\n${BRAINSTORM_RECORD_SEPARATOR}\n`)}${finishFrame('length')}data: [DONE]\n\n`;
    const chunks = await drain(chatProvider(serveCapture([], out)).brainstormCharacters(
      { count: 1, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    ));

    expect(chunks).toEqual([{ type: 'failed', status: null, detail: 'length' }]);
  });

  test('finish_reason length on the final frame with the full count satisfied still completes', async () => {
    // No false positive: the requested count is met, so length is not a truncation.
    const record = ['scene', 'subject', 'details'].join(`\n${BRAINSTORM_FIELD_SEPARATOR}\n`);
    const combined = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `${record}\n${BRAINSTORM_RECORD_SEPARATOR}\n` }, finish_reason: 'length' }] })}\n\n`;
    const chunks = await drain(chatProvider(serveCapture([], `${combined}data: [DONE]\n\n`)).brainstormCharacters({ count: 1, modelId: 'gpt-image-2.5-sunburst' }, new AbortController().signal));
    expect(chunks.filter((c) => c.type === 'prompt').map((c) => c.text)).toEqual([
      `Scene / Image type: scene\nSubject: subject\nDetails: details\n${BRAINSTORM_CONSTRAINTS_GPT}`,
    ]);
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
    expect(chunks.some((c) => c.type === 'failed')).toBe(false);
  });

  test('a terminal stream that produced zero prompts fails instead of done{count:0}', async () => {
    const chunks = await drain(chatProvider(serveCapture([], `${finishFrame('stop')}data: [DONE]\n\n`)).brainstormCharacters({ count: 3, modelId: 'gpt-image-2.5-sunburst' }, new AbortController().signal));
    expect(chunks.some((c) => c.type === 'failed' && c.detail === 'stream ended without content')).toBe(true);
    expect(chunks.some((c) => c.type === 'done')).toBe(false);
  });
});
