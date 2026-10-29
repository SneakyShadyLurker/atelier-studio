import type { AiFillBackend } from '@atelier/shared';
import { AI_FILL_BACKEND_VALUES } from '@atelier/shared';

/** The slice of the CLIProxy model-inventory poller this module reads. */
export interface TextModelInventorySource {
  snapshot(): ReadonlySet<string> | null;
}

const UNKNOWN_INVENTORY: TextModelInventorySource = { snapshot: () => null };
let source: TextModelInventorySource = UNKNOWN_INVENTORY;
// Backend → configured CLIProxy model id (`textBackendModels`). Irrelevant
// while the inventory is unknown, so it starts empty.
let backendModels: Readonly<Partial<Record<AiFillBackend, string>>> = {};

/**
 * `createApp` owns this, passing `textBackendModels(config)`; an absent source
 * fails open (nothing unavailable).
 */
export function configureTextBackendAvailability(
  next: TextModelInventorySource | undefined,
  models: Readonly<Record<AiFillBackend, string>>,
): void {
  source = next ?? UNKNOWN_INVENTORY;
  backendModels = models;
}

export function resetTextBackendAvailabilityForTests(): void {
  source = UNKNOWN_INVENTORY;
  backendModels = {};
}

function isServed(models: ReadonlySet<string>, backend: AiFillBackend): boolean {
  const model = backendModels[backend];
  return model !== undefined && models.has(model);
}

/**
 * Backends whose routed CLIProxy model id is missing from the proxy's live
 * `/v1/models` inventory. An unknown inventory (no successful fetch yet, or no
 * poller) marks nothing unavailable: unknown is not unavailable.
 */
export function unavailableTextBackends(): readonly AiFillBackend[] {
  const models = source.snapshot();
  if (models === null) return [];
  return AI_FILL_BACKEND_VALUES.filter((backend) => !isServed(models, backend));
}

export function isTextBackendUnavailable(backend: AiFillBackend): boolean {
  const models = source.snapshot();
  return models !== null && !isServed(models, backend);
}
