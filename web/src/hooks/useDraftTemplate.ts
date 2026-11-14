import type { DraftTemplateRequest, DraftTemplateResponse } from '@atelier/shared';
import { draftTemplate } from '../api/draftTemplate';
import { reviewFromResponse, type TemplateReview } from '../components/PromptManager/templateReview';
import { usePromptImageContext } from './usePromptImageContext';
import {
  useAiDraftWithClarify,
  type UseAiDraftWithClarifyResult,
} from './useAiDraftWithClarify';

type DraftedTemplate = Exclude<DraftTemplateResponse, { kind: 'clarify' }>;

interface Args {
  name: string;
  getCurrentBody: () => string;
  /** A seed draft's body, written directly. */
  onBody: (body: string) => void;
  /** A rework's placed changes, to review before anything is written. */
  onReview: (review: TemplateReview) => void;
  onWarnings: (warnings: readonly string[]) => void;
  /** Saves the dialog's text-model choice; awaited before every request. */
  commitChoice: () => Promise<void>;
}

const NOTHING_TO_CHANGE = 'The model found nothing to change.';
const NOTHING_PLACED = "The model's edits did not line up with the template text. Try again, or pick another model.";

// Every draft starts in a dialog: an empty body asks what to draft (seed), a
// filled one what to change (rework). A seed answer is the body itself; a
// rework answer is placed changes against the body as sent, which the caller
// reviews. A rework that places nothing keeps the dialog open with a note.
export function useDraftTemplate({ name, getCurrentBody, onBody, onReview, onWarnings, commitChoice }: Args): UseAiDraftWithClarifyResult {
  const imageContext = usePromptImageContext();
  return useAiDraftWithClarify<string, DraftedTemplate>({
    captureBase: getCurrentBody,
    isEmptyBase: (body) => body.trim() === '',
    nonEmptyBase: 'rework',
    run: async (body, description, signal) => {
      // A failed save rejects here, so it shows inline and no draft is sent.
      await commitChoice();
      // Cancelled while the choice was saving: send nothing.
      signal.throwIfAborted();
      // D7: a filled body goes as it stands, so the changes' offsets point
      // into exactly the editor text; a blank one is a seed.
      const existingBody = body.trim() === '' ? '' : body;
      const request: DraftTemplateRequest = description === undefined
        ? { name, existingBody }
        : { name, existingBody, description };
      return draftTemplate({ ...request, ...imageContext }, signal);
    },
    onResolve: (payload, { base, description }) => {
      if (payload.warnings.length > 0) onWarnings(payload.warnings);
      if (payload.kind === 'body') {
        onBody(payload.body);
        return undefined;
      }
      if (payload.changes.length === 0) {
        return { notice: payload.unplaced.length === 0 ? payload.summary ?? NOTHING_TO_CHANGE : NOTHING_PLACED };
      }
      onReview(reviewFromResponse(base, description ?? '', payload));
      return undefined;
    },
    errorFallback: "Couldn't draft the template.",
  });
}
