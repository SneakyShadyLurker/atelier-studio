import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { TextProtocol } from '@atelier/shared';
import {
  anthropicHints,
  bodyExcerpt,
  extractHints,
  listModels,
  lmStudioHints,
  modalityHints,
  openRouterHints,
  parseModelList,
  TextListError,
} from './listModels';
import type { ResolvedProvider } from './protocol';

// Spec § 6.4: list calls for both protocols, bounded and unretried, and hint
// extractors keyed by response shape.

const OPENROUTER = {
  data: [
    {
      id: 'openai/gpt-5',
      name: 'GPT-5',
      context_length: 400_000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      top_provider: { max_completion_tokens: 128_000 },
      supported_parameters: ['max_tokens', 'response_format', 'structured_outputs', 'reasoning', 'include_reasoning'],
    },
    {
      id: 'meta-llama/llama-3-8b',
      context_length: 8192,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      top_provider: { max_completion_tokens: null },
      supported_parameters: ['max_tokens', 'response_format'],
    },
  ],
};

const ANTHROPIC = {
  data: [
    {
      type: 'model',
      id: 'claude-opus-4-8',
      display_name: 'Claude Opus 4.8',
      created_at: '2026-08-01T00:00:00Z',
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      capabilities: {
        image_input: { supported: true },
        structured_outputs: { supported: true },
        thinking: { supported: true },
        effort: {
          supported: true,
          low: { supported: true },
          medium: { supported: true },
          high: { supported: true },
          xhigh: { supported: true },
          max: { supported: true },
        },
      },
    },
    {
      type: 'model',
      id: 'claude-3-haiku-20240307',
      display_name: 'Claude Haiku 3',
      max_input_tokens: 200_000,
      max_tokens: 4096,
      capabilities: {
        image_input: { supported: true },
        structured_outputs: { supported: false },
        thinking: { supported: false },
        effort: { supported: false },
      },
    },
  ],
  has_more: false,
  first_id: 'claude-opus-4-8',
  last_id: 'claude-3-haiku-20240307',
};

const LM_STUDIO_NATIVE = {
  models: [
    {
      type: 'llm',
      key: 'qwen/qwen3-vl-8b',
      display_name: 'Qwen3 VL 8B',
      max_context_length: 262_144,
      capabilities: { vision: true, trained_for_tool_use: true, reasoning: { allowed_options: ['off', 'low', 'medium', 'high'], default: 'medium' } },
    },
    { type: 'llm', key: 'mistral-7b', max_context_length: 32_768, capabilities: { vision: false, trained_for_tool_use: false } },
  ],
};

const LLAMA_CPP = {
  object: 'list',
  data: [{ id: 'gemma-3-12b', object: 'model', owned_by: 'llamacpp', architecture: { input_modalities: ['text', 'image'] } }],
};

const MISTRAL = {
  object: 'list',
  data: [{ id: 'pixtral-large-latest', object: 'model', max_context_length: 131_072, capabilities: { completion_chat: true, vision: true } }],
};

const IDS_ONLY = {
  object: 'list',
  data: [{ id: 'gpt-4.1', object: 'model', owned_by: 'openai' }, { id: 'o4-mini', object: 'model', owned_by: 'openai' }],
};

describe('hint extractors', () => {
  test('OpenRouter: modalities, supported parameters and limits', () => {
    expect(openRouterHints(OPENROUTER.data[0])).toEqual({
      vision: true,
      structuredOutput: 'json_schema',
      reasoningLevels: ['low', 'medium', 'high'],
      contextLength: 400_000,
      maxOutputTokens: 128_000,
    });
    expect(openRouterHints(OPENROUTER.data[1])).toEqual({ vision: false, structuredOutput: 'json_object', contextLength: 8192 });
  });

  test('Anthropic: capabilities and token limits', () => {
    expect(anthropicHints(ANTHROPIC.data[0])).toEqual({
      vision: true,
      structuredOutput: 'json_schema',
      reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      contextLength: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(anthropicHints(ANTHROPIC.data[1])).toEqual({
      vision: true,
      structuredOutput: 'json_object',
      reasoningLevels: [],
      contextLength: 200_000,
      maxOutputTokens: 4096,
    });
  });

  test('LM Studio native: vision flag and reasoning options', () => {
    expect(lmStudioHints(LM_STUDIO_NATIVE.models[0])).toEqual({
      vision: true,
      reasoningLevels: ['none', 'low', 'medium', 'high'],
      contextLength: 262_144,
    });
    expect(lmStudioHints(LM_STUDIO_NATIVE.models[1])).toEqual({ vision: false, contextLength: 32_768 });
  });

  test('llama.cpp and Mistral: input modalities or the vision flag', () => {
    expect(modalityHints(LLAMA_CPP.data[0])).toEqual({ vision: true });
    expect(modalityHints(MISTRAL.data[0])).toEqual({ vision: true, contextLength: 131_072 });
  });

  test('extractHints picks the extractor by shape; unknown shapes give no hints', () => {
    expect(extractHints(OPENROUTER.data[0])).toEqual(openRouterHints(OPENROUTER.data[0]));
    expect(extractHints(ANTHROPIC.data[0])).toEqual(anthropicHints(ANTHROPIC.data[0]));
    expect(extractHints(LM_STUDIO_NATIVE.models[0])).toEqual(lmStudioHints(LM_STUDIO_NATIVE.models[0]));
    expect(extractHints(LLAMA_CPP.data[0])).toEqual({ vision: true });
    expect(extractHints(MISTRAL.data[0])).toEqual({ vision: true, contextLength: 131_072 });
    expect(extractHints(IDS_ONLY.data[0])).toBeUndefined();
    expect(extractHints({ id: 'x', capabilities: 'weird', architecture: 7 })).toBeUndefined();
  });

  test('parseModelList reads `data` or `models`, ids or keys, and skips junk entries', () => {
    expect(parseModelList(IDS_ONLY)).toEqual([
      { id: 'gpt-4.1', source: 'provider' },
      { id: 'o4-mini', source: 'provider' },
    ]);
    expect(parseModelList(LM_STUDIO_NATIVE).map((m) => m.id)).toEqual(['qwen/qwen3-vl-8b', 'mistral-7b']);
    expect(parseModelList({ data: [{ id: '' }, null, 'x', { id: 'ok' }, { id: 'ok' }] })).toEqual([{ id: 'ok', source: 'provider' }]);
    expect(() => parseModelList({ nope: true })).toThrow(TextListError);
  });
});

interface Captured {
  readonly url: URL;
  readonly headers: Headers;
}

let server: ReturnType<typeof Bun.serve>;
let origin = '';
const captured: Captured[] = [];
let respond: (url: URL) => Response | Promise<Response> = () => Response.json(IDS_ONLY);

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      captured.push({ url, headers: req.headers });
      return respond(url);
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  void server.stop(true);
});

afterEach(() => {
  respond = () => Response.json(IDS_ONLY);
});

function provider(protocol: TextProtocol, credential: string | null): ResolvedProvider {
  return {
    id: 'prov',
    name: 'P',
    protocol,
    baseUrl: `${origin}/v1`,
    preset: null,
    auth: credential === null ? 'none' : 'stored',
    tokenField: 'max_completion_tokens',
    listModels: true,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    credential,
  };
}

function last(): Captured {
  const request = captured.at(-1);
  if (request === undefined) throw new Error('nothing captured');
  return request;
}

const signal = (): AbortSignal => new AbortController().signal;

async function listError(promise: Promise<unknown>): Promise<TextListError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TextListError) return err;
    throw err;
  }
  throw new Error('expected a TextListError');
}

describe('listModels', () => {
  test('OpenAI-compatible: GET {base}/models with a bearer key', async () => {
    respond = () => Response.json(OPENROUTER);
    const result = await listModels(provider('openai-compatible', 'sk-or-secret-key'), signal());
    expect(last().url.pathname).toBe('/v1/models');
    expect(last().url.search).toBe('');
    expect(last().headers.get('authorization')).toBe('Bearer sk-or-secret-key');
    expect(result.listUnsupported).toBe(false);
    expect(result.models).toEqual(parseModelList(OPENROUTER));
    expect(result.models[0]?.hints?.vision).toBe(true);
  });

  test('OpenAI-compatible keyless: no Authorization header', async () => {
    await listModels(provider('openai-compatible', null), signal());
    expect(last().headers.get('authorization')).toBeNull();
  });

  test('Anthropic: GET {base}/models?limit=1000 with x-api-key and anthropic-version', async () => {
    respond = () => Response.json(ANTHROPIC);
    const result = await listModels(provider('anthropic', 'sk-ant-secret-key'), signal());
    expect(last().url.pathname).toBe('/v1/models');
    expect(last().url.searchParams.get('limit')).toBe('1000');
    expect(last().headers.get('x-api-key')).toBe('sk-ant-secret-key');
    expect(last().headers.get('anthropic-version')).toBe('2023-06-01');
    expect(last().headers.get('authorization')).toBeNull();
    expect(result.models.map((m) => m.id)).toEqual(['claude-opus-4-8', 'claude-3-haiku-20240307']);
  });

  test('Anthropic keyless: no x-api-key header', async () => {
    respond = () => Response.json(ANTHROPIC);
    await listModels(provider('anthropic', null), signal());
    expect(last().headers.get('x-api-key')).toBeNull();
    expect(last().headers.get('anthropic-version')).toBe('2023-06-01');
  });

  for (const status of [404, 405]) {
    test(`${status} means the provider has no list endpoint`, async () => {
      respond = () => new Response('not here', { status });
      expect(await listModels(provider('openai-compatible', null), signal())).toEqual({ models: [], listUnsupported: true });
    });
  }

  test('other failures are plain, redacted TextListErrors and are not retried', async () => {
    respond = () => new Response('bad key sk-or-secret-key', { status: 401 });
    const before = captured.length;
    const err = await listError(listModels(provider('openai-compatible', 'sk-or-secret-key'), signal()));
    expect(captured.length).toBe(before + 1);
    expect(err.status).toBe(401);
    expect(err.message).toContain('refused the key');
    expect(err.message).not.toContain('sk-or-secret-key');

    respond = () => new Response('upstream exploded', { status: 503 });
    const server503 = await listError(listModels(provider('openai-compatible', null), signal()));
    expect(server503.status).toBe(503);
    expect(server503.message).toContain('503');
    expect(captured.length).toBe(before + 2);
  });

  test('redirects are rejected', async () => {
    respond = () => new Response(null, { status: 302, headers: { location: `${origin}/elsewhere` } });
    const err = await listError(listModels(provider('openai-compatible', null), signal()));
    expect(err.message).toContain('redirect');
    expect(captured.some((c) => c.url.pathname === '/elsewhere')).toBe(false);
  });

  test('a body over 1 MiB is rejected', async () => {
    respond = () => Response.json({ data: [{ id: 'x'.repeat(1_100_000) }] });
    const err = await listError(listModels(provider('openai-compatible', null), signal()));
    expect(err.message).toContain('1 MiB');
  });

  test('a body that is not a model list is rejected', async () => {
    respond = () => new Response('<html>hello</html>');
    expect((await listError(listModels(provider('openai-compatible', null), signal()))).message).toContain('not JSON');
  });

  test('times out with a plain message', async () => {
    respond = () => new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(Response.json(IDS_ONLY));
      }, 2_000);
    });
    const err = await listError(listModels(provider('openai-compatible', null), signal(), 50));
    expect(err.message).toContain('did not answer');
  });

  test('the caller abort propagates as an abort, not a list error', async () => {
    respond = () => new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(Response.json(IDS_ONLY));
      }, 2_000);
    });
    const controller = new AbortController();
    const pending = listModels(provider('openai-compatible', null), controller.signal);
    controller.abort();
    let thrown: unknown;
    try {
      await pending;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TextListError);
    expect((thrown as Error).name).toBe('AbortError');
  });
});

describe('bodyExcerpt', () => {
  test('a key straddling the 160-character cut never leaks a prefix', () => {
    const key = 'sk-straddle-0123456789abcdef';
    const body = `${'x'.repeat(150)}${key} tail`;
    const excerpt = bodyExcerpt(key, body);
    expect(excerpt).not.toContain('sk-straddle');
    expect(excerpt.length).toBeLessThanOrEqual(161);
  });
});
