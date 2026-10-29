import { resolveEffectiveModel } from '../lib/effectiveModel';
import { useAtelierStore } from '../store/atelier';
import { useQuery } from '@tanstack/react-query';
import { modelsOpts } from '../api/models';

/** The same available image selection used by the composer, for library helpers. */
export function usePromptImageContext(): { modelId?: string } {
  const selectedId = useAtelierStore((state) => state.draft.modelId);
  // App owns catalog fetching. Observe its cache without starting another request.
  const { data: models = [] } = useQuery({ ...modelsOpts(), enabled: false });
  const modelId = resolveEffectiveModel(models, selectedId)?.id ?? selectedId;
  return modelId === '' ? {} : { modelId };
}
