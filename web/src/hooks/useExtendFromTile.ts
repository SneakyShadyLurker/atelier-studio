import type { Batch, DoneTile, Model } from '@atelier/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { createHandoffFrame } from '../api/sequences';
import { beginSourceHandoff } from '../lib/composerSourceHandoff';
import { describeError } from '../lib/errorCopy';
import { runWhenReachable } from '../lib/focus';
import { useAtelierStore } from '../store/atelier';
import { MOTION_PROMPT_SELECTOR } from './useAnimateFromTile';


export interface ExtendFromTileOptions {
  readonly focusMotion?: boolean;
}

export interface ExtendFromTileResult {
  readonly pendingTileId: string | null;
  readonly extendFromTile: (
    batch: Batch,
    tile: DoneTile,
    videoModel: Model,
    options?: ExtendFromTileOptions,
  ) => Promise<boolean>;
}

export function useExtendFromTile(): ExtendFromTileResult {
  const { setDraft, setComposerExpanded, addToast } = useAtelierStore(useShallow((state) => ({
    setDraft: state.setDraft,
    setComposerExpanded: state.setComposerExpanded,
    addToast: state.addToast,
  })));
  const pendingRef = useRef<{ tileId: string; controller: AbortController } | null>(null);
  const mountedRef = useRef(true);
  const [pendingTileId, setPendingTileId] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingRef.current?.controller.abort(new DOMException('hook unmount', 'AbortError'));
      pendingRef.current = null;
    };
  }, []);

  const extendFromTile = useCallback(async (
    batch: Batch,
    tile: DoneTile,
    videoModel: Model,
    options?: ExtendFromTileOptions,
  ): Promise<boolean> => {
    if (pendingRef.current !== null) return false;
    const controller = new AbortController();
    const pending = { tileId: tile.id, controller };
    pendingRef.current = pending;
    setPendingTileId(tile.id);
    const isCurrent = beginSourceHandoff();
    const motionAtStart = useAtelierStore.getState().draft.motionPrompt;
    try {
      const handoff = await createHandoffFrame(tile.id, controller.signal);
      // Unmounted, or a newer Animate/Edit/Extend or composer source change won.
      if (controller.signal.aborted || !isCurrent()) return false;
      const { motionPrompt } = useAtelierStore.getState().draft;
      setDraft({
        modelId: videoModel.id,
        count: 1,
        ratio: batch.ratio,
        i2vSourceUploadId: handoff.uploadId,
        i2vSourcePrompt: undefined,
        // Motion text typed while the handoff was pending survives.
        motionPrompt: motionPrompt === motionAtStart ? undefined : motionPrompt,
        extendsTileId: tile.id,
        extendPrevPrompt: batch.prompt,
      });
      setComposerExpanded(true);
      if (options?.focusMotion) {
        runWhenReachable(() => {
          document.querySelector<HTMLElement>(MOTION_PROMPT_SELECTOR)?.focus();
        });
      }
      return true;
    } catch (error) {
      if (!controller.signal.aborted && isCurrent()) addToast(describeError(error, 'Extend failed.'), 'error');
      return false;
    } finally {
      if (pendingRef.current === pending) pendingRef.current = null;
      if (mountedRef.current) setPendingTileId(null);
    }
  }, [addToast, setComposerExpanded, setDraft]);

  return { pendingTileId, extendFromTile };
}
