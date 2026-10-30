import type { Database } from 'bun:sqlite';
import type { ModelAvailability } from '@atelier/shared';
import type { Config } from './config';
import type { KeyStore } from './keystore';
import type { AppLogger } from './observability/logger';
import type { TextServices } from './routing/textServices';

export type HealthSnapshot = () => ReadonlyMap<string, ModelAvailability>;
export type ProbeModelNow = (modelId: string) => Promise<ModelAvailability | undefined>;

// Base bindings present on every request, including pre-auth routes
// (`/api/health` is mounted before the authelia middleware). `userId` is
// only available AFTER auth runs — typing it on `AppBindings` would lie:
// a future public route added before the auth middleware would compile
// against `c.var.userId: string` and crash at runtime with `undefined`.
// The split forces post-auth routes to use `AppEnv` (which carries the
// non-optional `userId`) and pre-auth routes to use `BaseEnv` (which
// doesn't expose `userId` at the type level at all).
export interface BaseBindings {
  config: Config;
  db: Database;
  logger: AppLogger;
  rootLogger: AppLogger;
}

export interface AppBindings extends BaseBindings {
  userId: string;
  keyStore: KeyStore | undefined;
  healthSnapshot: HealthSnapshot;
  probeModelNow: ProbeModelNow;
  /** Text-model store, routing snapshot, availability and resolver (one per process). */
  text: TextServices;
}

export interface BaseEnv {
  Variables: BaseBindings;
}

export interface AppEnv {
  Variables: AppBindings;
}
