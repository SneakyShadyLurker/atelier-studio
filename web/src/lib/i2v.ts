import type { Model } from '@atelier/shared';

// Image-to-video renders are long (~11-13 min on the shared GPU host). The UI
// uses this estimate to set expectations on the composer Animate button and to
// drive the determinate ETA in the loading state. It is a display hint only —
// never a timeout or a gate.
export const I2V_ESTIMATED_RENDER_MS = 12 * 60 * 1000;
export const I2V_ESTIMATED_LABEL = '~12 min';

/** The registered image-to-video model, if any (Animate/Extend target). */
export function findI2VModel(models: Iterable<Model>): Model | undefined {
  for (const model of models) if (model.supportsI2V === true) return model;
  return undefined;
}
