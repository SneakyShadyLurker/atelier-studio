import type { DraftVariableListRequest, DraftVariableListResponse } from '@atelier/shared';
import { apiPath } from './client';
import { requestSseResult } from './sse';
import { isRecord, isStringArray } from '../lib/guards';

function isDraftVariableListResponse(value: unknown): value is DraftVariableListResponse {
  if (!isRecord(value)) return false;
  if (value.kind === 'entries') return isStringArray(value.entries);
  return value.kind === 'clarify' && typeof value.question === 'string';
}

export async function draftVariableList(
  listId: string,
  request: DraftVariableListRequest,
  signal?: AbortSignal,
): Promise<DraftVariableListResponse> {
  return requestSseResult<DraftVariableListResponse>(
    apiPath('/prompts/lists/:listId/draft', { listId }),
    request,
    {
      ...(signal ? { signal } : {}),
      guard: isDraftVariableListResponse,
      noBodyMessage: 'draft list response did not include a stream',
      invalidPayloadMessage: 'invalid draft list payload',
      errorFallback: 'draft list failed',
      streamEndedMessage: 'draft list stream ended without a terminal event',
    },
  );
}
