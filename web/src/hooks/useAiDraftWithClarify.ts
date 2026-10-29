import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { isAbortError } from '../lib/abort';
import { describeError } from '../lib/errorCopy';
import { useAtelierStore } from '../store/atelier';
import { useAbortableMutation } from './useAbortableMutation';

// The shared "AI draft with optional clarify round-trip" state machine, extracted
// from useDraftList + useDraftTemplate (which had drifted independently — only one
// guarded the cancel-during-resolved race and aborted on cancel). Both hooks now
// delegate here, supplying only their payload-shape callbacks.

export type AiDraftStatus = 'idle' | 'seed-prompt' | 'drafting' | 'clarifying' | 'done' | 'error';
export type AiDraftDialogMode = 'seed' | 'clarify' | null;

interface ClarifyResponse {
  kind: 'clarify';
  question: string;
}

// TS can't narrow a generic `TResolved | ClarifyResponse` by a bare `.kind`
// check (TResolved is opaque), so a user-defined guard does the discrimination.
function isClarifyResponse(response: { kind: string }): response is ClarifyResponse {
  return response.kind === 'clarify';
}

interface UseAiDraftWithClarifyArgs<TBase, TResolved extends { kind: string }> {
  /** Snapshot the input the draft is based on; captured when draft() starts and
   *  reused across the clarify round-trip so the answer applies to the same base. */
  captureBase: () => TBase;
  /** Empty base → show the seed prompt instead of firing immediately. */
  isEmptyBase: (base: TBase) => boolean;
  /** Perform the request. Resolves to the final payload OR a clarify follow-up. */
  run: (base: TBase, description: string | undefined, signal: AbortSignal) => Promise<TResolved | ClarifyResponse>;
  /** Apply a resolved (non-clarify) payload. */
  onResolve: (result: TResolved) => void;
  /** Error-toast copy when the request fails for a non-abort reason. */
  errorFallback: string;
}

export interface UseAiDraftWithClarifyResult {
  draft: () => void;
  submitDescription: (text: string) => void;
  cancelDialog: () => void;
  status: AiDraftStatus;
  dialogMode: AiDraftDialogMode;
  clarifyQuestion: string | null;
  error: string | null;
}

interface FireVars<TBase> {
  base: TBase;
  description: string | undefined;
}

export function useAiDraftWithClarify<TBase, TResolved extends { kind: string }>(
  args: UseAiDraftWithClarifyArgs<TBase, TResolved>,
): UseAiDraftWithClarifyResult {
  const { captureBase, isEmptyBase, run, onResolve, errorFallback } = args;
  const addToast = useAtelierStore((s) => s.addToast);
  const abortable = useAbortableMutation();
  const [status, setStatus] = useState<AiDraftStatus>('idle');
  const [dialogMode, setDialogMode] = useState<AiDraftDialogMode>(null);
  const [clarifyQuestion, setClarifyQuestion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The base captured at draft() time, reused on the clarify answer. Wrapped so a
  // legitimately-falsy base ([], '') is distinguishable from "not captured yet".
  const [base, setBase] = useState<{ value: TBase } | null>(null);

  const mutation = useMutation({
    mutationFn: async (vars: FireVars<TBase>) => {
      const signal = abortable.supersede();
      const response = await run(vars.base, vars.description, signal);
      return { response, signal };
    },
    onSuccess: ({ response, signal }) => {
      // cancel-during-resolved race: the request can resolve between the user
      // cancelling (abort) and this callback dispatching. Drop the stale result.
      if (signal.aborted) return;
      if (isClarifyResponse(response)) {
        setClarifyQuestion(response.question);
        setDialogMode('clarify');
        setStatus('clarifying');
        return;
      }
      setDialogMode(null);
      setClarifyQuestion(null);
      setError(null);
      setStatus('done');
      onResolve(response);
    },
    onError: (err) => {
      if (isAbortError(err)) {
        setStatus('idle');
        return;
      }
      const message = describeError(err, errorFallback);
      setError(message);
      setStatus('error');
      addToast(message, 'error');
    },
  });

  const { mutate, isPending } = mutation;

  const fire = (value: TBase, description: string | undefined) => {
    // Deliberately does NOT clear dialogMode: a seed/clarify submit keeps its
    // dialog mounted through the request, so a failure leaves the dialog open
    // with its error for retry. draft()'s immediate path only runs when
    // dialogMode is already null (its re-entrancy guard), and onSuccess clears
    // it on resolve — so no dialog is shown for a non-seed initial draft.
    setError(null);
    setStatus('drafting');
    mutate({ base: value, description });
  };

  const draft = () => {
    // Never re-enter while a dialog is open (seed/clarify, incl. the
    // failed-submit-keeps-dialog-mounted case) or a request is in flight.
    if (isPending || dialogMode !== null) return;
    const captured = captureBase();
    setBase({ value: captured });
    setClarifyQuestion(null);
    setError(null);
    if (isEmptyBase(captured)) {
      setDialogMode('seed');
      setStatus('seed-prompt');
      return;
    }
    fire(captured, undefined);
  };

  const submitDescription = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || isPending) return;
    if (dialogMode === null || base === null) return;
    fire(base.value, trimmed);
  };

  const cancelDialog = () => {
    abortable.abort('cancel');
    setDialogMode(null);
    setClarifyQuestion(null);
    setError(null);
    setStatus('idle');
  };

  return { draft, submitDescription, cancelDialog, status, dialogMode, clarifyQuestion, error };
}
