import type { DraftVariableListRequest, DraftVariableListResponse } from '@atelier/shared';
import { draftVariableList } from '../api/draftList';
import { usePromptImageContext } from './usePromptImageContext';
import { useAtelierStore } from '../store/atelier';
import { useAiDraftWithClarify, type UseAiDraftWithClarifyResult } from './useAiDraftWithClarify';

type DraftedEntries = Extract<DraftVariableListResponse, { kind: 'entries' }>;

interface UseDraftListArgs {
  listId: string;
  name: string;
  getCurrentValues: () => string[];
  onEntries: (entries: string[]) => void;
}

export function useDraftList({ listId, name, getCurrentValues, onEntries }: UseDraftListArgs): UseAiDraftWithClarifyResult {
  const imageContext = usePromptImageContext();
  const addToast = useAtelierStore((s) => s.addToast);
  return useAiDraftWithClarify<string[], DraftedEntries>({
    captureBase: getCurrentValues,
    isEmptyBase: (existing) => existing.length === 0,
    run: (existing, description, signal) => {
      const request: DraftVariableListRequest = description === undefined
        ? { name, existing }
        : { name, existing, description };
      return draftVariableList(listId, { ...request, ...imageContext }, signal);
    },
    onResolve: (payload) => {
      if (payload.entries.length === 0) {
        addToast('No new entries to add — try a more specific name.');
        return;
      }
      onEntries(payload.entries);
    },
    errorFallback: 'Couldn’t draft the list. Please try again.',
  });
}
