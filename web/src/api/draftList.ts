import type { DraftVariableListRequest, DraftVariableListResponse } from '@atelier/shared';
import { apiPath } from './client';
import { requestSseResult } from './sse';
import { DraftVariableListResponseSchema } from '@atelier/shared/prompt-tool-schemas';

function isDraftVariableListResponse(value: unknown): value is DraftVariableListResponse {
  return DraftVariableListResponseSchema.safeParse(value).success;
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
