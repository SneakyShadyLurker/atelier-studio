import type { DraftTemplateRequest, DraftTemplateResponse } from '@atelier/shared';
import { draftTemplate } from '../api/draftTemplate';
import { usePromptImageContext } from './usePromptImageContext';
import {
  useAiDraftWithClarify,
  type UseAiDraftWithClarifyResult,
} from './useAiDraftWithClarify';

type DraftedBody = Extract<DraftTemplateResponse, { kind: 'body' }>;

interface Args {
  name: string;
  getCurrentBody: () => string;
  onBody: (body: string) => void;
  onWarnings: (warnings: readonly string[]) => void;
  /** Saves the dialog's text-model choice; awaited before every request. */
  commitChoice: () => Promise<void>;
}

// Every draft starts in a dialog: an empty body asks what to draft (seed), a
// filled one what to change (rework). The answer to a rework is the whole
// revised body, which the caller puts in place of the old one.
export function useDraftTemplate({ name, getCurrentBody, onBody, onWarnings, commitChoice }: Args): UseAiDraftWithClarifyResult {
  const imageContext = usePromptImageContext();
  return useAiDraftWithClarify<string, DraftedBody>({
    captureBase: getCurrentBody,
    isEmptyBase: (body) => body.trim() === '',
    nonEmptyBase: 'rework',
    run: async (body, description, signal) => {
      // A failed save rejects here, so it shows inline and no draft is sent.
      await commitChoice();
      // Cancelled while the choice was saving: send nothing.
      signal.throwIfAborted();
      const request: DraftTemplateRequest = description === undefined
        ? { name, existingBody: body.trim() }
        : { name, existingBody: body.trim(), description };
      return draftTemplate({ ...request, ...imageContext }, signal);
    },
    onResolve: (payload) => {
      onBody(payload.body);
      if (payload.warnings.length > 0) onWarnings(payload.warnings);
    },
    errorFallback: "Couldn't draft the template.",
  });
}
