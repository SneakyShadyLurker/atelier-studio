import { API_ERROR_CODES, RECOVERY_REQUIRED_ERROR, RETRY_AFTER_FIELD } from '@atelier/shared';
import type { ApiErrorCode } from '@atelier/shared';
import { ApiError } from '../api/client';
import { isRecord } from './guards';
import { ModerationError } from './moderationNotice';

export const UNCERTAIN_SUBMISSION_NOTICE = {
  text: 'Submission timed out. Your prompt is saved in the queue. Resuming also submits other queued prompts.',
  actionLabel: 'Resume queue',
} as const;

export class EnhanceFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnhanceFailedError';
  }
}

// Codes get hand-tuned copy that beats the raw server string. Keys are the
// shared wire vocabulary — a code the api stops emitting fails typecheck here.
const CODE_COPY: Partial<Record<ApiErrorCode, string>> = {
  NEEDS_GOOGLE_KEY: 'Add your Google API key to use this model.',
  MODEL_OFFLINE: 'This model is offline right now. Pick another or try again later.',
  GOOGLE_AUTH_FAILED: 'Google rejected the key. Check it was pasted in full.',
  GOOGLE_UNAVAILABLE: "Couldn't reach Google to verify the key. Try again.",
  VIDEO_BUSY: 'A video is already generating. Wait for it to finish before starting another.',
};

const apiErrorCodes: ReadonlySet<string> = new Set(API_ERROR_CODES);

// Single extraction idiom for the JSON error envelope's `code` field.
export function apiErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !isRecord(error.body)) return undefined;
  return typeof error.body.code === 'string' ? error.body.code : undefined;
}

function knownApiErrorCode(code: string | undefined): ApiErrorCode | undefined {
  // Cast is membership-validated against the shared vocabulary.
  return code !== undefined && apiErrorCodes.has(code) ? (code as ApiErrorCode) : undefined;
}

function formatIssuePath(path: readonly unknown[]): string {
  return path.reduce<string>((out, part) => {
    if (typeof part === 'number') return `${out}[${part}]`;
    if (typeof part !== 'string' || part.length === 0) return out;
    return out.length === 0 ? part : `${out}.${part}`;
  }, '');
}

function describeFirstIssue(body: unknown): string | null {
  if (!isRecord(body) || !Array.isArray(body.issues)) return null;
  const issue = body.issues.find(isRecord);
  if (!issue || typeof issue.message !== 'string' || issue.message.trim().length === 0) return null;
  const path = Array.isArray(issue.path) ? formatIssuePath(issue.path) : '';
  return path.length > 0 ? `path: ${path}, ${issue.message}` : issue.message;
}

function describeSequenceError(error: ApiError): string | null {
  if (!isRecord(error.body) || typeof error.body.error !== 'string') return null;
  if (error.body.error === 'not-tail') {
    return 'Someone extended this sequence already. Refresh and extend the new tail.';
  }
  if (error.body.error === 'sequence-full') {
    return 'This sequence has reached the maximum number of clips.';
  }
  if (error.body.error === 'provenance-mismatch') {
    return 'The handoff frame no longer matches this clip. Start Extend again.';
  }
  if (
    error.body.error === 'validation failed'
    && Array.isArray(error.body.issues)
    && error.body.issues.some((issue) => isRecord(issue) && issue.message === 'ratio must match sequence')
  ) {
    return 'The ratio must match the sequence. Start Extend again.';
  }
  return null;
}

export function describeQueueFull(error: unknown): string | null {
  if (!(error instanceof ApiError) || !isRecord(error.body)) return null;
  const retryAfter = error.body[RETRY_AFTER_FIELD];
  if (apiErrorCode(error) !== ('QUEUE_FULL' satisfies ApiErrorCode) || typeof retryAfter !== 'number') return null;
  return `At capacity — try again in ${String(retryAfter)}s`;
}

function withRequestId(message: string, error: ApiError): string {
  if (typeof error.requestId !== 'string' || error.requestId.trim().length === 0) return message;
  return `${message} (req: req_${error.requestId.slice(0, 8)})`;
}

// One user-facing error→copy resolver. The api's 4xx JSON `error` strings are
// deliberately user-safe PRODUCT copy ("name already used", "concurrent tile
// limit reached", "reference image is too large") — surface them verbatim so
// the user gets an actionable reason. Only opaque server/transport failures
// (5xx, retryable, non-ApiError) are flattened to generic copy, because those
// are the ones that would otherwise leak internals / stack-adjacent noise.
export function describeError(error: unknown, fallback: string): string {
  if (error instanceof ModerationError) return error.message;
  if (error instanceof EnhanceFailedError && error.message.trim().length > 0) {
    return error.message;
  }
  if (error instanceof ApiError) {
    const queueFull = describeQueueFull(error);
    if (queueFull) return queueFull;

    const sequenceError = describeSequenceError(error);
    if (sequenceError) return sequenceError;

    const issueMessage = describeFirstIssue(error.body);
    if (issueMessage) return issueMessage;

    const recoveryMessage =
      isRecord(error.body)
        ? error.body
        : undefined;
    if (
      recoveryMessage?.error === RECOVERY_REQUIRED_ERROR
      && typeof recoveryMessage.message === 'string'
      && recoveryMessage.message.trim().length > 0
    ) {
      return recoveryMessage.message;
    }

    const code = knownApiErrorCode(apiErrorCode(error));
    if (code !== undefined) {
      const mapped = CODE_COPY[code];
      if (mapped) return mapped;
    }
    if (error.status >= 500 || error.retryable) {
      return withRequestId('Something went wrong on our end. Please try again.', error);
    }
    // 4xx: the curated server string lives on ApiError.message (extractApiError
    // populates it from the JSON `error`/`message` field).
    if (error.status >= 400 && error.message.trim().length > 0) {
      return error.message;
    }
    return fallback;
  }
  return fallback;
}
