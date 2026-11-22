import { useState } from 'react';
import type { DraftVariableListRequest, DraftVariableListResponse, ListOptionDraft } from '@atelier/shared';
import { MAX_OPTIONS_PER_LIST } from '@atelier/shared';
import { draftVariableList } from '../api/draftList';
import type { OptionDraft } from '../components/PromptManager/draftStore';
import {
  baseOf,
  isFresh,
  reviewFromResponse,
  type ListBaseRow,
  type ListReview,
  type ListReviewMode,
} from '../components/PromptManager/listReview';
import { usePromptImageContext } from './usePromptImageContext';
import { useAiDraftWithClarify, type UseAiDraftWithClarifyResult } from './useAiDraftWithClarify';

type DraftedList = Exclude<DraftVariableListResponse, { kind: 'clarify' }>;

interface Args {
  name: string;
  /** The editor's rows as they stand now: read when the dialog opens and again when the answer lands. */
  getRows: () => readonly OptionDraft[];
  /** Saves the dialog's text-model choice; awaited before every request. */
  commitChoice: () => Promise<void>;
  /** A seed's options, for an empty list. */
  onSeed: (options: readonly ListOptionDraft[]) => void;
  /** A populated list's placed changes, to review before anything is written. */
  onReview: (review: ListReview) => void;
}

export interface UseDraftListResult extends Omit<UseAiDraftWithClarifyResult, 'draft'> {
  /** Opens the dialog on `preferred` (default Add options), or on Rework when the list is full. */
  draft: (preferred?: ListReviewMode) => void;
  /** The populated dialog's choice: Add options or Rework. */
  choice: ListReviewMode;
  setChoice: (choice: ListReviewMode) => void;
  /** The base had reached the option limit when the dialog opened: Add options is off. */
  full: boolean;
}

export const LIST_DRAFT_STALE = 'The list changed while the draft was running. Try again.';
const NOTHING_PLACED = "The model's edits did not line up with the list. Try again, or pick another model.";
const NOTHING_TO_ADD = 'No new options to add.';
const NOTHING_TO_CHANGE = 'The model found nothing to change.';

// Every draft starts in a dialog (spec R4.1): an empty list asks what it
// should hold (a seed, whose options fill the editor), a populated one whether
// to add options or rework them. A populated list's answer is changes against
// the rows sent, which the caller reviews; one that places nothing keeps the
// dialog open with a note (R4.5). An answer is used only while the editor's
// rows still equal the rows it was asked about (R4.6).
export function useDraftList({ name, getRows, commitChoice, onSeed, onReview }: Args): UseDraftListResult {
  const imageContext = usePromptImageContext();
  const [choice, setChoice] = useState<ListReviewMode>('extend');
  const [full, setFull] = useState(false);
  const [stale, setStale] = useState(false);
  const inner: UseAiDraftWithClarifyResult = useAiDraftWithClarify<readonly ListBaseRow[], DraftedList>({
    captureBase: () => baseOf(getRows()),
    isEmptyBase: (base) => base.length === 0,
    nonEmptyBase: 'rework',
    // Add options on a populated list may go blank: "more of the same"
    // (R4.2). The seed and clarify dialogs need text.
    allowBlankDescription: (): boolean => choice === 'extend' && inner.dialogMode === 'rework',
    run: async (base, description, signal) => {
      setStale(false);
      // A failed save rejects here, so it shows inline and no draft is sent.
      await commitChoice();
      signal.throwIfAborted();
      const request: DraftVariableListRequest = {
        mode: base.length === 0 ? 'extend' : choice,
        name,
        options: base.map(({ value, weight }) => ({ value, weight })),
        ...(description === undefined ? {} : { description }),
        ...imageContext,
      };
      const response = await draftVariableList(request, signal);
      if (!isFresh(base, getRows())) {
        setStale(true);
        throw new Error(LIST_DRAFT_STALE);
      }
      return response;
    },
    onResolve: (payload, { base, description }) => {
      if (payload.kind === 'list') {
        onSeed(payload.options);
        return undefined;
      }
      if (payload.changes.length === 0) {
        if (payload.unplaced.length > 0) return { notice: NOTHING_PLACED };
        if (payload.summary !== null && payload.summary.trim() !== '') return { notice: payload.summary };
        return { notice: choice === 'extend' ? NOTHING_TO_ADD : NOTHING_TO_CHANGE };
      }
      onReview(reviewFromResponse(base, choice, description ?? '', payload));
      return undefined;
    },
    errorFallback: "Couldn't draft the list.",
  });

  const draft = (preferred: ListReviewMode = 'extend') => {
    if (inner.dialogMode !== null || inner.status === 'drafting') return;
    const atLimit = baseOf(getRows()).length >= MAX_OPTIONS_PER_LIST;
    setFull(atLimit);
    setChoice(atLimit ? 'rework' : preferred);
    inner.draft();
  };

  return {
    ...inner,
    error: inner.error !== null && stale ? LIST_DRAFT_STALE : inner.error,
    draft,
    choice,
    setChoice: (next) => { if (!(next === 'extend' && full)) setChoice(next); },
    full,
  };
}
