import type { DraftTemplateRequest, DraftTemplateResponse } from '@atelier/shared';
import { requestSseResult } from './sse';
import { isRecord, isStringArray } from '../lib/guards';

function isDraftTemplateResponse(value: unknown): value is DraftTemplateResponse {
  if (!isRecord(value)) return false;
  if (value.kind === 'body') return typeof value.body === 'string' && isStringArray(value.warnings);
  return value.kind === 'clarify' && typeof value.question === 'string';
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
