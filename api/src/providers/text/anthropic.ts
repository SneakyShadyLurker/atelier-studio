import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { TextReasoningEffort } from '@atelier/shared';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import type { TextModelRecord } from '../../db/textProviders';
import { listModels } from './listModels';
import { runConnectionProbe } from './probe';
import type { ReasoningOptions, ResolvedProvider, TextProtocolAdapter } from './protocol';

// Anthropic Messages adapter over `@ai-sdk/anthropic`.
//
// Findings (Task 5, 2026-10-30), read from the installed source of
// @ai-sdk/anthropic 4.0.92 and ai 7.0.157, cross-checked with Context7
// /websites/ai-sdk_dev:
//
// - `createAnthropic({ baseURL, apiKey, fetch })` posts to `${baseURL}/messages`
//   with `anthropic-version: 2023-06-01` and `x-api-key: <apiKey>`. When
//   `apiKey` is undefined it falls back to `process.env.ANTHROPIC_API_KEY`
//   (and throws LoadAPIKeyError when that is unset too); it never reads
//   ANTHROPIC_AUTH_TOKEN. `authToken` would send `Authorization: Bearer`
//   instead. `ANTHROPIC_BASE_URL` is read only when `baseURL` is unset.
// - An empty-string `apiKey` stops the env fallback but still sends an empty
//   `x-api-key` header, so keyless providers pass '' and a fetch wrapper drops
//   the empty header.
// - `structuredOutputMode` is a call-time provider option, not a provider
//   setting; the adapter sets the row's mode as a default through
//   `defaultSettingsMiddleware` (deep merge, caller options win).
//   'outputFormat' sends `output_config.format { type: 'json_schema', schema }`
//   for every model id (including non-Claude ids on compatible servers).
//   'jsonTool' adds a forced `json` tool (`tool_choice { type: 'any' }`); the
//   SDK turns that tool's input into text parts (streamed `input_json_delta`
//   become `text-delta`) and maps the `tool_use` stop to finish
//   `{ unified: 'stop', raw: 'tool_use' }`, so the finish rule needs no
//   special case. Models the SDK knows reject forced tool use (Opus 5.5,
//   Fable 5.1) are switched to 'outputFormat' with a warning.
// - Both modes need a schema: a JSON response format without one is ignored
//   with an 'unsupported' warning and the call is plain text.
// - Effort is `providerOptions.anthropic.effort` ('low'|'medium'|'high'|
//   'xhigh'|'max') → `output_config.effort`. The SDK reads options from the
//   canonical 'anthropic' key whatever the provider name.
// - Stop reasons: end_turn/stop_sequence/pause_turn → 'stop', refusal →
//   'content-filter', max_tokens → 'length', tool_use → 'tool-calls' (or
//   'stop' from the json tool), others → 'other'.

/** providerOptions key the Anthropic model reads `effort`/`structuredOutputMode` from. */
export const ANTHROPIC_OPTIONS_KEY = 'anthropic';

/** Version header the SDK sends; the list call sends the same. */
export const ANTHROPIC_VERSION = '2023-06-01';

const ANTHROPIC_EFFORTS = new Set<TextReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Provider options for one reasoning level. Anthropic has no 'none' or
 * 'minimal' effort; those are left out and reported as a wire note.
 */
export function anthropicReasoningOptions(level: TextReasoningEffort | null): ReasoningOptions {
  if (level === null) return { providerOptions: {}, wireNote: null };
  if (ANTHROPIC_EFFORTS.has(level)) {
    return { providerOptions: { [ANTHROPIC_OPTIONS_KEY]: { effort: level } }, wireNote: null };
  }
  return {
    providerOptions: {},
    wireNote: `Anthropic has no '${level}' effort; the request was sent without an effort setting.`,
  };
}

/** Drops the empty `x-api-key` a keyless provider would otherwise send. */
function withoutEmptyApiKey(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  const keyless = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (headers.get('x-api-key') === '') headers.delete('x-api-key');
    return fetch(input, { ...init, headers });
  };
  return Object.assign(keyless, { preconnect: fetch.preconnect });
}

function languageModel(
  provider: ResolvedProvider,
  model: TextModelRecord,
  fetch: typeof globalThis.fetch,
): LanguageModelV4 {
  const keyless = provider.credential === null;
  const base = createAnthropic({
    baseURL: provider.baseUrl,
    // '' (not undefined) so the SDK never falls back to ANTHROPIC_API_KEY.
    apiKey: provider.credential ?? '',
    fetch: keyless ? withoutEmptyApiKey(fetch) : fetch,
  }).messages(model.modelId);
  return wrapLanguageModel({
    model: base,
    middleware: defaultSettingsMiddleware({
      settings: {
        providerOptions: {
          [ANTHROPIC_OPTIONS_KEY]: {
            structuredOutputMode: model.structuredOutput === 'json_schema' ? 'outputFormat' : 'jsonTool',
          },
        },
      },
    }),
  });
}

export const anthropicAdapter: TextProtocolAdapter = {
  protocol: 'anthropic',
  languageModel,
  reasoningOptions: anthropicReasoningOptions,
  listModels,
  probeConnection: (provider, signal, options) => runConnectionProbe(anthropicAdapter, provider, signal, options),
};
