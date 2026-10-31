import {
  currentTextConfigRevision,
  type TextDefaults,
  type TextModelRecord,
  type TextProviderRecord,
  type TextProviderStore,
  type TextWriterAssignment,
} from '../db/textProviders';

// In-memory view of the admin text config the resolver routes over (spec § 7):
// enabled providers, their enabled models, task assignments and prompt
// writers. Rebuilt from the store when the text config revision changes, so a
// resolve reads no config from the DB. Availability is never copied in: the
// resolver reads it live from the poller.

export interface TextConfig {
  readonly revision: number;
  /** Enabled providers by row id. */
  readonly providers: ReadonlyMap<string, TextProviderRecord>;
  /** Enabled models of enabled providers by row id. */
  readonly models: ReadonlyMap<string, TextModelRecord>;
  readonly defaults: TextDefaults;
  /** Image model id → writer. May name a model absent from `models` (disabled). */
  readonly writers: Readonly<Record<string, TextWriterAssignment>>;
}

export interface TextConfigSnapshot {
  /** The config at the current revision; the same object until the next admin write. */
  current(): TextConfig;
}

type SnapshotSource = Pick<TextProviderStore, 'listProviders' | 'listModels' | 'readDefaults' | 'readWriters'>;

function buildTextConfig(store: SnapshotSource, revision: number): TextConfig {
  const providers = new Map(
    store
      .listProviders()
      .filter((provider) => provider.enabled)
      .map((provider) => [provider.id, provider] as const),
  );
  const models = new Map(
    store
      .listModels()
      .filter((model) => model.enabled && providers.has(model.providerId))
      .map((model) => [model.id, model] as const),
  );
  return { revision, providers, models, defaults: store.readDefaults(), writers: store.readWriters() };
}

export function createTextConfigSnapshot(store: SnapshotSource): TextConfigSnapshot {
  let cached: TextConfig | null = null;
  return {
    current() {
      const revision = currentTextConfigRevision();
      if (cached?.revision !== revision) cached = buildTextConfig(store, revision);
      return cached;
    },
  };
}
