import type { Batch, DoneTile, Model } from '@atelier/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  // Store actions are read at call time: a subscription here would re-run a
  // selector in every mounted batch on every store notification (each
  // progress frame) only to hand back stable functions.
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
    // Settled as a value rather than try/finally: React Compiler cannot yet
    // lower a `finally` clause and would skip memoizing this whole hook.
    const settled = await createHandoffFrame(tile.id, controller.signal).then(
      (handoff) => ({ ok: true as const, handoff }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (pendingRef.current === pending) pendingRef.current = null;
    if (mountedRef.current) setPendingTileId(null);
    const { setDraft, setComposerExpanded, addToast } = useAtelierStore.getState();
    if (!settled.ok) {
      if (!controller.signal.aborted && isCurrent()) addToast(describeError(settled.error, 'Extend failed.'), 'error');
      return false;
    }
    // Unmounted, or a newer Animate/Edit/Extend or composer source change won.
    if (controller.signal.aborted || !isCurrent()) return false;
    const { motionPrompt } = useAtelierStore.getState().draft;
    setDraft({
      modelId: videoModel.id,
      count: 1,
      ratio: batch.ratio,
      i2vSourceUploadId: settled.handoff.uploadId,
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
  }, []);

  return { pendingTileId, extendFromTile };
}
