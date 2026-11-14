import type { DraftTemplateRequest, DraftTemplateResponse } from '@atelier/shared';
import { requestSseResult } from './sse';
import { DraftTemplateResponseSchema } from '@atelier/shared/prompt-tool-schemas';
import { isTemplateChangeSet } from '@atelier/shared/template-rework';

// Closes over the request: a `changes` payload is valid only against the body
// this request sent. This rule belongs to the guard, not the wire schema,
// because the schema cannot see the request (spec R1.7).
function draftTemplateResponseGuard(request: DraftTemplateRequest) {
  return (value: unknown): value is DraftTemplateResponse => {
    const parsed = DraftTemplateResponseSchema.safeParse(value);
    if (!parsed.success) return false;
    const response = parsed.data;
    if (response.kind !== 'changes') return true;
    return response.baseLength === request.existingBody.length
      && isTemplateChangeSet(response.baseLength, response.changes);
  };
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
      guard: draftTemplateResponseGuard(request),
      noBodyMessage: 'draft template response did not include a stream',
      invalidPayloadMessage: 'invalid draft template payload',
      errorFallback: 'draft template failed',
      streamEndedMessage: 'draft template stream ended without a terminal event',
    },
  );
}
