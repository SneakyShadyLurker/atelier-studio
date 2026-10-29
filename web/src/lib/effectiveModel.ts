import type { Model } from '@atelier/shared';

/**
 * A model is a usable generation target unless its upstream is known offline.
 * Only locally-probed models carry `availability` (cloud + mock omit it and
 * are always available — see `Model.availability` in shared); `ok: false` is
 * the sole disqualifier. An absent snapshot (pre-first-probe) counts as
 * available, matching the Composer's chip gating.
 */
export function isModelAvailable(model: Model): boolean {
  return model.availability?.ok !== false;
}

/**
 * Resolve the model the composer actually targets for a given draft selection.
 * The selection is honored whenever it resolves to an available model; when it
 * is missing (deregistered / empty fresh-load) or its upstream is offline we
 * fall back to a usable cloud model, so Generate can never get stuck disabled
 * behind an offline local host. Pure derivation — the draft is left untouched,
 * so the user's selection self-restores once the host comes back.
 */
export function resolveEffectiveModel(
  models: readonly Model[],
  selectedId: string,
): Model | undefined {
  if (models.length === 0) return undefined;
  const selected = models.find((model) => model.id === selectedId);
  if (selected && isModelAvailable(selected)) return selected;
  // Prefer a cloud model the user can submit to without configuring a BYOK key
  // first; cloud models never carry `availability`, so they are the resilient
  // fallback when a local host drops.
  const usableCloud = models.find(
    (model) => model.backend === 'cloud' && model.requiresKey === undefined && isModelAvailable(model),
  );
  if (usableCloud) return usableCloud;
  // Degrade gracefully: a key-gated cloud model still beats an offline local
  // one (the Composer opens BYOK on submit), then any available model at all.
  const anyCloud = models.find((model) => model.backend === 'cloud' && isModelAvailable(model));
  if (anyCloud) return anyCloud;
  const anyAvailable = models.find(isModelAvailable);
  return anyAvailable ?? models[0];
}
