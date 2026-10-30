import type { Database } from 'bun:sqlite';
import type { Config } from '../config';
import { createTextProviderStore, type TextProviderStore } from '../db/textProviders';
import { createTextSecretsForKey } from '../keystore/instanceSecrets';
import type { TextAvailabilityHandle } from '../lifecycle/text-availability';
import { createTextConfigSnapshot, type TextConfigSnapshot } from './textConfigSnapshot';
import { resolveTextModel, type ResolveTextModelInput, type ResolvedTextModel } from './textModelResolver';

// The per-process text-model services routes read from `c.var.text`: one
// store, one routing snapshot, the live availability handle and a resolver
// bound to all three. Boot starts the availability poller; createApp falls
// back to "unknown" availability (fail-open) when none is passed.

export interface TextServices {
  readonly store: TextProviderStore;
  readonly snapshot: TextConfigSnapshot;
  readonly availability: TextAvailabilityHandle;
  resolve(input: ResolveTextModelInput): ResolvedTextModel;
}

/** Availability with no pollers: every model is 'unknown', which routing treats as available. */
export const UNKNOWN_TEXT_AVAILABILITY: TextAvailabilityHandle = {
  statusOf: () => 'unknown',
  snapshot: () => null,
  refresh: () => Promise.resolve(),
  reconcile: () => undefined,
  stop: () => undefined,
  drain: () => Promise.resolve(),
};

export function textProviderStoreFor(config: Pick<Config, 'BYOK_ENCRYPTION_KEY'>, db: Database): TextProviderStore {
  const secrets = createTextSecretsForKey(config.BYOK_ENCRYPTION_KEY);
  return createTextProviderStore({ db, ...(secrets ? { secrets } : {}) });
}

export function createTextServices(deps: {
  readonly store: TextProviderStore;
  readonly availability: TextAvailabilityHandle;
}): TextServices {
  const { store, availability } = deps;
  const snapshot = createTextConfigSnapshot(store);
  return {
    store,
    snapshot,
    availability,
    resolve: (input) => resolveTextModel({ snapshot, availability, store }, input),
  };
}
