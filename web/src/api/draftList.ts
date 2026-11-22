import type { DraftVariableListRequest, DraftVariableListResponse } from '@atelier/shared';
import { requestSseResult } from './sse';
import { DraftVariableListResponseSchema } from '@atelier/shared/prompt-tool-schemas';
import { isListChangeSet } from '@atelier/shared/list-draft';

// Closes over the request (spec R4.6, D2): which kinds of answer fit depends on
// the mode and the base this request sent, which the wire schema cannot see.
// `create` takes a named list, a seed (an `extend` of no options) an unnamed
// one; a populated `extend` takes only additions, or a question when it sent
// no instructions; `rework` takes only changes. Changes must address exactly
// the options sent, in the order `isListChangeSet` checks.
function draftListResponseGuard(request: DraftVariableListRequest) {
  const seed = request.mode === 'extend' && request.options.length === 0;
  return (value: unknown): value is DraftVariableListResponse => {
    const parsed = DraftVariableListResponseSchema.safeParse(value);
    if (!parsed.success) return false;
    const response = parsed.data;
    if (request.mode === 'create') return response.kind === 'list' && response.name !== null;
    if (seed) return response.kind === 'list' && response.name === null;
    if (response.kind === 'list') return false;
    if (response.kind === 'clarify') return request.mode === 'extend' && request.description === undefined;
    if (request.mode === 'extend' && response.changes.some((change) => change.op !== 'add')) return false;
    return response.baseCount === request.options.length
      && isListChangeSet(response.baseCount, response.changes);
  };
}

export async function draftVariableList(
  request: DraftVariableListRequest,
  signal?: AbortSignal,
): Promise<DraftVariableListResponse> {
  return requestSseResult<DraftVariableListResponse>(
    '/prompts/lists/draft',
    request,
    {
      ...(signal ? { signal } : {}),
      guard: draftListResponseGuard(request),
      noBodyMessage: 'draft list response did not include a stream',
      invalidPayloadMessage: 'invalid draft list payload',
      errorFallback: 'draft list failed',
      streamEndedMessage: 'draft list stream ended without a terminal event',
    },
  );
}
