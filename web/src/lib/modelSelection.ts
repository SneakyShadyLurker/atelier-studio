import type { Model } from '@atelier/shared';
import type { ComposerDraft, Count } from '../store/atelier';

/** Clears every animate/extend field; applied whenever a non-I2V model is selected. */
export const VIDEO_DRAFT_RESET = {
  i2vSourceUploadId: undefined,
  i2vSourcePrompt: undefined,
  motionPrompt: undefined,
  extendsTileId: undefined,
  extendPrevPrompt: undefined,
} as const satisfies Partial<ComposerDraft>;

/**
 * The template picker exists only behind the prompt-library gate and outside
 * animate/extend mode, where the generic prompt it fills is hidden.
 */
export function promptPickerAvailable(promptsEnabled: boolean, model: Model | undefined): boolean {
  return promptsEnabled && model?.supportsI2V !== true;
}

/**
 * The one owner of model-selection draft changes: every entry point (Composer
 * switch, Edit handoff, ...) applies this patch, including video-state cleanup
 * and model-owned default counts.
 */
export function modelSelectionPatch(
  modelId: string,
  model: Model | undefined,
): Partial<ComposerDraft> {
  const countSnap = model?.defaultCount !== undefined ? model.defaultCount as Count : undefined;
  const ratioReset = model?.defaultRatio !== undefined ? { ratio: null } : {};
  // Any non-I2V model clears the animate draft, but only a genuinely
  // image-producing model may become the "back to image generation" target —
  // a T2V row outputs video without supportsI2V and must never be remembered.
  const i2vReset = model?.supportsI2V === true
    ? {}
    : {
        ...VIDEO_DRAFT_RESET,
        ...(model?.outputsVideo === true ? {} : { lastImageModelId: modelId }),
      };

  return countSnap !== undefined
    ? { modelId, count: countSnap, ...ratioReset, ...i2vReset }
    : { modelId, ...ratioReset, ...i2vReset };
}
