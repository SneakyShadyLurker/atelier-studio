import type {
  CoherenceWarning,
  CoverageWarning,
  DimensionProposal,
  InferDimensionsResponse,
  LibraryDiagnosisResponse,
  RejectedOp,
  TemplateConflict,
} from '@atelier/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { isAbortError } from '../lib/abort';
import { useAbortableMutation } from './useAbortableMutation';
import { usePromptImageContext } from './usePromptImageContext';
import { applyDimensions, inferDimensions, type InferProgressNotification } from '../api/inferDimensions';
import { QuotaExhaustedError } from '../api/sse';
import { ApiError } from '../api/client';
import { promptKeys } from '../api/prompts';
import { invalidatePromptLibrary } from './invalidateLibrary';
import { describeError } from '../lib/errorCopy';
import { quotaToastMessage, useAtelierStore } from '../store/atelier';

type InferStatus = 'idle' | 'analyzing' | 'review' | 'applying' | 'error';

interface ApplyVars {
  readonly keys: readonly string[];
  readonly acceptUnsatisfiableTemplates: readonly string[];
}

interface AnalyzeOpts {
  readonly priorDiagnosis?: LibraryDiagnosisResponse;
}

interface UseInferDimensionsResult {
  analyze: (opts?: AnalyzeOpts) => void;
  apply: (keys: readonly string[], acceptUnsatisfiableTemplates?: readonly string[]) => void;
  status: InferStatus;
  proposal: DimensionProposal | null;
  proposalId: string | null;
  baseSnapshotHash: string | null;
  warnings: readonly CoherenceWarning[];
  coverage: readonly CoverageWarning[];
  rejected: readonly RejectedOp[];
  conflicts: readonly TemplateConflict[];
  /**
   * Templates the SERVER's apply-time coherence check flagged AFTER the
   * client clicked Apply. Distinct from `conflicts` (which come from the
   * infer-time diagnosis against the FULL bundle set): the apply path checks
   * coherence against the user's SUBSET selection, which can produce new
   * conflicts the infer didn't predict. Surface these inline as per-template
   * controls so the user can Skip / Apply anyway without a dead-end toast.
   */
  applyCoherenceFailures: readonly string[];
  progress: InferProgressNotification | null;
  reset: () => void;
}

interface ApplyCoherenceErrorBody {
  readonly error?: unknown;
  readonly code?: unknown;
  readonly templates?: unknown;
}

function extractApplyCoherenceTemplates(error: unknown): readonly string[] | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status !== 422) return null;
  const body = error.body as ApplyCoherenceErrorBody | undefined;
  if (body?.code !== 'coherence') return null;
  if (!Array.isArray(body.templates)) return null;
  const out: string[] = [];
  for (const name of body.templates) {
    if (typeof name === 'string') out.push(name);
  }
  return out.length > 0 ? out : null;
}

export function useInferDimensions(): UseInferDimensionsResult {
  const imageContext = usePromptImageContext();
  const queryClient = useQueryClient();
  const addToast = useAtelierStore((s) => s.addToast);
  const [status, setStatus] = useState<InferStatus>('idle');
  const [data, setData] = useState<InferDimensionsResponse | null>(null);
  const [progress, setProgress] = useState<InferProgressNotification | null>(null);
  const [applyCoherenceFailures, setApplyCoherenceFailures] = useState<readonly string[]>([]);
  const abortable = useAbortableMutation();

  const analyzeMutation = useMutation<InferDimensionsResponse, Error, AnalyzeOpts | undefined>({
    mutationFn: async (opts) => {
      // Abort any prior in-flight stream before installing the fresh
      // controller, so a superseding run can never strand an un-abortable one.
      const signal = abortable.supersede();
      setProgress(null);
      setStatus('analyzing');
      return await inferDimensions(signal, (notification) => {
        setProgress(notification);
      }, { ...imageContext, ...(opts?.priorDiagnosis ? { priorDiagnosis: opts.priorDiagnosis } : {}) });
    },
    onSuccess: (payload) => {
      // Empty proposal: no bundles to review. Return to idle and surface a
      // toast so the user isn't left with a silent click-into-void after the
      // upstream LLM round-trip.
      if (payload.proposal.bundles.length === 0) {
        setData(null);
        setProgress(null);
        setStatus('idle');
        addToast(
          payload.rejected.length > 0
            ? 'AI suggestions all conflicted with the current library — try simplifying.'
            : 'AI found no changes worth proposing.',
        );
        return;
      }
      setData(payload);
      setProgress(null);
      setApplyCoherenceFailures([]);
      setStatus('review');
    },
    onError: (error) => {
      // Do NOT abort controllerRef here: onError fires after the fetch has
      // already settled (so the abort is a no-op for this request), and a
      // superseded analyze/apply would otherwise abort the *newer* request's
      // controller. Supersession + unmount + reset() own controller teardown.
      if (isAbortError(error)) {
        setProgress(null);
        setStatus('idle');
        return;
      }
      setProgress(null);
      setStatus('error');
      if (error instanceof QuotaExhaustedError) {
        addToast(quotaToastMessage(error.retryAfterSeconds), 'error');
      } else {
        addToast(describeError(error, "Couldn't analyse the library. Please try again."), 'error');
      }
    },
  });

  const applyMutation = useMutation({
    mutationFn: async ({ keys, acceptUnsatisfiableTemplates }: ApplyVars) => {
      if (!data?.proposalId) throw new Error('missing proposal');
      // Abort any prior in-flight stream before installing the fresh
      // controller, so a superseding run can never strand an un-abortable one.
      const signal = abortable.supersede();
      setStatus('applying');
      return await applyDimensions({
        proposalId: data.proposalId,
        acceptedBundleKeys: keys,
        acceptUnsatisfiableTemplates,
      }, signal);
    },
    onSuccess: (lib) => {
      queryClient.setQueryData(promptKeys.library(), lib);
      void invalidatePromptLibrary(queryClient);
      addToast('Dimensions updated');
      setData(null);
      setProgress(null);
      setApplyCoherenceFailures([]);
      setStatus('idle');
    },
    onError: (error) => {
      // See the analyze onError above: aborting controllerRef here would let a
      // superseded request cancel the controller of the request that replaced
      // it. The fetch behind this error has already settled.
      if (isAbortError(error)) {
        setProgress(null);
        setStatus('review');
        return;
      }
      // Coherence 422 — surface failing template names inline so the user gets
      // per-template Skip / Apply anyway controls instead of a dead-end toast.
      // The infer-time diagnosis only sees the full-bundle scenario; the
      // user's subset selection can produce conflicts the diagnosis missed.
      const templates = extractApplyCoherenceTemplates(error);
      if (templates) {
        setApplyCoherenceFailures(templates);
        setProgress(null);
        setStatus('review');
        const noun = templates.length === 1 ? 'template' : 'templates';
        const list = templates.map((t) => `“${t}”`).join(', ');
        addToast(`${templates.length} ${noun} would be unsatisfiable: ${list}. Choose Skip or Apply anyway above.`, 'error');
        return;
      }
      setProgress(null);
      setStatus('error');
      addToast(describeError(error, "Couldn't apply dimensions. Please try again."), 'error');
    },
  });

  return {
    analyze: (opts?: AnalyzeOpts) => {
      if (analyzeMutation.isPending) return;
      analyzeMutation.mutate(opts);
    },
    apply: (keys, acceptUnsatisfiableTemplates) => {
      if (applyMutation.isPending) return;
      applyMutation.mutate({
        keys,
        acceptUnsatisfiableTemplates: acceptUnsatisfiableTemplates ?? [],
      });
    },
    status,
    proposal: data?.proposal ?? null,
    proposalId: data?.proposalId ?? null,
    baseSnapshotHash: data?.baseSnapshotHash ?? null,
    warnings: data?.warnings ?? [],
    coverage: data?.coverage ?? [],
    rejected: data?.rejected ?? [],
    conflicts: data?.conflicts ?? [],
    applyCoherenceFailures,
    progress,
    reset: () => {
      abortable.abort('reset');
      setData(null);
      setProgress(null);
      setApplyCoherenceFailures([]);
      setStatus('idle');
    },
  };
}
