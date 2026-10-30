import { APICallError, type JSONSchema7, type LanguageModelV4CallOptions, type LanguageModelV4Prompt } from '@ai-sdk/provider';
import type {
  ConnectionReport,
  TestReport,
  TextModelCapabilities,
  TextModelHints,
  TextProbeCheck,
  TextReasoningEffort,
  TextStructuredOutputMode,
} from '@atelier/shared';
import { z } from 'zod';
import { TextConfigValidationError, type TextModelRecord } from '../../db/textProviders';
import { boundedFetch, TextResponseTooLargeError } from './fetch';
import { bodyExcerpt, isRedirectRefusal, redactFor, TextListError } from './listModels';
import type { ConnectionProbeOptions, ResolvedProvider, TextProtocolAdapter } from './protocol';

// "Test connection" and "Test model" (spec § 6.5). Every call goes through the
// real adapter and the bounded fetch, one attempt each, bounded at 20 s and
// 64 KiB. Messages are plain English and redacted against the provider's
// credential.
//
// Check status: 'pass' = the check reached a verdict, including "capability
// absent" (image refused as unsupported, both JSON modes refused, effort
// refused); 'fail' = no verdict (error, timeout, unusable answer); 'skip' =
// not run. `proposed` holds only what a check proved; `advertised` holds list
// hints no check exercised.

export const CHECK_TIMEOUT_MS = 20_000;
export const CHECK_MAX_BYTES = 64 * 1024;
const CHECK_OUTPUT_TOKENS = 1024;

/** A 1×1 transparent PNG. */
const PIXEL_PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
));

const IMAGE_REFUSAL_RE = /image|vision|multimodal/i;

const PROBE_ANSWER = z.object({ answer: z.string() });
const PROBE_SCHEMA: JSONSchema7 = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

/** Anthropic levels assumed when its list gave none (spec § 6.5). */
const ANTHROPIC_DEFAULT_LEVELS: readonly TextReasoningEffort[] = ['low', 'medium', 'high'];

export interface ProbeLimits {
  /** Per-call timeout; tests shorten it. */
  readonly checkTimeoutMs?: number;
}

type Outcome =
  | { readonly kind: 'ok'; readonly text: string; readonly warnings: readonly string[] }
  | { readonly kind: 'http'; readonly status: number; readonly body: string }
  | { readonly kind: 'failed'; readonly message: string };

/** A model row for calls that only name an upstream id (the connection probe). */
function bareModel(providerId: string, modelId: string): TextModelRecord {
  return {
    id: `probe:${modelId}`,
    providerId,
    modelId,
    displayName: modelId,
    enabled: true,
    vision: false,
    maxImages: null,
    structuredOutput: 'none',
    reasoningLevels: [],
    reasoningDefault: null,
    temperature: null,
    topP: null,
    fixedOutputTokens: null,
    latencyProfile: 'standard',
    promptVariant: 'generic',
    screenRequests: false,
    sortOrder: 0,
    verifiedAt: null,
    lastTest: null,
    legacyKey: null,
  };
}

function warningText(warning: { type: string; feature?: string; details?: string; message?: string }): string {
  return warning.details ?? warning.message ?? `${warning.type}${warning.feature === undefined ? '' : `: ${warning.feature}`}`;
}

/** One bounded, unretried `doGenerate` through the adapter. Rethrows only the caller's abort. */
async function call(
  adapter: TextProtocolAdapter,
  provider: ResolvedProvider,
  model: TextModelRecord,
  options: Omit<LanguageModelV4CallOptions, 'abortSignal'>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Outcome> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const languageModel = adapter.languageModel(provider, model, boundedFetch({ maxBytes: CHECK_MAX_BYTES }));
  try {
    const result = await languageModel.doGenerate({ ...options, abortSignal: AbortSignal.any([signal, timeout]) });
    const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    return { kind: 'ok', text, warnings: result.warnings.map(warningText) };
  } catch (err) {
    if (signal.aborted) throw err;
    if (timeout.aborted) return { kind: 'failed', message: `The server did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
    if (APICallError.isInstance(err) && err.statusCode !== undefined) {
      return { kind: 'http', status: err.statusCode, body: err.responseBody ?? '' };
    }
    const cause = err instanceof Error ? err.cause : undefined;
    if (err instanceof TextResponseTooLargeError || cause instanceof TextResponseTooLargeError) {
      return { kind: 'failed', message: 'The answer was larger than 64 KiB.' };
    }
    if (isRedirectRefusal(err) || isRedirectRefusal(cause)) {
      return { kind: 'failed', message: 'The server answered with a redirect. Enter the address it redirects to instead.' };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: 'failed', message: `The call failed: ${redactFor(provider.credential, detail)}` };
  }
}

function answered(status: number, credential: string | null, body: string): string {
  const excerpt = bodyExcerpt(credential, body);
  return excerpt === '' ? `it answered ${status}` : `it answered ${status} '${excerpt}'`;
}

function failureMessage(outcome: Exclude<Outcome, { kind: 'ok' }>, credential: string | null, what: string): string {
  if (outcome.kind === 'failed') return outcome.message;
  if (outcome.status === 401 || outcome.status === 403) return `The server refused the key (${outcome.status}). Check the API key.`;
  return `The server refused ${what}: ${answered(outcome.status, credential, outcome.body)}.`;
}

type UserContent = Extract<LanguageModelV4Prompt[number], { role: 'user' }>['content'];

function plainPrompt(user: UserContent = [{ type: 'text', text: 'ping' }]): LanguageModelV4Prompt {
  return [
    { role: 'system', content: 'Reply with exactly: OK' },
    { role: 'user', content: user },
  ];
}

// ── Connection ────────────────────────────────────────────────────────────

async function completionCheck(
  adapter: TextProtocolAdapter,
  provider: ResolvedProvider,
  probeModelId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<TextProbeCheck> {
  const outcome = await call(
    adapter,
    provider,
    bareModel(provider.id, probeModelId),
    { prompt: plainPrompt(), maxOutputTokens: 1 },
    signal,
    timeoutMs,
  );
  if (outcome.kind === 'ok') {
    return { id: 'completion', status: 'pass', message: `The server answered a one-token request to '${probeModelId}'.` };
  }
  return { id: 'completion', status: 'fail', message: failureMessage(outcome, provider.credential, `the request to '${probeModelId}'`) };
}

/**
 * The adapters' `probeConnection`: the list call when listing is on; a
 * 1-token completion against `probeModelId` when listing is off, or as a
 * second check when the list endpoint does not exist.
 */
export async function runConnectionProbe(
  adapter: TextProtocolAdapter,
  provider: ResolvedProvider,
  signal: AbortSignal,
  options: ConnectionProbeOptions & ProbeLimits = {},
): Promise<ConnectionReport> {
  const probeModelId = options.probeModelId?.trim() ?? '';
  const timeoutMs = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  if (!provider.listModels) {
    if (probeModelId === '') {
      throw new TextConfigValidationError('Name a model to test with: model listing is off, so the test sends one short request to that model.');
    }
    const check = await completionCheck(adapter, provider, probeModelId, signal, timeoutMs);
    return { ok: check.status === 'pass', checks: [check] };
  }
  try {
    const { models, listUnsupported } = await adapter.listModels(provider, signal);
    if (!listUnsupported) {
      return {
        ok: true,
        checks: [{ id: 'list', status: 'pass', message: `The server answered and listed ${models.length} model${models.length === 1 ? '' : 's'}.` }],
        listedCount: models.length,
      };
    }
    const list: TextProbeCheck = {
      id: 'list',
      status: 'fail',
      message: 'The server has no model list at this address (404/405). If the address is right, turn off model listing and name a model to test with.',
    };
    if (probeModelId === '') return { ok: false, checks: [list], listUnsupported: true };
    const check = await completionCheck(adapter, provider, probeModelId, signal, timeoutMs);
    return { ok: check.status === 'pass', checks: [list, check], listUnsupported: true };
  } catch (err) {
    if (!(err instanceof TextListError)) throw err;
    return { ok: false, checks: [{ id: 'list', status: 'fail', message: err.message }] };
  }
}

// ── Test model ────────────────────────────────────────────────────────────

type Proposed = { -readonly [K in keyof TextModelCapabilities]?: TextModelCapabilities[K] };

/** The hints the provider's list gave for this model; empty when listing is off or fails. */
async function listHints(adapter: TextProtocolAdapter, provider: ResolvedProvider, modelId: string, signal: AbortSignal): Promise<TextModelHints> {
  if (!provider.listModels) return {};
  try {
    const { models } = await adapter.listModels(provider, signal);
    return models.find((m) => m.id === modelId)?.hints ?? {};
  } catch (err) {
    if (err instanceof TextListError) return {};
    throw err;
  }
}

/**
 * Runs the four checks of spec § 6.5 in order: plain reply, JSON output
 * (json_schema → json_object → none), image input, reasoning low/high.
 * A failing plain reply skips the rest.
 */
export async function testModel(
  adapter: TextProtocolAdapter,
  provider: ResolvedProvider,
  model: TextModelRecord,
  signal: AbortSignal,
  limits: ProbeLimits = {},
): Promise<TestReport> {
  const timeoutMs = limits.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  const credential = provider.credential;
  const maxOutputTokens = model.fixedOutputTokens ?? CHECK_OUTPUT_TOKENS;
  const checks: TextProbeCheck[] = [];
  const proposed: Proposed = {};
  const wireNotes = new Set<string>();
  const run = async (row: TextModelRecord, options: Omit<LanguageModelV4CallOptions, 'abortSignal' | 'maxOutputTokens'>): Promise<Outcome> => {
    const outcome = await call(adapter, provider, row, { ...options, maxOutputTokens }, signal, timeoutMs);
    if (outcome.kind === 'ok') for (const warning of outcome.warnings) wireNotes.add(redactFor(credential, warning));
    return outcome;
  };

  const hints = await listHints(adapter, provider, model.modelId, signal);

  // 1. Plain reply.
  const plain = await run(model, { prompt: plainPrompt() });
  if (plain.kind !== 'ok' || plain.text.trim() === '') {
    checks.push({
      id: 'plain',
      status: 'fail',
      message: plain.kind === 'ok' ? 'The server answered with an empty reply.' : failureMessage(plain, credential, 'a plain request'),
    });
    for (const id of ['json', 'image', 'reasoning']) {
      checks.push({ id, status: 'skip', message: 'Skipped because the plain reply failed.' });
    }
    return { checks, proposed, advertised: advertisedFrom(hints, proposed, []), wireNotes: [...wireNotes] };
  }
  checks.push({ id: 'plain', status: 'pass', message: 'The model replied.' });

  // 2. JSON output, strongest mode first; a 400 falls through to the next.
  checks.push(await jsonCheck(model, run, credential, proposed));

  // 3. Image input.
  checks.push(await imageCheck(model, run, credential, proposed));

  // 4. Reasoning effort: low, then high.
  const exercised: TextReasoningEffort[] = [];
  const reasoning = async (level: TextReasoningEffort): Promise<Outcome> => {
    exercised.push(level);
    const { providerOptions, wireNote } = adapter.reasoningOptions(level);
    if (wireNote !== null) wireNotes.add(wireNote);
    return run(model, { prompt: plainPrompt(), providerOptions });
  };
  const low = await reasoning('low');
  if (low.kind === 'http' && low.status === 400) {
    proposed.reasoningLevels = [];
    proposed.reasoningDefault = null;
    checks.push({
      id: 'reasoning',
      status: 'pass',
      message: `The server refused a reasoning effort: ${answered(low.status, credential, low.body)}. Reasoning levels turned off.`,
    });
  } else if (low.kind !== 'ok') {
    checks.push({ id: 'reasoning', status: 'fail', message: failureMessage(low, credential, "reasoning effort 'low'") });
  } else {
    const high = await reasoning('high');
    if (high.kind === 'ok') {
      proposed.reasoningLevels = ['low', 'high'];
      proposed.reasoningDefault = 'low';
      checks.push({ id: 'reasoning', status: 'pass', message: "The server accepted reasoning efforts 'low' and 'high'." });
    } else if (high.kind === 'http' && high.status === 400) {
      // Only a 400 says 'high' is absent; anything else is no verdict.
      proposed.reasoningLevels = ['low'];
      proposed.reasoningDefault = 'low';
      checks.push({
        id: 'reasoning',
        status: 'pass',
        message: `The server accepted 'low' but refused 'high': ${answered(high.status, credential, high.body)}.`,
      });
    } else {
      checks.push({ id: 'reasoning', status: 'fail', message: failureMessage(high, credential, "reasoning effort 'high'") });
    }
  }

  const listedLevels = hints.reasoningLevels ?? (adapter.protocol === 'anthropic' ? ANTHROPIC_DEFAULT_LEVELS : []);
  return {
    checks,
    proposed,
    advertised: advertisedFrom({ ...hints, reasoningLevels: listedLevels }, proposed, exercised),
    wireNotes: [...wireNotes],
  };
}

type Run = (row: TextModelRecord, options: Omit<LanguageModelV4CallOptions, 'abortSignal' | 'maxOutputTokens'>) => Promise<Outcome>;

const JSON_MODE_LABEL: Record<Exclude<TextStructuredOutputMode, 'none'>, string> = {
  json_schema: 'JSON schema output',
  json_object: 'JSON object output',
};

async function jsonCheck(model: TextModelRecord, run: Run, credential: string | null, proposed: Proposed): Promise<TextProbeCheck> {
  const refusals: string[] = [];
  for (const mode of ['json_schema', 'json_object'] as const) {
    const outcome = await run({ ...model, structuredOutput: mode }, {
      prompt: [
        { role: 'system', content: 'Reply with a JSON object whose "answer" field is "ok".' },
        { role: 'user', content: [{ type: 'text', text: 'ping' }] },
      ],
      responseFormat: { type: 'json', schema: PROBE_SCHEMA, name: 'probe' },
    });
    if (outcome.kind === 'http' && outcome.status === 400) {
      refusals.push(`${JSON_MODE_LABEL[mode]}: ${answered(outcome.status, credential, outcome.body)}`);
      continue;
    }
    if (outcome.kind !== 'ok') return { id: 'json', status: 'fail', message: failureMessage(outcome, credential, JSON_MODE_LABEL[mode]) };
    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.text);
    } catch {
      parsed = undefined;
    }
    if (!PROBE_ANSWER.safeParse(parsed).success) {
      return { id: 'json', status: 'fail', message: `The server accepted ${JSON_MODE_LABEL[mode]} but did not answer with the requested JSON.` };
    }
    proposed.structuredOutput = mode;
    const fallback = refusals.length === 0 ? '' : ` (it refused ${refusals.join('; ')})`;
    return { id: 'json', status: 'pass', message: `${JSON_MODE_LABEL[mode]} works${fallback}.` };
  }
  proposed.structuredOutput = 'none';
  return { id: 'json', status: 'pass', message: `The server refused both JSON modes (${refusals.join('; ')}). JSON output turned off.` };
}

async function imageCheck(model: TextModelRecord, run: Run, credential: string | null, proposed: Proposed): Promise<TextProbeCheck> {
  const outcome = await run({ ...model, vision: true, maxImages: null }, {
    prompt: plainPrompt([
      { type: 'text', text: 'Reply with the single word: seen' },
      { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PIXEL_PNG } },
    ]),
  });
  if (outcome.kind === 'ok') {
    proposed.vision = true;
    return { id: 'image', status: 'pass', message: 'The server accepted an image.' };
  }
  if (outcome.kind === 'http' && outcome.status >= 400 && outcome.status < 500 && IMAGE_REFUSAL_RE.test(outcome.body)) {
    proposed.vision = false;
    return {
      id: 'image',
      status: 'pass',
      message: `The server refused the image: ${answered(outcome.status, credential, outcome.body)}. Image input turned off.`,
    };
  }
  return { id: 'image', status: 'fail', message: `${failureMessage(outcome, credential, 'the image')} Image support is unknown.` };
}

/** List hints no check exercised: fields the probe left unproven, and levels it did not send. */
function advertisedFrom(hints: TextModelHints, proposed: Proposed, exercised: readonly TextReasoningEffort[]): Partial<TextModelCapabilities> {
  const advertised: Proposed = {};
  if (hints.vision !== undefined && proposed.vision === undefined) advertised.vision = hints.vision;
  if (hints.structuredOutput !== undefined && proposed.structuredOutput === undefined) advertised.structuredOutput = hints.structuredOutput;
  // Levels are only worth suggesting when the probe found reasoning at all (or never got to try).
  if (hints.reasoningLevels !== undefined && (proposed.reasoningLevels === undefined || proposed.reasoningLevels.length > 0)) {
    const unexercised = hints.reasoningLevels.filter((level) => !exercised.includes(level));
    if (unexercised.length > 0) advertised.reasoningLevels = unexercised;
  }
  return advertised;
}
