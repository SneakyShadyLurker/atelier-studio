import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { TextReasoningEffort, TextTokenField } from '@atelier/shared';
import { LEGACY_SEED, type LegacySeedModel } from '../../db/textSeed';
import type { TextModelRecord } from '../../db/textProviders';
import { RESCUE_RESPONSE_FORMAT } from '../../prompts/inferParse';
import { STORY_PLAN_RESPONSE_FORMAT } from '../../prompts/storyPlannerSystemPrompt';
import {
  AI_FILL_BATCH_MAX_COMPLETION_TOKENS,
  AI_FILL_DEFAULTS,
  brainstormDefaults,
  CLIPROXY_TEXT_DEFAULTS,
  DRAFT_LIST_DEFAULTS,
  DRAFT_TEMPLATE_DEFAULTS,
  INFER_DIMENSIONS_DEFAULTS,
  legacyChatBody,
  STORY_PLANNER_DEFAULTS,
  type ChatDefaults,
  type ChatResponseFormat,
  type ChatUserContentPart,
} from '../../test/legacyChatBody';
import { boundedFetch } from './fetch';
import { classifyFinish } from './finish';
import { openaiCompatibleAdapter } from './openaiCompatible';
import type { ResolvedProvider } from './protocol';
import { textCallOptions } from './textModel';
import { hostPortProbeResponse, isHostPortProbe } from '../../test/hostProbe';

// Spec § 11.2 item 1: for every migrated model and every feature call shape,
// the AI SDK adapter sends the body the legacy `buildChatBody` sent.

const TOKEN = 'test-proxy-token';

interface Captured {
  readonly path: string;
  readonly authorization: string | null;
  readonly body: Record<string, unknown>;
}

let server: ReturnType<typeof Bun.serve>;
let origin = '';
const captured: Captured[] = [];
let sseOverride: string | null = null;

const SSE_OK = 'data: {"id":"c1","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const JSON_OK = JSON.stringify({
  id: 'c1',
  created: 0,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (isHostPortProbe(req)) return hostPortProbeResponse();
      const body = await req.json() as Record<string, unknown>;
      captured.push({ path: new URL(req.url).pathname, authorization: req.headers.get('authorization'), body });
      if (body.stream === true) {
        return new Response(sseOverride ?? SSE_OK, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON_OK, { headers: { 'content-type': 'application/json' } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  void server.stop(true);
});

function provider(tokenField: TextTokenField = LEGACY_SEED.provider.tokenField): ResolvedProvider {
  return {
    id: 'prov-cliproxy',
    name: LEGACY_SEED.provider.name,
    protocol: LEGACY_SEED.provider.protocol,
    baseUrl: `${origin}${LEGACY_SEED.provider.basePath}`,
    preset: LEGACY_SEED.provider.preset,
    auth: LEGACY_SEED.provider.authMode,
    envVar: LEGACY_SEED.provider.credentialEnv,
    tokenField,
    listModels: LEGACY_SEED.provider.listModels,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    credential: TOKEN,
  };
}

function modelRecord(seed: LegacySeedModel, sortOrder: number): TextModelRecord {
  return {
    ...seed.capabilities,
    id: `model-${seed.legacyKey}`,
    providerId: 'prov-cliproxy',
    modelId: seed.defaultModelId,
    displayName: seed.displayName,
    enabled: true,
    screenRequests: seed.screenRequests,
    sortOrder,
    verifiedAt: null,
    lastTest: null,
    legacyKey: seed.legacyKey,
  };
}

interface ImageInput {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

/** One feature call as the legacy CLIProxy text provider's feature methods made it. */
interface CallShape {
  readonly name: string;
  readonly defaults: ChatDefaults;
  readonly systemPrompt: string;
  readonly user: string;
  readonly images?: readonly ImageInput[];
  readonly responseFormat?: ChatResponseFormat;
  readonly userEffort?: TextReasoningEffort;
  readonly stream: boolean;
}

const IMAGES: readonly ImageInput[] = [
  { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), mime: 'image/png' },
  { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]), mime: 'image/jpeg' },
];

const AI_FILL_BATCH_SIZE = 4;

// Shapes derived from enhance (default defaults, optional images), the story
// planner route (enhance with STORY_PLANNER_DEFAULTS + strict schema),
// brainstormCharacters (brainstormDefaults(count, userEffort)), aiFill
// (AI_FILL_DEFAULTS, batch scales the budget), inferWithPolicy (json_object),
// rescueDimension (strict schema), draftList (json_object) and draftTemplate
// (no format, non-streaming).
const SHAPES: readonly CallShape[] = [
  { name: 'enhance plain', defaults: CLIPROXY_TEXT_DEFAULTS, systemPrompt: 'enhance system', user: 'a red fox at dusk', stream: true },
  { name: 'enhance with image', defaults: CLIPROXY_TEXT_DEFAULTS, systemPrompt: 'enhance system', user: 'describe this', images: IMAGES, stream: true },
  { name: 'ai-fill single', defaults: AI_FILL_DEFAULTS, systemPrompt: 'ai-fill system', user: 'fill {{a}}', stream: true },
  {
    name: 'ai-fill batch',
    defaults: {
      ...AI_FILL_DEFAULTS,
      max_completion_tokens: Math.min(AI_FILL_DEFAULTS.max_completion_tokens * AI_FILL_BATCH_SIZE, AI_FILL_BATCH_MAX_COMPLETION_TOKENS),
    },
    systemPrompt: 'ai-fill system',
    user: 'fill four',
    stream: true,
  },
  { name: 'brainstorm count 12 default effort', defaults: brainstormDefaults(12), systemPrompt: 'brainstorm system', user: 'brief', stream: true },
  {
    name: 'brainstorm count 12 pinned high',
    defaults: brainstormDefaults(12, 'high'),
    systemPrompt: 'brainstorm system',
    user: 'brief',
    userEffort: 'high',
    stream: true,
  },
  {
    name: 'story planner strict schema',
    defaults: STORY_PLANNER_DEFAULTS,
    systemPrompt: 'story system',
    user: 'outline',
    responseFormat: STORY_PLAN_RESPONSE_FORMAT,
    stream: true,
  },
  { name: 'infer json_object', defaults: INFER_DIMENSIONS_DEFAULTS, systemPrompt: 'infer system', user: '{"lists":[]}', responseFormat: 'json_object', stream: true },
  {
    name: 'rescue strict schema',
    defaults: INFER_DIMENSIONS_DEFAULTS,
    systemPrompt: 'rescue system',
    user: '{"targetListName":"x"}',
    responseFormat: RESCUE_RESPONSE_FORMAT,
    stream: true,
  },
  { name: 'list draft', defaults: DRAFT_LIST_DEFAULTS, systemPrompt: 'draft list system', user: 'name: colours', responseFormat: 'json_object', stream: true },
  { name: 'template draft non-streaming', defaults: DRAFT_TEMPLATE_DEFAULTS, systemPrompt: 'draft template system', user: 'a portrait template', stream: false },
];

/** Images a model receives: none without vision (routing never sent it any), else up to `maxImages`. */
function imagesFor(model: TextModelRecord, shape: CallShape): readonly ImageInput[] {
  if (!model.vision) return [];
  const images = shape.images ?? [];
  return model.maxImages === null ? images : images.slice(0, model.maxImages);
}

function legacyBody(model: TextModelRecord, shape: CallShape): Record<string, unknown> {
  const images = imagesFor(model, shape);
  const userContent: string | readonly ChatUserContentPart[] = images.length === 0
    ? shape.user
    : [
        { type: 'text', text: shape.user },
        ...images.map((img): ChatUserContentPart => ({
          type: 'image_url',
          image_url: { url: `data:${img.mime};base64,${Buffer.from(img.bytes).toString('base64')}` },
        })),
      ];
  return legacyChatBody(
    model.modelId,
    LEGACY_SEED.models.find((m) => m.legacyKey === model.legacyKey)?.legacyKey,
    {
      defaults: shape.defaults,
      systemPrompt: shape.systemPrompt,
      userContent,
      ...(shape.responseFormat ? { responseFormat: shape.responseFormat } : {}),
      ...(shape.userEffort === undefined ? {} : { reasoningEffort: shape.userEffort }),
    },
    shape.stream,
  );
}

/** Call options from the production builder, for the feature call this shape stands for. */
function callOptions(model: TextModelRecord, shape: CallShape): LanguageModelV4CallOptions {
  return textCallOptions(openaiCompatibleAdapter, model, {
    maxOutputTokens: shape.defaults.max_completion_tokens,
    systemPrompt: shape.systemPrompt,
    user: shape.user,
    ...(shape.images === undefined ? {} : { images: shape.images }),
    ...(shape.responseFormat === undefined ? {} : { responseFormat: shape.responseFormat }),
    ...(shape.userEffort === undefined ? {} : { userEffort: shape.userEffort }),
  });
}

async function drain(stream: ReadableStream<LanguageModelV4StreamPart>): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

/** Sends one call through the adapter and returns the captured request. */
async function send(
  model: TextModelRecord,
  shape: CallShape,
  tokenField?: TextTokenField,
): Promise<{ request: Captured; parts: LanguageModelV4StreamPart[] }> {
  const languageModel = openaiCompatibleAdapter.languageModel(
    provider(tokenField),
    model,
    boundedFetch({ maxBytes: 1_000_000 }),
  );
  const before = captured.length;
  const options = callOptions(model, shape);
  let parts: LanguageModelV4StreamPart[] = [];
  if (shape.stream) {
    parts = await drain((await languageModel.doStream(options)).stream);
  } else {
    const result = await languageModel.doGenerate(options);
    expect(classifyFinish(result)).toBeNull();
  }
  expect(captured.length).toBe(before + 1);
  const request = captured[before];
  if (request === undefined) throw new Error('no request captured');
  return { request, parts };
}

const MODELS = LEGACY_SEED.models.map(modelRecord);

describe('wire compatibility with the legacy CLIProxyAPI body', () => {
  for (const model of MODELS) {
    for (const shape of SHAPES) {
      test(`${model.legacyKey}: ${shape.name}`, async () => {
        const { request, parts } = await send(model, shape);
        expect(request.path).toBe('/v1/chat/completions');
        expect(request.authorization).toBe(`Bearer ${TOKEN}`);
        expect(request.body).toEqual(legacyBody(model, shape));
        if (shape.stream) {
          expect(classifyFinish(parts.find((p) => p.type === 'finish'))).toBeNull();
          expect(parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')).toBe('ok');
        }
      });
    }
  }

  test('pinned facts: GLM sends no response_format, Grok samples, GPT pins medium, nobody sends verbosity', async () => {
    const byKey = (key: string): TextModelRecord => {
      const found = MODELS.find((m) => m.legacyKey === key);
      if (found === undefined) throw new Error(key);
      return found;
    };
    const rescue = SHAPES.find((s) => s.name === 'rescue strict schema');
    const pinned = SHAPES.find((s) => s.name === 'brainstorm count 12 pinned high');
    if (rescue === undefined || pinned === undefined) throw new Error('shape missing');
    expect((await send(byKey('glm-abliterated'), rescue)).request.body).not.toHaveProperty('response_format');
    expect((await send(byKey('grok'), rescue)).request.body).toMatchObject({ temperature: 0.7, top_p: 0.95 });
    expect((await send(byKey('gpt'), pinned)).request.body).toMatchObject({ reasoning_effort: 'medium' });
    for (const model of MODELS) {
      expect((await send(model, rescue)).request.body).not.toHaveProperty('verbosity');
    }
  });

  test("token_field 'max_tokens' sends max_tokens instead", async () => {
    const kimi = MODELS[0];
    const shape = SHAPES[0];
    if (kimi === undefined || shape === undefined) throw new Error('fixture missing');
    const { request } = await send(kimi, shape, 'max_tokens');
    const { max_completion_tokens: budget, ...rest } = legacyBody(kimi, shape);
    expect(request.body).toEqual({ ...rest, max_tokens: budget });
  });

  test('delta.reasoning_content surfaces as reasoning parts before the text', async () => {
    const kimi = MODELS[0];
    const shape = SHAPES[0];
    if (kimi === undefined || shape === undefined) throw new Error('fixture missing');
    sseOverride = [
      'data: {"id":"c1","created":0,"model":"m","choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}',
      'data: {"id":"c1","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    try {
      const { parts } = await send(kimi, shape);
      const kinds = parts.map((p) => p.type).filter((t) => t.startsWith('reasoning') || t.startsWith('text'));
      expect(kinds).toEqual(['reasoning-start', 'reasoning-delta', 'reasoning-end', 'text-start', 'text-delta', 'text-end']);
      expect(parts.find((p) => p.type === 'reasoning-delta')).toMatchObject({ delta: 'thinking' });
    } finally {
      sseOverride = null;
    }
  });
});
