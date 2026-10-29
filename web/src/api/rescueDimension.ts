import type {
  RescueBundle,
  RescueDimensionsRequest,
  TemplateConflict,
} from '@atelier/shared';
import { ApiError } from './client';
import { consumeSseResult, openSseStream, parseTerminalSseErrorFromData } from './sse';
import { isBundleCommon, isTemplateConflict } from './bundleGuards';
import { isRecord } from '../lib/guards';

function isRescueBundle(value: unknown): value is RescueBundle {
  if (!isBundleCommon(value)) return false;
  return value.kind === 'rescue'
    && typeof value.listName === 'string'
    && typeof value.optionValue === 'string'
    && typeof value.templateName === 'string';
}

function isRescueDonePayload(value: unknown): value is {
  rescueBundle: RescueBundle;
  conflicts: readonly TemplateConflict[];
} {
  return isRecord(value)
    && isRescueBundle(value.rescueBundle)
    && Array.isArray(value.conflicts)
    && value.conflicts.every(isTemplateConflict);
}

function isRescueFailedPayload(value: unknown): value is {
  reason: string;
  conflicts?: readonly TemplateConflict[];
} {
  if (!isRecord(value) || typeof value.reason !== 'string') return false;
  if (value.conflicts === undefined) return true;
  return Array.isArray(value.conflicts) && value.conflicts.every(isTemplateConflict);
}

export type RescueResult =
  | { type: 'ok'; rescueBundle: RescueBundle; conflicts: readonly TemplateConflict[] }
  | { type: 'failed'; reason: string; conflicts: readonly TemplateConflict[] };

// /rescue streams its result via SSE for the same reason /infer does — a long
// upstream LLM call exceeds Cloudflare's ~100s edge timeout for a single JSON
// response. Terminal events are `done` (with rescueBundle + updated conflicts)
// or `rescue-failed` (with a category reason). The fetch resolves when the
// server closes the stream.
export async function rescueDimension(
  req: RescueDimensionsRequest,
  signal?: AbortSignal,
): Promise<RescueResult> {
  // Do not auto-reconnect rescue streams. The server consumes the per-template
  // rescue cap before it starts streaming, so a client replay after an edge
  // drop would mutate a one-shot operation again and return rescue-spent.
  const body = await openSseStream('/prompts/dimensions/rescue', req, 'rescue', signal);
  return consumeSseResult<RescueResult>(body, 200, undefined, {
    done: (payload) => {
      if (isRescueDonePayload(payload)) {
        return { type: 'ok', rescueBundle: payload.rescueBundle, conflicts: payload.conflicts };
      }
      throw new ApiError(200, 'invalid done SSE payload', undefined, undefined);
    },
    'rescue-failed': (payload) => {
      if (isRescueFailedPayload(payload)) {
        // Server-side Fix 3 propagates the updated `conflicts` snapshot
        // (rescueAttempted=true on the matching entry) so the client can
        // enforce cap-spent semantics without a parallel state store. If
        // an older server omits the field (partial-deploy moment), fall
        // back to an empty array — the caller's existing rescue-failed
        // state machine still disables the button on its own.
        return { type: 'failed', reason: payload.reason, conflicts: payload.conflicts ?? [] };
      }
      throw new ApiError(200, 'invalid rescue-failed SSE payload', undefined, undefined);
    },
    error: (payload) => {
      throw parseTerminalSseErrorFromData(payload);
    },
  }, 'rescue stream ended without a terminal event');
}
