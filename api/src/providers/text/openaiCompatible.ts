import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { ConnectionReport, ListedModel, TextTokenField } from '@atelier/shared';
import type { TextModelRecord } from '../../db/textProviders';
import type { ResolvedProvider, TextProtocolAdapter } from './protocol';

// OpenAI-compatible chat adapter over `@ai-sdk/openai-compatible`.
//
// Spike findings (Task 4, 2026-10-30), read from the installed type
// definitions and dist code of ai 7.0.157, @ai-sdk/openai-compatible 3.0.81,
// @ai-sdk/provider 4.0.34, @ai-sdk/provider-utils 5.0.71, cross-checked with
// Context7 /websites/ai-sdk_dev:
//
// - Provider spec is v4: `LanguageModelV4` (`specificationVersion = 'v4'`),
//   `LanguageModelV4CallOptions`, `LanguageModelV4StreamPart`. Not v3.
// - Stream parts: `stream-start { warnings }`, `response-metadata`,
//   `text-start|text-delta|text-end { id, delta }`,
//   `reasoning-start|reasoning-delta|reasoning-end { id, delta }`, tool parts,
//   `finish { finishReason, usage }`, `raw`, `error { error }`.
// - Finish reason is an object `{ unified, raw }`; `unified` is 'stop' |
//   'length' | 'content-filter' | 'tool-calls' | 'error' | 'interrupted' |
//   'other' (v4 adds 'interrupted'); `raw` is the upstream string. Upstream
//   `content_filter` → 'content-filter', `tool_calls`/`function_call` →
//   'tool-calls', anything unknown (e.g. `insufficient_system_resource`) →
//   'other' with the raw string kept.
// - A stream that ends without any finish_reason yields an `error` part
//   (`InvalidResponseDataError`, "Response stream ended without a finish
//   reason.") followed by `finish { unified: 'error', raw: undefined }`. An
//   upstream `{ "error": {...} }` frame yields an `error` part carrying the
//   parsed error object and sets the finish to 'error'. Unparseable chunks
//   yield `error` parts too and the stream continues. SSE `event:` names are
//   ignored and `[DONE]` is skipped (the stream ends on close).
// - `APICallError` exposes `statusCode?`, `responseHeaders?` (record with
//   lower-case keys), `responseBody?` (raw text), `isRetryable`, `cause`.
//   Connection failures are `APICallError` without a status; a body-read
//   failure after a 2xx is "Failed to process successful response" with the
//   original error as `cause`.
// - `maxOutputTokens` is sent as `max_tokens` (never
//   `max_completion_tokens`). `transformRequestBody` renames it per
//   `token_field`.
// - `providerOptions.openaiCompatible.reasoningEffort` (or the provider-name
//   key) is sent unchanged as `reasoning_effort`; `textVerbosity` →
//   `verbosity`; `strictJsonSchema` (default true) → `json_schema.strict`.
// - `responseFormat { type: 'json', schema, name }` with
//   `supportsStructuredOutputs: true` →
//   `{ type: 'json_schema', json_schema: { schema, strict, name, description } }`
//   (`name` defaults to 'response', an undefined description is dropped by
//   JSON); without a schema, or without structured-output support,
//   `{ type: 'json_object' }`.
// - `temperature`/`topP` → `temperature`/`top_p`; undefined fields are left
//   out of the JSON.
// - A user message with a single text part is sent as a plain string;
//   otherwise as parts, an image file part as
//   `{ type: 'image_url', image_url: { url: 'data:<mime>;base64,…' } }`.
// - `delta.reasoning_content ?? delta.reasoning` (and non-streaming
//   `message.reasoning_content ?? message.reasoning`) become reasoning parts.
// - `doStream` adds `stream: true` (and `stream_options` only with
//   `includeUsage`); `doGenerate` sends no `stream` field.
//   `transformRequestBody` sets `stream: false` there, as the legacy body did.
// - `apiKey` adds `Authorization: Bearer <key>`; requests go to
//   `${baseURL}/chat/completions`.

/** providerOptions key the chat model reads `reasoningEffort`/`strictJsonSchema` from, whatever the provider name. */
export const OPENAI_COMPATIBLE_OPTIONS_KEY = 'openaiCompatible';

/**
 * Normalises the SDK body to the legacy wire: the output budget under the
 * provider's `token_field`, and an explicit `stream: false` on non-streaming
 * calls.
 */
export function normaliseRequestBody(tokenField: TextTokenField) {
  return (body: Record<string, unknown>): Record<string, unknown> => {
    const { max_tokens: maxTokens, ...rest } = body;
    return { ...rest, stream: rest.stream ?? false, [tokenField]: maxTokens };
  };
}

function languageModel(
  provider: ResolvedProvider,
  model: TextModelRecord,
  fetch: typeof globalThis.fetch,
): LanguageModelV4 {
  return createOpenAICompatible({
    name: `p-${provider.id}`,
    baseURL: provider.baseUrl,
    ...(provider.credential === null ? {} : { apiKey: provider.credential }),
    fetch,
    supportsStructuredOutputs: model.structuredOutput === 'json_schema',
    transformRequestBody: normaliseRequestBody(provider.tokenField),
  }).chatModel(model.modelId);
}

export const openaiCompatibleAdapter: TextProtocolAdapter = {
  protocol: 'openai-compatible',
  languageModel,
  // Task 5 fills listing and the connection probe.
  listModels(): Promise<ListedModel[]> {
    return Promise.reject(new Error('openai-compatible listModels is not implemented yet'));
  },
  probeConnection(): Promise<ConnectionReport> {
    return Promise.reject(new Error('openai-compatible probeConnection is not implemented yet'));
  },
};
