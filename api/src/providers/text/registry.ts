import type { TextLatencyProfile, TextProtocol } from '@atelier/shared';
import type { Config } from '../../config';
import { currentTextConfigRevision, type TextProviderStore } from '../../db/textProviders';
import { loggerForConfig } from '../../observability/logger';
import { textCallPolicies, type TestTextFeatureProvider } from './featureHelpers';
import { textMaxResponseBytes } from './textBudgets';
import { anthropicAdapter } from './anthropic';
import { openaiCompatibleAdapter } from './openaiCompatible';
import type { TextProtocolAdapter } from './protocol';
import { createTextModelProvider, type TextModelProvider } from './textModel';

// One feature provider per model row (spec § 5.5), cached against the text
// config revision: every admin write bumps it, so a hit with a stale revision
// rebuilds. Policies and breakers live with the cached entry, so an edit
// resets that model's breakers. User picks never bump the revision.

const ADAPTERS: Readonly<Record<TextProtocol, TextProtocolAdapter>> = {
  'openai-compatible': openaiCompatibleAdapter,
  anthropic: anthropicAdapter,
};

/** The wire adapter for a provider's protocol. */
export function textAdapterFor(protocol: TextProtocol): TextProtocolAdapter {
  return ADAPTERS[protocol];
}

/** Unknown model row, or one whose provider row is gone. */
export class TextModelNotFoundError extends Error {
  override readonly name = 'TextModelNotFoundError';
  constructor(readonly modelRowId: string) {
    super(`text model ${modelRowId} is not configured`);
  }
}

interface Generation {
  readonly store: TextProviderStore;
  readonly revision: number;
  readonly byModel: Map<string, TextModelProvider>;
}

// Keyed by the frozen Config (tests build several). A new revision or store
// starts a new generation, which also drops providers of deleted rows.
const cache = new WeakMap<Config, Generation>();
let testProvider: TextModelProvider | null = null;

/**
 * Test fakes may omit `inferTaxonomy`, `brainstormCharacters` and `aiFill`;
 * the setter back-fills them, so `inferTaxonomy` stays required on the
 * interface. The override wins over every model row; null clears it.
 */
export function setTextModelProviderForTests(p: TestTextFeatureProvider | null): void {
  testProvider = p === null
    ? null
    : {
        ...p,
        aiFill: p.aiFill ?? (() => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'not implemented' })),
        inferTaxonomy: p.inferTaxonomy ?? p.inferDimensions,
        brainstormCharacters: p.brainstormCharacters ?? (async function* () {
          await Promise.resolve();
          yield { type: 'failed', status: null, detail: 'not implemented' };
        }),
      };
}

function build(config: Config, store: TextProviderStore, modelRowId: string): TextModelProvider {
  const model = store.getModel(modelRowId);
  const provider = model === null ? null : store.getProvider(model.providerId);
  if (model === null || provider === null) throw new TextModelNotFoundError(modelRowId);
  const profile: TextLatencyProfile = model.latencyProfile;
  return createTextModelProvider({
    adapter: textAdapterFor(provider.protocol),
    provider,
    credential: async () => (await store.resolveCredential(provider)) ?? null,
    model,
    maxResponseBytes: textMaxResponseBytes(profile, config.TEXT_MAX_RESPONSE_BYTES),
    inferMaxResponseBytes: config.TEXT_INFER_MAX_RESPONSE_BYTES,
    brainstormMaxResponseBytes: textMaxResponseBytes(profile, config.BRAINSTORM_MAX_RESPONSE_BYTES),
    quotaMinRetryAfterMs: config.QUOTA_MIN_RETRY_AFTER_MS,
    enhanceOpenTimeoutMs: config.ENHANCE_OPEN_TIMEOUT_MS,
    brainstormOpenTimeoutMs: config.BRAINSTORM_OPEN_TIMEOUT_MS,
    moderation: { openrouterApiKey: config.OPENROUTER_API_KEY },
    logger: loggerForConfig(config),
    ...textCallPolicies(config, profile),
  });
}

/** The feature provider for one model row; the test override wins. */
export function textModelProviderFor(config: Config, store: TextProviderStore, modelRowId: string): TextModelProvider {
  if (testProvider) return testProvider;
  const revision = currentTextConfigRevision();
  let generation = cache.get(config);
  if (generation?.revision !== revision || generation.store !== store) {
    generation = { store, revision, byModel: new Map() };
    cache.set(config, generation);
  }
  const cached = generation.byModel.get(modelRowId);
  if (cached) return cached;
  const provider = build(config, store, modelRowId);
  generation.byModel.set(modelRowId, provider);
  return provider;
}
