import { TEXT_REASONING_EFFORT_VALUES, type ListedModel, type TextModelHints, type TextReasoningEffort } from '@atelier/shared';
import { redactSecrets } from '../../observability/redact';
import { boundedFetch, TextResponseTooLargeError } from './fetch';
import type { ListModelsResult, ResolvedProvider } from './protocol';

// The provider's model list (spec § 6.4): OpenAI-compatible `GET {base}/models`,
// Anthropic `GET {base}/models?limit=1000`. One bounded attempt: 10 s, 1 MiB,
// redirects refused, no retry. The AI SDK has no list call for either
// protocol, so this is the one hand-built request besides the SDK's own.
//
// Capability hints come from small pure extractors keyed by the entry's shape,
// not by preset. They are unverified provider claims; "Test model" proves them.

export const LIST_TIMEOUT_MS = 10_000;
export const LIST_MAX_BYTES = 1024 * 1024;

/** Version header Anthropic expects; the same value `@ai-sdk/anthropic` sends. */
const ANTHROPIC_VERSION = '2023-06-01';

/** Why a list call failed, for logs and the availability poller. */
export type TextListFailure = 'timeout' | 'too_large' | 'redirect' | 'transport' | 'http_status' | 'invalid_body';

/** The list call failed; `message` is plain English and already redacted. */
export class TextListError extends Error {
  override readonly name = 'TextListError';
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly reason: TextListFailure = status === null ? 'transport' : 'http_status',
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;
}

/** `true`, or Anthropic's `{ supported: true }`. Undefined when the field says nothing. */
function supported(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (isObject(value) && typeof value.supported === 'boolean') return value.supported;
  return undefined;
}

function isEffort(value: string): value is TextReasoningEffort {
  return (TEXT_REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

/** Drops undefined fields; undefined when nothing is left. */
function compact(hints: { -readonly [K in keyof TextModelHints]: TextModelHints[K] | undefined }): TextModelHints | undefined {
  const entries = Object.entries(hints).filter(([, v]) => v !== undefined);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** OpenRouter `/api/v1/models`: `architecture.input_modalities`, `supported_parameters`, limits. */
export function openRouterHints(entry: unknown): TextModelHints | undefined {
  if (!isObject(entry)) return undefined;
  const params = stringArray(entry.supported_parameters) ?? [];
  const modalities = isObject(entry.architecture) ? stringArray(entry.architecture.input_modalities) : undefined;
  const structuredOutput = params.includes('structured_outputs')
    ? 'json_schema'
    : params.includes('response_format') ? 'json_object' : undefined;
  return compact({
    vision: modalities?.includes('image'),
    structuredOutput,
    reasoningLevels: params.includes('reasoning') || params.includes('reasoning_effort') ? ['low', 'medium', 'high'] : undefined,
    contextLength: positiveInt(entry.context_length),
    maxOutputTokens: isObject(entry.top_provider) ? positiveInt(entry.top_provider.max_completion_tokens) : undefined,
  });
}

const ANTHROPIC_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Anthropic `/v1/models`: `capabilities.image_input/structured_outputs/effort`, `max_input_tokens`, `max_tokens`. */
export function anthropicHints(entry: unknown): TextModelHints | undefined {
  if (!isObject(entry) || !isObject(entry.capabilities)) return undefined;
  const caps = entry.capabilities;
  const structured = supported(caps.structured_outputs);
  const effort = caps.effort;
  let reasoningLevels: TextReasoningEffort[] | undefined;
  if (supported(effort) === false) reasoningLevels = [];
  else if (supported(effort) === true && isObject(effort)) {
    reasoningLevels = ANTHROPIC_EFFORT_ORDER.filter((level) => supported(effort[level]) === true);
  }
  return compact({
    vision: supported(caps.image_input),
    // Without native structured outputs the json tool still works.
    structuredOutput: structured === undefined ? undefined : structured ? 'json_schema' : 'json_object',
    reasoningLevels,
    contextLength: positiveInt(entry.max_input_tokens),
    maxOutputTokens: positiveInt(entry.max_tokens),
  });
}

/**
 * LM Studio native `/api/v1/models`: `capabilities.vision`,
 * `capabilities.reasoning.allowed_options` ('off' read as 'none'),
 * `max_context_length`.
 */
export function lmStudioHints(entry: unknown): TextModelHints | undefined {
  if (!isObject(entry) || !isObject(entry.capabilities)) return undefined;
  const caps = entry.capabilities;
  const options = isObject(caps.reasoning) ? stringArray(caps.reasoning.allowed_options) : undefined;
  const levels = options
    ?.map((option) => (option === 'off' ? 'none' : option))
    .filter(isEffort);
  return compact({
    vision: typeof caps.vision === 'boolean' ? caps.vision : undefined,
    reasoningLevels: levels === undefined || levels.length === 0 ? undefined : levels,
    contextLength: positiveInt(entry.max_context_length),
  });
}

/** llama.cpp (`architecture.input_modalities`) and Mistral (`capabilities.vision`, `max_context_length`). */
export function modalityHints(entry: unknown): TextModelHints | undefined {
  if (!isObject(entry)) return undefined;
  const modalities = isObject(entry.architecture) ? stringArray(entry.architecture.input_modalities) : undefined;
  const flag = isObject(entry.capabilities) && typeof entry.capabilities.vision === 'boolean' ? entry.capabilities.vision : undefined;
  return compact({
    vision: modalities === undefined ? flag : modalities.includes('image'),
    contextLength: positiveInt(entry.max_context_length),
  });
}

/** Picks the extractor by the entry's shape; ids-only and unknown shapes give no hints. */
export function extractHints(entry: unknown): TextModelHints | undefined {
  if (!isObject(entry)) return undefined;
  if (Array.isArray(entry.supported_parameters)) return openRouterHints(entry);
  const caps = entry.capabilities;
  if (isObject(caps)) {
    if (['image_input', 'structured_outputs', 'thinking', 'effort'].some((k) => k in caps)) return anthropicHints(entry);
    if (typeof entry.key === 'string' || 'reasoning' in caps) return lmStudioHints(entry);
  }
  return modalityHints(entry);
}

/** Reads `data` (OpenAI, Anthropic, OpenRouter, llama.cpp, Mistral) or `models` (LM Studio native). */
export function parseModelList(body: unknown): ListedModel[] {
  const entries = isObject(body) ? (Array.isArray(body.data) ? body.data : body.models) : undefined;
  if (!Array.isArray(entries)) throw new TextListError('The server answered, but not with a model list.', null, 'invalid_body');
  const seen = new Set<string>();
  const models: ListedModel[] = [];
  for (const entry of entries as unknown[]) {
    if (!isObject(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id : entry.key;
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    const hints = extractHints(entry);
    models.push(hints === undefined ? { id, source: 'provider' } : { id, hints, source: 'provider' });
  }
  return models;
}

/** Redacts known token shapes and the provider's own credential. */
export function redactFor(credential: string | null, text: string): string {
  const scrubbed = credential === null || credential === '' ? text : text.split(credential).join('[redacted]');
  return redactSecrets(scrubbed);
}

/** A short, redacted excerpt of an upstream body for plain messages. */
export function bodyExcerpt(credential: string | null, body: string | undefined): string {
  // Redact before cutting: a key straddling the cut would otherwise leak a prefix.
  const flat = redactFor(credential, (body ?? '').replace(/\s+/g, ' ').trim());
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

/** True when `err` came from the fetch refusing a redirect. */
export function isRedirectRefusal(err: unknown): boolean {
  return err instanceof Error && /redirect/i.test(err.message);
}

function listRequest(provider: ResolvedProvider): { url: string; headers: Record<string, string> } {
  const key = provider.credential;
  if (provider.protocol === 'anthropic') {
    return {
      url: `${provider.baseUrl}/models?limit=1000`,
      headers: { 'anthropic-version': ANTHROPIC_VERSION, ...(key === null ? {} : { 'x-api-key': key }) },
    };
  }
  return { url: `${provider.baseUrl}/models`, headers: key === null ? {} : { authorization: `Bearer ${key}` } };
}

function failureMessage(status: number, credential: string | null, body: string): string {
  if (status === 401 || status === 403) return `The server refused the key (${status}). Check the API key.`;
  const excerpt = bodyExcerpt(credential, body);
  return `The model list answered ${status}${excerpt === '' ? '.' : `: '${excerpt}'`}`;
}

export async function listModels(
  provider: ResolvedProvider,
  signal: AbortSignal,
  timeoutMs = LIST_TIMEOUT_MS,
): Promise<ListModelsResult> {
  const { url, headers } = listRequest(provider);
  const timeout = AbortSignal.timeout(timeoutMs);
  const fetch = boundedFetch({ maxBytes: LIST_MAX_BYTES });
  let text: string;
  let status: number;
  try {
    const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.any([signal, timeout]) });
    status = response.status;
    text = await response.text();
  } catch (err) {
    if (signal.aborted) throw err;
    if (timeout.aborted) throw new TextListError(`The model list did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, null, 'timeout');
    if (err instanceof TextResponseTooLargeError) throw new TextListError('The model list is larger than 1 MiB.', null, 'too_large');
    if (isRedirectRefusal(err)) {
      throw new TextListError('The server answered with a redirect. Enter the address it redirects to instead.', null, 'redirect');
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new TextListError(`Could not reach the server: ${redactFor(provider.credential, detail)}`);
  }
  if (status === 404 || status === 405) return { models: [], listUnsupported: true };
  if (status < 200 || status > 299) throw new TextListError(failureMessage(status, provider.credential, text), status);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new TextListError('The server answered, but the model list is not JSON.', null, 'invalid_body');
  }
  return { models: parseModelList(body), listUnsupported: false };
}
