import type { LanguageModelV4, SharedV4ProviderOptions } from '@ai-sdk/provider';
import type { ConnectionReport, ListedModel, TextProtocol, TextReasoningEffort } from '@atelier/shared';
import type { TextModelRecord, TextProviderRecord } from '../../db/textProviders';

// One adapter per wire protocol. The AI SDK provider packages shape the wire;
// adapters only pick the package and its settings for a stored row. The
// installed packages implement provider spec v4 (`LanguageModelV4`), not the
// v3 the spec text names; see the header of openaiCompatible.ts.

/** A stored provider plus its plaintext credential, resolved at use time. */
export interface ResolvedProvider extends TextProviderRecord {
  /** Decrypted stored key or the env value; null when auth is 'none'. Never cached beyond the adapter instance. */
  readonly credential: string | null;
}

export interface TextProtocolAdapter {
  readonly protocol: TextProtocol;
  /**
   * Builds the language model for one model row; cached by the registry.
   * `fetch` is the bounded, redirect-rejecting fetch (`boundedFetch`) sized for
   * the row's latency profile.
   */
  languageModel(provider: ResolvedProvider, model: TextModelRecord, fetch: typeof globalThis.fetch): LanguageModelV4;
  /**
   * Call-time provider options for one reasoning level (null = none sent).
   * `wireNote` explains a level the protocol cannot express and left out.
   */
  reasoningOptions(level: TextReasoningEffort | null): ReasoningOptions;
  /**
   * GET list endpoint → ids + capability hints; bounded, redirect-rejecting,
   * no retry. A 404/405 answers `{ models: [], listUnsupported: true }`.
   */
  listModels(provider: ResolvedProvider, signal: AbortSignal): Promise<ListModelsResult>;
  /**
   * Cheap connection check used by "Test connection": the list endpoint, or,
   * with listing off, a 1-token completion against `probeModelId` (required
   * then; missing → TextConfigValidationError).
   */
  probeConnection(provider: ResolvedProvider, signal: AbortSignal, options?: ConnectionProbeOptions): Promise<ConnectionReport>;
}

export interface ReasoningOptions {
  readonly providerOptions: SharedV4ProviderOptions;
  readonly wireNote: string | null;
}

export interface ListModelsResult {
  readonly models: readonly ListedModel[];
  /** The provider has no list endpoint (404/405); the UI switches to manual entry. */
  readonly listUnsupported: boolean;
}

export interface ConnectionProbeOptions {
  /** Upstream model id for the 1-token completion when the list is off or unsupported. */
  readonly probeModelId?: string;
}
