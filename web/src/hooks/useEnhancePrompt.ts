import { useMutation } from '@tanstack/react-query';
import type { EnhancePromptRequest, Ratio } from '@atelier/shared';
import { isAbortError } from '../lib/abort';
import { useCallback, useEffect, useRef, useState } from 'react';
import { enhancePromptStream } from '../api/enhance';
import { QuotaExhaustedError } from '../api/sse';
import { describeError } from '../lib/errorCopy';
import { quotaToastMessage, useAtelierStore } from '../store/atelier';
import { useAbortableMutation } from './useAbortableMutation';

interface UseEnhancePromptArgs {
  prompt: string;
  refImageIds: readonly string[];
  modelId?: string;
  ratio?: Ratio;
  onPromptChange: (next: string) => void;
}

type EnhanceStatus = 'idle' | 'streaming' | 'done' | 'error';

export interface UseEnhancePromptResult {
  enhance: () => void;
  undo: () => void;
  /**
   * Route the prompt textarea's edits through here (not straight to
   * onPromptChange): while the composer holds the anchored user prompt itself,
   * the user is editing their brief, so the anchor follows the edit (and is
   * dropped when the box is emptied). Edits to a rewrite leave it untouched.
   */
  editPrompt: (next: string) => void;
  status: EnhanceStatus;
  /** True when the composer holds something other than the anchored user prompt — Undo is live. */
  canUndo: boolean;
}

export function useEnhancePrompt({ prompt, refImageIds, modelId, ratio, onPromptChange }: UseEnhancePromptArgs): UseEnhancePromptResult {
  const addToast = useAtelierStore((s) => s.addToast);
  const setEnhanceInFlight = useAtelierStore((s) => s.setEnhanceInFlight);
  const setDraft = useAtelierStore((s) => s.setDraft);
  // The anchor and last rewrite live in the ComposerDraft slice (not hook
  // state): the Composer unmounts on Archive / Prompt Library while the draft
  // prompt survives, and the anchor must survive with it.
  const anchor = useAtelierStore((s) => s.draft.enhanceAnchor);
  const enhancedText = useAtelierStore((s) => s.draft.enhancedText);
  const [status, setStatus] = useState<EnhanceStatus>('idle');

  // `mutationFn`/`onError` close over the latest render's values — TanStack
  // rebinds the mutation options every render, so no ref-sync is needed (and
  // writing a ref during render is forbidden). The anchor is the USER's prompt:
  // the text in the composer when Enhance was clicked on something that is not
  // an unedited rewrite. While the composer holds an unedited rewrite, every
  // further Enhance re-sends the anchor, so repeated clicks re-roll the user's
  // brief instead of compounding rewrites; Undo always restores it. Generate
  // does NOT end the run. The anchor is dropped only when the brief is
  // replaced outright: Clear (Composer `clearAll`), the Prompt Library's
  // "Use prompt", or the user emptying the box while it holds the anchor.
  // `originalRef` mirrors the base of the in-flight run so onError can restore
  // it after streaming has overwritten the prompt.
  const originalRef = useRef('');
  const abortable = useAbortableMutation();
  const holdsRewrite = enhancedText !== undefined && prompt === enhancedText;
  const canUndo = status !== 'streaming' && anchor !== undefined && prompt !== anchor;

  // Mirror the streaming status into the store so the picker render gate
  // (`promptPickerOpen && !enhancing`) and the batch Reopen guard see the same
  // in-flight signal. Clear it on unmount so a superseded/unmounted Composer
  // can't leave the store stuck "in flight".
  const inFlight = status === 'streaming';
  useEffect(() => {
    setEnhanceInFlight(inFlight);
    return () => { setEnhanceInFlight(false); };
  }, [inFlight, setEnhanceInFlight]);

  const mutation = useMutation({
    mutationFn: async () => {
      const original = holdsRewrite && anchor !== undefined ? anchor : prompt;
      originalRef.current = original;
      setDraft({ enhanceAnchor: original });
      // Abort any prior in-flight stream before installing the fresh
      // controller, so a superseding run can never strand an un-abortable one.
      const signal = abortable.supersede();
      setStatus('streaming');
      const request: EnhancePromptRequest = {
        prompt: original,
        ...(refImageIds.length > 0 ? { refImageIds } : {}),
        ...(modelId !== undefined ? { modelId } : {}),
        ...(ratio !== undefined ? { ratio } : {}),
      };
      let acc = '';
      let completed = false;
      try {
        for await (const event of enhancePromptStream(request, signal)) {
          if (event.event === 'delta') {
            acc += event.data.text;
            onPromptChange(acc);
          } else {
            completed = true;
            break; // done (error frames now throw from the generator)
          }
        }
        // A clean EOF without `done` is a truncated rewrite, not a success:
        // fail into the restore-original path rather than persisting it as
        // `enhancedText`. Never replay — the upstream call is already billed.
        if (!completed) {
          signal.throwIfAborted();
          throw new Error('enhance stream ended before done');
        }
      } catch (error) {
        // An aborted run (Composer unmount mid-stream) must not leave a partial
        // rewrite in the draft: `enhancedText` is only written on success, so
        // the next Enhance would mistake that machine text for the user's brief
        // and re-anchor on it. Roll back to the base — unless a superseding run
        // already owns the controller and is writing its own deltas.
        if (isAbortError(error) && abortable.signal === signal) onPromptChange(original);
        throw error;
      }
      return acc;
    },
    onSuccess: (text) => {
      setDraft({ enhancedText: text });
      setStatus('done');
    },
    onError: (error) => {
      // No controllerRef abort here: the fetch has already settled by the time
      // onError fires, and aborting could cancel a controller a superseding
      // run installed. Unmount/supersession own controller teardown.
      if (isAbortError(error)) {
        setStatus('idle');
        return;
      }
      onPromptChange(originalRef.current);
      setStatus('error');
      if (error instanceof QuotaExhaustedError) {
        addToast(quotaToastMessage(error.retryAfterSeconds), 'error');
      } else {
        addToast(describeError(error, "Couldn't enhance the prompt. Please try again."), 'error');
      }
    },
  });

  const mutate = mutation.mutate;
  const isPending = mutation.isPending;
  const enhance = useCallback(() => {
    if (isPending) return;
    mutate();
  }, [isPending, mutate]);
  const undo = useCallback(() => {
    if (anchor === undefined) return;
    onPromptChange(anchor);
    setStatus('idle');
  }, [anchor, onPromptChange]);
  const editPrompt = useCallback((next: string) => {
    onPromptChange(next);
    if (anchor !== undefined && prompt === anchor) {
      setDraft({ enhanceAnchor: next === '' ? undefined : next });
    }
  }, [anchor, prompt, onPromptChange, setDraft]);

  return {
    enhance,
    undo,
    editPrompt,
    status,
    canUndo,
  };
}
