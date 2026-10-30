import type { TextReasoningEffort } from '@atelier/shared';

// Frozen copy of the legacy CLIProxyAPI text wire body: `buildChatBody` and
// the constants it read (`api/src/providers/cliproxyText.ts` and
// `cliproxyText.config.ts` at schema 57). The wire-compat tests compare the
// AI SDK adapter against it, so it must outlive the legacy code and must not
// be "fixed": it records what production sent. Only the backend type is local
// (the shared `AiFillBackend` goes away with the legacy surface).

export type LegacyBackend =
  | 'kimi'
  | 'mimo'
  | 'grok'
  | 'gemini-argon'
  | 'deepseek-abliterated'
  | 'glm-abliterated'
  | 'gpt';

// --- cliproxyText.config.ts -------------------------------------------------

export const KIMI_LOW_REASONING_OVERHEAD_TOKENS = 4000;
export const GROK_SAMPLING = { temperature: 0.7, top_p: 0.95 } as const;
export const GPT_REASONING_EFFORT = 'medium';
export const GLM_ABLITERATED_REASONING_EFFORT = 'low';
export const GLM_ABLITERATED_MAX_COMPLETION_TOKENS = 32_768;

export const CLIPROXY_TEXT_DEFAULTS = {
  reasoning_effort: 'low',
  verbosity: 'low',
  max_completion_tokens: 36_000,
} as const;

export const STORY_PLANNER_DEFAULTS = {
  reasoning_effort: 'low',
  verbosity: 'low',
  max_completion_tokens: 36_000,
} as const;

export const DRAFT_LIST_DEFAULTS = {
  reasoning_effort: 'low',
  verbosity: 'low',
  max_completion_tokens: 1200 + KIMI_LOW_REASONING_OVERHEAD_TOKENS,
} as const;

export const INFER_DIMENSIONS_DEFAULTS = {
  reasoning_effort: 'low',
  verbosity: 'low',
  max_completion_tokens: 32000 + KIMI_LOW_REASONING_OVERHEAD_TOKENS,
} as const;

export const DRAFT_TEMPLATE_DEFAULTS = {
  reasoning_effort: 'low',
  verbosity: 'low',
  max_completion_tokens: 1500 + KIMI_LOW_REASONING_OVERHEAD_TOKENS,
} as const;

export const TEXT_BACKEND_DEFAULT_REASONING_EFFORT = {
  kimi: null,
  mimo: 'none',
  grok: 'low',
  'gemini-argon': 'low',
  'deepseek-abliterated': 'none',
  'glm-abliterated': GLM_ABLITERATED_REASONING_EFFORT,
  gpt: GPT_REASONING_EFFORT,
} as const satisfies Record<LegacyBackend, TextReasoningEffort | null>;

export const AI_FILL_DEFAULTS = {
  reasoning_effort: 'low',
  verbosity: 'low',
  max_completion_tokens: 36_000,
} as const;

export const AI_FILL_BATCH_MAX_COMPLETION_TOKENS = 144_000;

const BRAINSTORM_TOKENS_PER_PROMPT = 600;
const BRAINSTORM_TOKENS_FLOOR = 2000;
const BRAINSTORM_TOKENS_CAP = 24000;

const BRAINSTORM_REASONING_OVERHEAD_TOKENS = {
  none: KIMI_LOW_REASONING_OVERHEAD_TOKENS,
  minimal: KIMI_LOW_REASONING_OVERHEAD_TOKENS,
  low: KIMI_LOW_REASONING_OVERHEAD_TOKENS,
  medium: 8_000,
  high: 16_000,
  xhigh: 24_000,
  max: 32_000,
} as const satisfies Record<TextReasoningEffort, number>;

function brainstormTokenBudget(count: number, effort: TextReasoningEffort): number {
  return Math.min(
    BRAINSTORM_TOKENS_CAP,
    Math.max(BRAINSTORM_TOKENS_FLOOR, count * BRAINSTORM_TOKENS_PER_PROMPT)
      + KIMI_LOW_REASONING_OVERHEAD_TOKENS,
  ) + BRAINSTORM_REASONING_OVERHEAD_TOKENS[effort] - KIMI_LOW_REASONING_OVERHEAD_TOKENS;
}

export function brainstormDefaults(count: number, effort: TextReasoningEffort = 'low'): {
  reasoning_effort: string;
  verbosity: string;
  max_completion_tokens: number;
} {
  return { reasoning_effort: effort, verbosity: 'low', max_completion_tokens: brainstormTokenBudget(count, effort) };
}

// --- cliproxyText.ts --------------------------------------------------------

export type ChatUserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatDefaults {
  reasoning_effort: string;
  verbosity: string;
  max_completion_tokens: number;
}

export type ChatResponseFormat =
  | 'json_object'
  | { readonly type: 'json_schema'; readonly json_schema: Readonly<Record<string, unknown>> };

export interface ChatStreamRequest {
  defaults: ChatDefaults;
  systemPrompt: string;
  userContent: string | readonly ChatUserContentPart[];
  responseFormat?: ChatResponseFormat;
  reasoningEffort?: TextReasoningEffort;
}

function responseFormatBody(format: ChatResponseFormat): Record<string, unknown> {
  return format === 'json_object' ? { type: 'json_object' } : { ...format };
}

type SharedChatBackend = 'kimi' | 'mimo' | 'grok' | 'gemini-argon' | 'deepseek-abliterated';

function sharedChatBackend(backend: LegacyBackend | undefined): SharedChatBackend | null {
  return backend === 'kimi'
    || backend === 'mimo'
    || backend === 'grok'
    || backend === 'gemini-argon'
    || backend === 'deepseek-abliterated'
    ? backend
    : null;
}

/** `buildChatBody` exactly as production sent it before the AI SDK adapter. */
export function legacyChatBody(
  model: string,
  backend: LegacyBackend | undefined,
  req: ChatStreamRequest,
  stream = true,
): Record<string, unknown> {
  const messages = [
    { role: 'system', content: req.systemPrompt },
    { role: 'user', content: req.userContent },
  ];
  const sharedBackend = sharedChatBackend(backend);
  if (sharedBackend !== null) {
    const backendDefaultEffort = TEXT_BACKEND_DEFAULT_REASONING_EFFORT[sharedBackend];
    return {
      model,
      stream,
      reasoning_effort: req.reasoningEffort ?? backendDefaultEffort ?? req.defaults.reasoning_effort,
      max_completion_tokens: req.defaults.max_completion_tokens,
      ...(sharedBackend === 'grok' ? GROK_SAMPLING : {}),
      ...(req.responseFormat ? { response_format: responseFormatBody(req.responseFormat) } : {}),
      messages,
    };
  }
  if (backend === 'glm-abliterated') {
    return {
      model,
      stream,
      reasoning_effort: req.reasoningEffort ?? GLM_ABLITERATED_REASONING_EFFORT,
      max_completion_tokens: GLM_ABLITERATED_MAX_COMPLETION_TOKENS,
      messages,
    };
  }
  if (backend === 'gpt') {
    return {
      model,
      stream,
      reasoning_effort: GPT_REASONING_EFFORT,
      max_completion_tokens: req.defaults.max_completion_tokens,
      ...(req.responseFormat ? { response_format: responseFormatBody(req.responseFormat) } : {}),
      messages,
    };
  }
  return {
    model,
    stream,
    reasoning_effort: req.reasoningEffort ?? req.defaults.reasoning_effort,
    verbosity: req.defaults.verbosity,
    max_completion_tokens: req.defaults.max_completion_tokens,
    ...(req.responseFormat ? { response_format: responseFormatBody(req.responseFormat) } : {}),
    messages,
  };
}
