import { APICallError, InvalidResponseDataError } from '@ai-sdk/provider';
import { isAbortError } from '../../lifecycle/abort';
import {
  PermanentUpstreamError,
  QuotaExhaustedError,
  TransientUpstreamError,
} from '../../lifecycle/resilient-call';
import { errorToRawString as detailOf, tryParseJson } from '../_http';
import { parseRetryAfterMs } from '../retryAfter';
import { TextResponseTooLargeError } from './fetch';
import { incompleteTextStream } from './finish';

// Maps what the AI SDK raises onto Atelier's retry taxonomy. The SDK's
// `isRetryable` has no quota notion, so the HTTP table is the one the legacy
// CLIProxy text provider used.

// Explicit long-budget wording, distinct from transient overload. Kept narrow:
// matches upstream quota phrasing, not generic "rate limit"/"slow down".
const QUOTA_BODY_RE = /usage limit|quota|5\s*hour|weekly limit|exceeded your (current )?(plan|usage)/i;
const IN_STREAM_TIMEOUT_RE = /timed?\s*out|deadline\s*exceeded|connection\s*reset/i;

function bodyText(body: unknown): string {
  const msg = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof msg === 'string' ? msg : detailOf(body);
}

function classifyHttpFailure(status: number, body: unknown, headers: Headers, quotaFloorMs: number): Error {
  const retryAfterMs = parseRetryAfterMs(headers.get('retry-after')) ?? null;
  const cause = { status, body, retryAfterMs };
  if (status >= 500 && status <= 599) {
    return new TransientUpstreamError('5xx', cause, `upstream ${status}`);
  }
  if (status === 429) {
    const quotaByHeader = retryAfterMs !== null && retryAfterMs >= quotaFloorMs;
    const quotaByBody = QUOTA_BODY_RE.test(bodyText(body));
    if (quotaByHeader || quotaByBody) {
      const secs = retryAfterMs !== null ? Math.round(retryAfterMs / 1000) : null;
      return new QuotaExhaustedError(secs, cause, 'upstream quota exhausted');
    }
    return new TransientUpstreamError('429', cause, 'upstream rate-limited');
  }
  if (status === 408) {
    return new TransientUpstreamError('408', cause, 'upstream request-timeout');
  }
  return new PermanentUpstreamError('4xx', cause, `upstream ${status}`);
}

function findTooLarge(err: unknown): TextResponseTooLargeError | null {
  const seen = new Set<unknown>();
  for (let current: unknown = err; current instanceof Error && !seen.has(current); current = current.cause) {
    if (current instanceof TextResponseTooLargeError) return current;
    seen.add(current);
  }
  return null;
}

function isTyped(err: unknown): err is Error {
  return err instanceof TransientUpstreamError
    || err instanceof PermanentUpstreamError
    || err instanceof QuotaExhaustedError;
}

/**
 * Classifies a failed `doStream`/`doGenerate` open (or a body read the SDK
 * wrapped). Aborts, the byte cap and already-typed errors pass through; an
 * HTTP failure uses the status table; anything else is a transient socket error.
 */
export function classifyApiError(err: unknown, quotaFloorMs: number): Error {
  if (isAbortError(err) && err instanceof Error) return err;
  const tooLarge = findTooLarge(err);
  if (tooLarge !== null) return tooLarge;
  if (isTyped(err)) return err;
  if (APICallError.isInstance(err) && err.statusCode !== undefined && err.statusCode >= 400) {
    const raw = err.responseBody ?? '';
    return classifyHttpFailure(
      err.statusCode,
      tryParseJson(raw),
      new Headers(err.responseHeaders ?? {}),
      quotaFloorMs,
    );
  }
  return new TransientUpstreamError('socket', err, detailOf(err));
}

/**
 * Classifies the value of a stream `error` part: an upstream `{ error }` frame
 * on an otherwise-200 stream, the SDK's missing-finish error, or a failed body
 * read.
 */
export function classifyStreamError(error: unknown, quotaFloorMs: number): Error {
  if (InvalidResponseDataError.isInstance(error)) return incompleteTextStream();
  if (error instanceof Error) return classifyApiError(error, quotaFloorMs);
  const msg = typeof error === 'string'
    ? error
    : (error as { readonly message?: unknown } | null)?.message;
  const text = typeof msg === 'string' ? msg : detailOf(error);
  if (QUOTA_BODY_RE.test(text)) return new QuotaExhaustedError(null, error, text);
  if (IN_STREAM_TIMEOUT_RE.test(text)) return new TransientUpstreamError('in-stream-timeout', error, text);
  return new PermanentUpstreamError('in-stream', error, text);
}
