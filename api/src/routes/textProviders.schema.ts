import { z } from 'zod';
import {
  TEXT_LATENCY_PROFILES,
  TEXT_PROMPT_VARIANTS,
  TEXT_PROTOCOLS,
  TEXT_REASONING_EFFORT_VALUES,
  TEXT_STRUCTURED_OUTPUT_MODES,
  TEXT_TASKS,
  TEXT_TOKEN_FIELDS,
  validateTextProviderBaseUrl,
  type TextProviderConnectionTestRequest,
} from '@atelier/shared';
import type { AssertWire, MatchesWire } from '../validation/wireBinding';

// Admin text provider, model and routing bodies (spec § 10.2). Cross-field
// model rules (effort default in levels, image cap needs vision) live in the
// store, which owns them for every writer.

const rowId = z.string().min(1).max(64);

const providerName = z.string().min(1).max(60);

/** Shared URL rule (spec § 9.2); answers its plain message and yields the normalized form. */
const baseUrl = z.string().max(2048).transform((value, ctx) => {
  const result = validateTextProviderBaseUrl(value);
  if (!result.ok) {
    ctx.addIssue({ code: 'custom', message: result.message });
    return z.NEVER;
  }
  return result.normalized;
});

const apiKey = z.string().min(1).max(4096);
const upstreamModelId = z.string().min(1).max(200);
const effort = z.enum(TEXT_REASONING_EFFORT_VALUES);

export const TextProviderParam = z.object({ id: rowId });
export const TextModelParam = z.object({ id: rowId, mid: rowId });

export const TextProviderCreateBody = z.object({
  name: providerName,
  protocol: z.enum(TEXT_PROTOCOLS),
  baseUrl,
  preset: z.string().min(1).max(64).nullable().exactOptional(),
  apiKey: apiKey.exactOptional(),
  tokenField: z.enum(TEXT_TOKEN_FIELDS).exactOptional(),
  listModels: z.boolean().exactOptional(),
});

/** `apiKey` replaces the stored key; null removes it. */
export const TextProviderPatchBody = z.object({
  name: providerName.exactOptional(),
  protocol: z.enum(TEXT_PROTOCOLS).exactOptional(),
  baseUrl: baseUrl.exactOptional(),
  preset: z.string().min(1).max(64).nullable().exactOptional(),
  apiKey: apiKey.nullable().exactOptional(),
  tokenField: z.enum(TEXT_TOKEN_FIELDS).exactOptional(),
  listModels: z.boolean().exactOptional(),
  enabled: z.boolean().exactOptional(),
});

/** Unsaved draft; `probeModelId` is required when `listModels` is false (checked by the probe). */
export const TextProviderDraftTestBody = z.object({
  protocol: z.enum(TEXT_PROTOCOLS),
  baseUrl,
  apiKey: apiKey.exactOptional(),
  /** The field the provider will send output limits in; defaults to max_completion_tokens. */
  tokenField: z.enum(TEXT_TOKEN_FIELDS).exactOptional(),
  listModels: z.boolean().exactOptional(),
  probeModelId: upstreamModelId.exactOptional(),
});
type _DraftTestWire = AssertWire<MatchesWire<typeof TextProviderDraftTestBody, TextProviderConnectionTestRequest>>;

/** Saved provider test; `probeModelId` is needed only when listing is off or unsupported. */
export const TextProviderSavedTestBody = z.object({
  probeModelId: upstreamModelId.exactOptional(),
});

const hints = z.object({
  vision: z.boolean().exactOptional(),
  structuredOutput: z.enum(TEXT_STRUCTURED_OUTPUT_MODES).exactOptional(),
  reasoningLevels: z.array(effort).max(TEXT_REASONING_EFFORT_VALUES.length).exactOptional(),
  contextLength: z.number().int().positive().exactOptional(),
  maxOutputTokens: z.number().int().positive().exactOptional(),
});

export const TextModelsCreateBody = z.object({
  models: z.array(z.object({
    modelId: upstreamModelId,
    displayName: z.string().min(1).max(60).exactOptional(),
    /** List hints, used as the starting capability values. */
    hints: hints.exactOptional(),
  })).min(1).max(200),
});

export const TextModelPatchBody = z.object({
  displayName: z.string().min(1).max(60).exactOptional(),
  enabled: z.boolean().exactOptional(),
  screenRequests: z.boolean().exactOptional(),
  sortOrder: z.number().int().min(0).max(1_000_000).exactOptional(),
  vision: z.boolean().exactOptional(),
  maxImages: z.number().int().positive().max(1000).nullable().exactOptional(),
  structuredOutput: z.enum(TEXT_STRUCTURED_OUTPUT_MODES).exactOptional(),
  reasoningLevels: z.array(effort).max(TEXT_REASONING_EFFORT_VALUES.length).exactOptional(),
  reasoningDefault: effort.nullable().exactOptional(),
  temperature: z.number().min(0).max(2).nullable().exactOptional(),
  topP: z.number().min(0).max(1).nullable().exactOptional(),
  fixedOutputTokens: z.number().int().positive().max(1_000_000).nullable().exactOptional(),
  latencyProfile: z.enum(TEXT_LATENCY_PROFILES).exactOptional(),
  promptVariant: z.enum(TEXT_PROMPT_VARIANTS).exactOptional(),
});

export const TextRoutingScopeParam = z.object({
  scope: z.enum(['default', ...TEXT_TASKS]),
});

export const TextRoutingWriterParam = z.object({
  imageModelId: z.string().min(1).max(200),
});

/** null clears the assignment. */
export const TextRoutingDefaultBody = z.object({
  modelId: rowId.nullable(),
});

/** null clears the writer; `mode` defaults to 'prefer'. */
export const TextRoutingWriterBody = z.object({
  modelId: rowId.nullable(),
  mode: z.enum(['lock', 'prefer']).default('prefer'),
});
