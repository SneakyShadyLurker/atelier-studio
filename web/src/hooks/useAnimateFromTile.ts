import type { DoneTile, Model, Ratio } from '@atelier/shared';
import { useCallback } from 'react';
import { uploadRefImage } from '../api/uploads';
import { beginSourceHandoff } from '../lib/composerSourceHandoff';
import { describeError } from '../lib/errorCopy';
import { runWhenReachable } from '../lib/focus';
import { useAtelierStore } from '../store/atelier';
import { fetchImageBlob } from '../api/images';

// Single source of truth for the motion-prompt textarea so the grid handoff
// (no focus trap) and the Lightbox handoff (focus-on-unmount) target the same
// element. Keep in lockstep with the Composer motion field's aria-label.
export const MOTION_PROMPT_SELECTOR = 'textarea[aria-label="Motion prompt"]';


export interface AnimateFromTileOptions {
  /**
   * Focus the composer's motion prompt once it mounts. The Lightbox opts OUT
   * (its focus trap is still active until it unmounts, so it owns focus via its
   * own unmount-cleanup handoff); the grid opts IN since the composer is the
   * only live focus surface there.
   */
  focusMotion?: boolean;
  /**
   * The source still's original generation prompt (the originating Batch's
   * prompt). Forwarded into the draft as the h3-motion enhancer's identity
   * anchor. Omitted for uploads / stills with no known prompt.
   */
  sourcePrompt?: string;
  /**
   * The source still's aspect ratio (the originating Batch's ratio). Without
   * it the draft keeps a null ratio and the composer falls back to the video
   * model's first supported ratio — 1:1 — which letterboxes every non-square
   * still. Mirrors the Edit handoff's `ratio` option.
   */
  ratio?: Ratio;
}

/** Fetch and upload a completed still for any feature that needs an upload id. */
export function useUploadTileSource(): (tile: DoneTile) => Promise<string> {
  return async (tile) => {
    const blob = await fetchImageBlob(tile);
    const file = new File([blob], `${tile.id}.${tile.ext}`, { type: tile.mime });
    return (await uploadRefImage(file)).id;
  };
}

/**
 * Hand a still tile off into the composer as an image-to-video source: fetch
 * the artifact, upload it as a source still, then flip the composer into video
 * mode for the supplied I2V model. Shared by the grid tile action and the
 * Lightbox so the flow (and its failure copy) stays identical. Resolves `true`
 * on success, `false` if anything failed (the toast is already shown) — callers
 * use the result to drive their own pending/teardown.
 */
export function useAnimateFromTile(): (tile: DoneTile, videoModel: Model, opts?: AnimateFromTileOptions) => Promise<boolean> {
  const uploadTileSource = useUploadTileSource();
  const setDraft = useAtelierStore((state) => state.setDraft);
  const setComposerExpanded = useAtelierStore((state) => state.setComposerExpanded);
  const addToast = useAtelierStore((state) => state.addToast);
  return useCallback(
    async (tile, videoModel, opts) => {
      const isCurrent = beginSourceHandoff();
      const motionAtStart = useAtelierStore.getState().draft.motionPrompt;
      try {
        const uploadId = await uploadTileSource(tile);
        // A newer Animate/Edit/Extend or a composer source change won.
        if (!isCurrent()) return false;
        const { ratio, motionPrompt } = useAtelierStore.getState().draft;
        setDraft({
          modelId: videoModel.id,
          count: 1,
          i2vSourceUploadId: uploadId,
          // Always set (string | undefined) so a prior Animate's prompt never
          // leaks onto a subsequent source still with no known prompt.
          i2vSourcePrompt: opts?.sourcePrompt,
          ratio: opts?.ratio ?? ratio,
          // A fresh Animate is never a continuation: setDraft merges shallowly,
          // so drop a prior Extend's link, previous prompt and motion text, or
          // the next submit would chain this still onto the old sequence.
          // Motion text typed while this upload was pending is the user's
          // newer intent for this still, so it survives.
          motionPrompt: motionPrompt === motionAtStart ? undefined : motionPrompt,
          extendsTileId: undefined,
          extendPrevPrompt: undefined,
        });
        setComposerExpanded(true);
        if (opts?.focusMotion) {
          runWhenReachable(() => {
            document.querySelector<HTMLElement>(MOTION_PROMPT_SELECTOR)?.focus();
          });
        }
        return true;
      } catch (error) {
        if (isCurrent()) addToast(describeError(error, 'Animate failed.'), 'error');
        return false;
      }
    },
    [uploadTileSource, setDraft, setComposerExpanded, addToast],
  );
}
