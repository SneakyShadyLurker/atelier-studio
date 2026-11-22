import type { DraftVariableListResponse, VariableList } from '@atelier/shared';
import { draftVariableList } from '../api/draftList';
import { draftedOption, type PromptDraftStore } from '../components/PromptManager/draftStore';
import { useAtelierStore } from '../store/atelier';
import { useAiDraftWithClarify, type UseAiDraftWithClarifyResult } from './useAiDraftWithClarify';
import { useCreateList } from './usePromptMutations';
import { usePromptImageContext } from './usePromptImageContext';

type DraftedList = Exclude<DraftVariableListResponse, { kind: 'clarify' }>;

interface Args {
  /** The Prompt Library's draft store: the new list's drafted options are kept there, unsaved. */
  store: PromptDraftStore;
  /** Saves the dialog's text-model choice; awaited before every request. */
  commitChoice: () => Promise<void>;
  /** The list exists and holds its draft: select it. */
  onCreated: (list: VariableList) => void;
}

// Draft New List (spec R6.2, R6.3): the dialog asks what the list should
// vary; the answer names the list and writes its options. The list record is
// created inside the request, so the dialog stays busy until it settles and a
// failed create shows inline with the description kept. The drafted options
// become the new list's unsaved rows (D7): Save list persists them.
export function useDraftNewList({ store, commitChoice, onCreated }: Args): UseAiDraftWithClarifyResult {
  const imageContext = usePromptImageContext();
  const createList = useCreateList();
  const addToast = useAtelierStore((state) => state.addToast);
  return useAiDraftWithClarify<null, DraftedList>({
    captureBase: () => null,
    isEmptyBase: () => true,
    run: async (_base, description, signal) => {
      // A failed save rejects here, so it shows inline and no draft is sent.
      await commitChoice();
      signal.throwIfAborted();
      const response = await draftVariableList({
        mode: 'create',
        options: [],
        ...(description === undefined ? {} : { description }),
        ...imageContext,
      }, signal);
      // The response guard admits only a named list for `create`.
      if (response.kind !== 'list' || response.name === null) throw new Error('unexpected list draft answer');
      const list = await createList.mutateAsync({ name: response.name });
      store.seedList(list.id, { name: list.name, options: response.options.map(draftedOption) });
      onCreated(list);
      return response;
    },
    onResolve: () => {
      addToast('Variable list created');
      return undefined;
    },
    errorFallback: "Couldn't draft the list.",
  });
}
