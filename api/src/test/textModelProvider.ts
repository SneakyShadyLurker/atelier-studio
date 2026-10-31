import { LEGACY_SEED, type LegacyTextKey } from '../db/textSeed';
import type { TextModelRecord, TextProviderRecord } from '../db/textProviders';
import type { TextCallPolicies } from '../providers/text/featureHelpers';
import { textAdapterFor } from '../providers/text/registry';
import { createTextModelProvider, type TextModelProvider, type TextModelProviderInit } from '../providers/text/textModel';
import type { ProviderLogger } from '../providers/types';
import { testTextPolicies } from './textPolicies';

// Fixtures for the text feature provider: provider + model rows as the
// migration seeds them (spec § 11.1), pointed at a test upstream.

/** A migrated model row, optionally with a different upstream id or settings. */
export function seededTextModel(key: LegacyTextKey, overrides: Partial<TextModelRecord> = {}): TextModelRecord {
  const index = LEGACY_SEED.models.findIndex((m) => m.legacyKey === key);
  const seed = LEGACY_SEED.models[index];
  if (seed === undefined) throw new Error(`no seed for ${key}`);
  return {
    ...seed.capabilities,
    id: `model-${key}`,
    providerId: 'prov-test',
    modelId: seed.defaultModelId,
    displayName: seed.displayName,
    enabled: true,
    screenRequests: seed.screenRequests,
    sortOrder: index,
    verifiedAt: null,
    lastTest: null,
    legacyKey: key,
    ...overrides,
  };
}

/** An admin-added OpenAI-compatible model with no legacy key: no levels, `low` sent by default. */
export function genericTextModel(modelId = 'm', overrides: Partial<TextModelRecord> = {}): TextModelRecord {
  return {
    id: `model-${modelId}`,
    providerId: 'prov-test',
    modelId,
    displayName: modelId,
    enabled: true,
    vision: true,
    maxImages: null,
    structuredOutput: 'json_schema',
    reasoningLevels: [],
    reasoningDefault: 'low',
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
    ...overrides,
  };
}

/** The seeded CLIProxyAPI provider row at `origin` (a bare origin; `/v1` is appended). */
export function testTextProviderRow(origin: string, overrides: Partial<TextProviderRecord> = {}): TextProviderRecord {
  return {
    id: 'prov-test',
    name: LEGACY_SEED.provider.name,
    protocol: LEGACY_SEED.provider.protocol,
    baseUrl: `${origin.replace(/\/+$/, '')}${LEGACY_SEED.provider.basePath}`,
    preset: LEGACY_SEED.provider.preset,
    auth: 'env',
    envVar: LEGACY_SEED.provider.credentialEnv,
    tokenField: LEGACY_SEED.provider.tokenField,
    listModels: true,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export interface TestTextModelProviderOptions extends Partial<TextCallPolicies> {
  /** Bare origin of the upstream, e.g. a Bun.serve URL or 'http://x' with a faked fetch. */
  readonly origin: string;
  readonly token?: string | null;
  /** Replaces `token` with a resolver (e.g. one that fails). */
  readonly credential?: TextModelProviderInit['credential'];
  readonly model?: TextModelRecord;
  readonly provider?: Partial<TextProviderRecord>;
  readonly maxResponseBytes?: number;
  readonly inferMaxResponseBytes?: number;
  readonly brainstormMaxResponseBytes?: number;
  readonly quotaMinRetryAfterMs?: number;
  readonly enhanceOpenTimeoutMs?: number;
  readonly brainstormOpenTimeoutMs?: number;
  readonly moderation?: TextModelProviderInit['moderation'];
  readonly logger?: ProviderLogger;
}

/** A feature provider with the production policies at millisecond backoff; any policy can be replaced. */
export function testTextModelProvider(opts: TestTextModelProviderOptions): TextModelProvider {
  const {
    origin, token, credential, model, provider: providerOverrides, maxResponseBytes,
    inferMaxResponseBytes, brainstormMaxResponseBytes, quotaMinRetryAfterMs,
    enhanceOpenTimeoutMs, brainstormOpenTimeoutMs, moderation, logger, ...policies
  } = opts;
  const provider = testTextProviderRow(origin, providerOverrides);
  return createTextModelProvider({
    ...testTextPolicies(policies),
    adapter: textAdapterFor(provider.protocol),
    provider,
    credential: credential ?? (() => Promise.resolve(token === undefined ? 'sk-test' : token)),
    model: model ?? genericTextModel(),
    maxResponseBytes: maxResponseBytes ?? 1_000_000,
    ...(inferMaxResponseBytes === undefined ? {} : { inferMaxResponseBytes }),
    ...(brainstormMaxResponseBytes === undefined ? {} : { brainstormMaxResponseBytes }),
    ...(quotaMinRetryAfterMs === undefined ? {} : { quotaMinRetryAfterMs }),
    ...(enhanceOpenTimeoutMs === undefined ? {} : { enhanceOpenTimeoutMs }),
    ...(brainstormOpenTimeoutMs === undefined ? {} : { brainstormOpenTimeoutMs }),
    ...(moderation === undefined ? {} : { moderation }),
    ...(logger === undefined ? {} : { logger }),
  });
}
