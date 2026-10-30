import type { TextModelCapabilities } from '@atelier/shared';
import type { Config } from '../config';
import { classifyImageModelTarget } from '../prompts/gptImagePhrasing';
import { isSunburstModel } from '../prompts/gptSystemPrompt';

// Frozen record of the seven fixed CLIProxyAPI text backends as they stood at
// schema 57. Migration 58 seeds them as admin-managed models on upgraded
// installs, and the wire-compat tests compare the new adapter against them.
// The values are literals on purpose: the legacy constants they were read from
// (the legacy text config, `buildChatBody`, `TEXT_BACKEND_*` in shared) are
// gone, and this record must outlive them.

/** One of the seven fixed backend keys a migrated model row remembers. */
export type LegacyTextKey =
  | 'kimi'
  | 'mimo'
  | 'grok'
  | 'gemini-argon'
  | 'deepseek-abliterated'
  | 'glm-abliterated'
  | 'gpt';

export interface LegacySeedModel {
  readonly legacyKey: LegacyTextKey;
  readonly displayName: string;
  /** Upstream id the legacy `CLIPROXY_TEXT_MODEL_*` default named. */
  readonly defaultModelId: string;
  /** Legacy env var whose value is the upstream id. */
  readonly modelIdEnv: `CLIPROXY_TEXT_MODEL_${string}`;
  readonly capabilities: TextModelCapabilities;
  /** JEV pre-screen before every request (the GPT moderation gate). */
  readonly screenRequests: boolean;
}

export interface LegacySeedProvider {
  readonly name: string;
  readonly protocol: 'openai-compatible';
  /** Appended to `CLIPROXY_BASE_URL` (a bare origin). */
  readonly basePath: '/v1';
  readonly preset: 'cliproxy-seed';
  readonly authMode: 'env';
  readonly credentialEnv: 'CLIPROXY_TOKEN';
  readonly tokenField: 'max_completion_tokens';
  readonly listModels: boolean;
}

export interface LegacySeed {
  readonly provider: LegacySeedProvider;
  /** In legacy display order; `sort_order` is the index. */
  readonly models: readonly LegacySeedModel[];
  /** Fallback model for every task (`text_defaults('default')`). */
  readonly defaultKey: LegacyTextKey;
  /** Writes for GPT-family image models: `lock` on Sunburst, `prefer` on the rest. */
  readonly imageWriterKey: LegacyTextKey;
}

const standard = {
  maxImages: null,
  temperature: null,
  topP: null,
  fixedOutputTokens: null,
  latencyProfile: 'standard',
  promptVariant: 'generic',
} as const;

export const LEGACY_SEED: LegacySeed = {
  provider: {
    name: 'CLIProxyAPI',
    protocol: 'openai-compatible',
    basePath: '/v1',
    preset: 'cliproxy-seed',
    authMode: 'env',
    credentialEnv: 'CLIPROXY_TOKEN',
    tokenField: 'max_completion_tokens',
    listModels: true,
  },
  models: [
    {
      legacyKey: 'kimi',
      displayName: 'Kimi K3',
      defaultModelId: 'kimi-latest',
      modelIdEnv: 'CLIPROXY_TEXT_MODEL_KIMI',
      // Kimi took the per-path default effort, 'low' on every path.
      capabilities: {
        ...standard,
        vision: true,
        structuredOutput: 'json_schema',
        reasoningLevels: ['low', 'high', 'max'],
        reasoningDefault: 'low',
        promptVariant: 'kimi',
      },
      screenRequests: false,
    },
    {
      legacyKey: 'mimo',
      displayName: 'MiMo V2.6 Pro',
      defaultModelId: 'mimo-v2.6-pro',
      modelIdEnv: 'CLIPROXY_TEXT_MODEL_MIMO',
      capabilities: {
        ...standard,
        vision: true,
        structuredOutput: 'json_schema',
        reasoningLevels: ['none', 'high'],
        reasoningDefault: 'none',
      },
      screenRequests: false,
    },
    {
      legacyKey: 'grok',
      displayName: 'Grok 4.7',
      defaultModelId: 'grok-latest',
      modelIdEnv: 'CLIPROXY_TEXT_MODEL_GROK',
      capabilities: {
        ...standard,
        vision: true,
        structuredOutput: 'json_schema',
        reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
        reasoningDefault: 'low',
        temperature: 0.7,
        topP: 0.95,
      },
      screenRequests: false,
    },
    {
      legacyKey: 'gemini-argon',
      displayName: 'Gemini 4 Argon',
      defaultModelId: 'gemini-4-argon',
      modelIdEnv: 'CLIPROXY_TEXT_MODEL_GEMINI_ARGON',
      capabilities: {
        ...standard,
        vision: true,
        structuredOutput: 'json_schema',
        reasoningLevels: ['low', 'medium', 'high'],
        reasoningDefault: 'low',
      },
      screenRequests: false,
    },
    {
      legacyKey: 'deepseek-abliterated',
      displayName: 'DeepSeek V4.1 Flash Abliterated',
      defaultModelId: 'abliterated-model-large-flash',
      modelIdEnv: 'CLIPROXY_TEXT_MODEL_DEEPSEEK_ABLITERATED',
      capabilities: {
        ...standard,
        vision: false,
        structuredOutput: 'json_schema',
        reasoningLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        reasoningDefault: 'none',
      },
      screenRequests: false,
    },
    {
      legacyKey: 'glm-abliterated',
      displayName: 'GLM 5.3',
      defaultModelId: 'glm-5.3',
      modelIdEnv: 'CLIPROXY_TEXT_MODEL_GLM_ABLITERATED',
      // Never sent response_format; one fixed output budget; long deadlines.
      capabilities: {
        ...standard,
        vision: false,
        structuredOutput: 'none',
        reasoningLevels: ['low', 'high', 'max'],
        reasoningDefault: 'low',
        fixedOutputTokens: 32_768,
        latencyProfile: 'slow',
      },
      screenRequests: false,
    },
    {
      legacyKey: 'gpt',
      displayName: 'GPT-6.1 Sol',
      defaultModelId: 'gpt-6.1-sol',
      modelIdEnv: 'CLIPROXY_TEXT_MODEL_GPT',
      // Fixed effort: users cannot pick one, 'medium' is always sent.
      capabilities: {
        ...standard,
        vision: true,
        structuredOutput: 'json_schema',
        reasoningLevels: [],
        reasoningDefault: 'medium',
      },
      screenRequests: true,
    },
  ],
  defaultKey: 'kimi',
  imageWriterKey: 'gpt',
};

/** What boot hands migration 58 so it can seed the legacy provider. */
export interface TextSeed {
  /** `CLIPROXY_BASE_URL`, a bare origin; the seed appends `/v1`. */
  readonly baseUrl: string;
  /** Upstream id per legacy key, from `CLIPROXY_TEXT_MODEL_*`. */
  readonly modelIds: Readonly<Record<LegacyTextKey, string>>;
  /** Registered Sunburst image models: GPT writes for them, `lock`. */
  readonly sunburstImageModelIds: readonly string[];
  /** Other registered GPT-family image models: GPT writes for them, `prefer`. */
  readonly gptImageModelIds: readonly string[];
}

type TextSeedConfig = Pick<
  Config,
  | 'CLIPROXY_BASE_URL'
  | 'CLIPROXY_TEXT_MODEL_KIMI'
  | 'CLIPROXY_TEXT_MODEL_MIMO'
  | 'CLIPROXY_TEXT_MODEL_GROK'
  | 'CLIPROXY_TEXT_MODEL_GEMINI_ARGON'
  | 'CLIPROXY_TEXT_MODEL_DEEPSEEK_ABLITERATED'
  | 'CLIPROXY_TEXT_MODEL_GLM_ABLITERATED'
  | 'CLIPROXY_TEXT_MODEL_GPT'
>;

/**
 * The seed boot offers migration 58, or undefined without `CLIPROXY_BASE_URL`.
 * migrate() applies it only to a database that existed before this boot.
 */
export function legacyTextSeed(
  config: TextSeedConfig,
  imageModelIds: readonly string[],
): TextSeed | undefined {
  const baseUrl = config.CLIPROXY_BASE_URL;
  if (baseUrl === undefined) return undefined;
  const gptFamily = imageModelIds.filter((id) => classifyImageModelTarget(id) === 'gpt');
  return {
    baseUrl,
    modelIds: {
      kimi: config.CLIPROXY_TEXT_MODEL_KIMI,
      mimo: config.CLIPROXY_TEXT_MODEL_MIMO,
      grok: config.CLIPROXY_TEXT_MODEL_GROK,
      'gemini-argon': config.CLIPROXY_TEXT_MODEL_GEMINI_ARGON,
      'deepseek-abliterated': config.CLIPROXY_TEXT_MODEL_DEEPSEEK_ABLITERATED,
      'glm-abliterated': config.CLIPROXY_TEXT_MODEL_GLM_ABLITERATED,
      gpt: config.CLIPROXY_TEXT_MODEL_GPT,
    },
    sunburstImageModelIds: imageModelIds.filter((id) => isSunburstModel(id)),
    gptImageModelIds: gptFamily.filter((id) => !isSunburstModel(id)),
  };
}

/** Legacy `CLIPROXY_TEXT_MODEL_*` variables set in `env` (no longer read after 58). */
export function legacyTextModelEnvVars(env: Readonly<Record<string, string | undefined>>): string[] {
  return LEGACY_SEED.models
    .map((model) => model.modelIdEnv)
    .filter((name) => (env[name] ?? '') !== '');
}

// Migration 58 is the only reader of `CLIPROXY_TEXT_MODEL_*`.
const LEGACY_SEED_SCHEMA_VERSION = 58;

/**
 * Legacy `CLIPROXY_TEXT_MODEL_*` variables set in `env` that did nothing on
 * this boot: everything set, except on the upgrade boot that crossed migration
 * 58 with a seed offered (that boot's seed read them). Boot warns about these.
 */
export function staleLegacyTextModelEnvVars(
  env: Readonly<Record<string, string | undefined>>,
  boot: { readonly startVersion: number; readonly seedOffered: boolean },
): string[] {
  const seededNow = boot.seedOffered && boot.startVersion > 0 && boot.startVersion < LEGACY_SEED_SCHEMA_VERSION;
  return seededNow ? [] : legacyTextModelEnvVars(env);
}
