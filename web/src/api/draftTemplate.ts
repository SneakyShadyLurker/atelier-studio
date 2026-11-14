import type { DraftTemplateRequest, DraftTemplateResponse } from '@atelier/shared';
import { requestSseResult } from './sse';
import { DraftTemplateResponseSchema } from '@atelier/shared/prompt-tool-schemas';

function isDraftTemplateResponse(value: unknown): value is DraftTemplateResponse {
  return DraftTemplateResponseSchema.safeParse(value).success;
}

export async function draftTemplate(
  request: DraftTemplateRequest,
  signal?: AbortSignal,
): Promise<DraftTemplateResponse> {
  return requestSseResult<DraftTemplateResponse>(
    '/prompts/templates/draft',
    request,
    {
      ...(signal ? { signal } : {}),
      guard: isDraftTemplateResponse,
      noBodyMessage: 'draft template response did not include a stream',
      invalidPayloadMessage: 'invalid draft template payload',
      errorFallback: 'draft template failed',
      streamEndedMessage: 'draft template stream ended without a terminal event',
    },
  );
}
