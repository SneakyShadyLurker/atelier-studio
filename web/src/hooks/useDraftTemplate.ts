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
}

export function useDraftTemplate({ name, getCurrentBody, onBody, onWarnings }: Args): UseAiDraftWithClarifyResult {
  const imageContext = usePromptImageContext();
  return useAiDraftWithClarify<string, DraftedBody>({
    captureBase: getCurrentBody,
    isEmptyBase: (body) => body.trim() === '',
    run: (body, description, signal) => {
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
