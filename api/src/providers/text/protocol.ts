import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { ConnectionReport, ListedModel, TextProtocol } from '@atelier/shared';
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
  /** GET list endpoint → ids + capability hints; bounded, redirect-rejecting. */
  listModels(provider: ResolvedProvider, signal: AbortSignal): Promise<ListedModel[]>;
  /** Cheap connection check used by "Test connection". */
  probeConnection(provider: ResolvedProvider, signal: AbortSignal): Promise<ConnectionReport>;
}
