import type { DoneTile, Model, Ratio } from '@atelier/shared';
import { useCallback } from 'react';
import { beginSourceHandoff } from '../lib/composerSourceHandoff';
import { describeError } from '../lib/errorCopy';
import { runWhenReachable } from '../lib/focus';
import { modelSelectionPatch } from '../lib/modelSelection';
import { MAX_REF_IMAGES_FALLBACK, useAtelierStore } from '../store/atelier';
import { COMPOSER_PROMPT_ID } from '../components/Composer';
import { useAttachRefImages } from './useAttachRefImages';
import { fetchImageBlob } from '../api/images';

interface EditFromTileOptions {
  focusPrompt?: boolean;
  ratio?: Ratio;
}

// Grid and Lightbox mount separate hook instances. Their handoffs still share
// one upload slot so a viewer opened mid-grid-edit cannot race its result.
let editHandoffInFlight = false;

/**
 * Upload a completed image as a composer reference and select the model that
 * created it, so the follow-up prompt is sent back through the same adapter.
 */
export function useEditFromTile(): (
  tile: DoneTile,
  model: Model,
  options?: EditFromTileOptions,
) => Promise<boolean> {
  const attachRefImages = useAttachRefImages();
  const setDraft = useAtelierStore((state) => state.setDraft);
  const setComposerExpanded = useAtelierStore((state) => state.setComposerExpanded);
  const addToast = useAtelierStore((state) => state.addToast);

  return useCallback(async (tile, model, options) => {
    if (editHandoffInFlight) return false;
    editHandoffInFlight = true;
    const isCurrent = beginSourceHandoff();
    try {
      const blob = await fetchImageBlob(tile);
      // A newer Animate/Extend or composer source change won while the tile
      // downloaded: attach nothing, so a cleared composer is not refilled.
      if (!isCurrent()) return false;
      const file = new File([blob], `${tile.id}.${tile.ext}`, { type: tile.mime });
      const attached = await attachRefImages([file], {
        mode: 'replace-last',
        capacity: model.maxRefImages ?? MAX_REF_IMAGES_FALLBACK,
        maxRefBytesPerBatch: model.maxRefBytesPerBatch,
      });
      if (!attached) return false;
      // Superseded during the ref upload: the chip is already an ordinary
      // composer ref the user can see and remove, but the newer intent keeps
      // its model (and video draft) and focus.
      if (!isCurrent()) return false;

      const ratio = options?.ratio ?? useAtelierStore.getState().draft.ratio;
      setDraft({ ...modelSelectionPatch(model.id, model), ratio });
      setComposerExpanded(true);
      if (options?.focusPrompt) {
        runWhenReachable(() => {
          document.getElementById(COMPOSER_PROMPT_ID)?.focus();
        });
      }
      return true;
    } catch (error) {
      if (isCurrent()) addToast(describeError(error, 'Edit failed.'), 'error');
      return false;
    } finally {
      editHandoffInFlight = false;
    }
  }, [addToast, attachRefImages, setComposerExpanded, setDraft]);
}
