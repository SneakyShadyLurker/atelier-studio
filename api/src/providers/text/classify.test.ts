import { describe, expect, test } from 'bun:test';
import { APICallError, InvalidResponseDataError } from '@ai-sdk/provider';
import {
  buildResilientPolicy,
  isRetriable,
  PermanentUpstreamError,
  QuotaExhaustedError,
  TransientUpstreamError,
} from '../../lifecycle/resilient-call';
import { classifyApiError, classifyStreamError } from './classify';
import { TextResponseTooLargeError } from './fetch';

const QUOTA_MS = 300_000;

/** An HTTP failure as `@ai-sdk/openai-compatible` raises it (lower-case header keys, raw body text). */
function apiError(status: number, body: unknown, headers: Record<string, string> = {}): APICallError {
  return new APICallError({
    message: `upstream ${status}`,
    url: 'http://provider.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode: status,
    responseHeaders: headers,
    responseBody: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function classify(status: number, body: unknown, headers: Record<string, string> = {}): Error {
  return classifyApiError(apiError(status, body, headers), QUOTA_MS);
}

// Ported from the legacy CLIProxy text provider's classification tests.
describe('classifyApiError quota detection', () => {
  test('429 + long Retry-After → QuotaExhaustedError with raw seconds', () => {
    const e = classify(429, { error: { message: 'slow down' } }, { 'retry-after': '900' });
    expect(e).toBeInstanceOf(QuotaExhaustedError);
    expect((e as QuotaExhaustedError).retryAfterSeconds).toBe(900);
  });
  test('429 + token-budget body wording → quota even without header', () => {
    const body = { error: { message: 'You have hit your usage limit for this 5 hour window' } };
    expect(classify(429, body)).toBeInstanceOf(QuotaExhaustedError);
  });
  test('429 + short Retry-After (30s) → transient, NOT quota', () => {
    const e = classify(429, {}, { 'retry-after': '30' });
    expect(e).toBeInstanceOf(TransientUpstreamError);
    expect((e as TransientUpstreamError).category).toBe('429');
    expect(e.cause).toEqual({ status: 429, body: {}, retryAfterMs: 30_000 });
  });
  test('429 + no signal → transient', () => {
    expect(classify(429, {})).toBeInstanceOf(TransientUpstreamError);
  });
  test('quota error is non-retriable', () => {
    expect(isRetriable(classify(429, {}, { 'retry-after': '900' }))).toBe(false);
  });
});

test('5xx preserves Retry-After metadata without applying quota classification', () => {
  for (const status of [500, 502, 503, 504]) {
    const body = { error: { message: 'try later' } };
    const error = classify(status, body, { 'retry-after': '900' });
    expect(error).toBeInstanceOf(TransientUpstreamError);
    expect(error.cause).toEqual({ status, body, retryAfterMs: 900_000 });
  }
});

test('invalid Retry-After stays absent; past HTTP dates preserve zero', () => {
  expect(classify(503, {}, { 'retry-after': 'invalid' }).cause).toMatchObject({ retryAfterMs: null });
  expect(classify(429, {}, { 'retry-after': 'Thu, 01 Jan 1970 00:00:00 GMT' }).cause)
    .toMatchObject({ retryAfterMs: 0 });
});

test('408 is transient and other 4xx are permanent', () => {
  expect(classify(408, {})).toMatchObject({ category: '408' });
  expect(classify(408, {})).toBeInstanceOf(TransientUpstreamError);
  const e = classify(400, 'not json');
  expect(e).toBeInstanceOf(PermanentUpstreamError);
  expect(e.cause).toEqual({ status: 400, body: 'not json', retryAfterMs: null });
});

async function retryGap(status: number, retryAfter: string | undefined): Promise<number> {
  const policy = buildResilientPolicy({
    timeoutPerAttemptMs: 1_000, maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 80,
    rateLimitBackoffFloorMs: 30, breakerThreshold: 8, halfOpenAfterMs: 1_000,
  });
  let first = 0;
  let gap = 0;
  let attempts = 0;
  await policy.execute(() => {
    attempts += 1;
    if (attempts === 1) {
      first = performance.now();
      throw classify(status, {}, retryAfter === undefined ? {} : { 'retry-after': retryAfter });
    }
    gap = performance.now() - first;
    return Promise.resolve();
  });
  expect(attempts).toBe(2);
  return gap;
}

test('text-classified Retry-After reaches retry scheduling and retains floor/cap semantics', async () => {
  for (const status of [429, 503]) {
    const capped = await retryGap(status, '1');
    expect(capped).toBeGreaterThanOrEqual(70);
    expect(capped).toBeLessThan(1_000);
  }
  for (const header of ['0', undefined]) {
    expect(await retryGap(429, header)).toBeGreaterThanOrEqual(25);
  }
});

describe('classifyApiError non-HTTP failures', () => {
  test('a connection failure (no status) is a transient socket error', () => {
    const err = new APICallError({
      message: 'Cannot connect to API: refused',
      url: 'http://provider.test/v1/chat/completions',
      requestBodyValues: {},
      isRetryable: true,
    });
    expect(classifyApiError(err, QUOTA_MS)).toMatchObject({ category: 'socket' });
  });

  test('a plain network error is a transient socket error', () => {
    expect(classifyApiError(new TypeError('fetch failed'), QUOTA_MS)).toBeInstanceOf(TransientUpstreamError);
  });

  test('the byte cap survives the SDK wrapping it in APICallError', () => {
    const tooLarge = new TextResponseTooLargeError(10, 20);
    const wrapped = new APICallError({
      message: 'Failed to process successful response',
      url: 'http://provider.test/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 200,
      cause: tooLarge,
    });
    expect(classifyApiError(wrapped, QUOTA_MS)).toBe(tooLarge);
  });

  test('already-typed upstream errors and aborts pass through', () => {
    const typed = new PermanentUpstreamError('4xx', null);
    expect(classifyApiError(typed, QUOTA_MS)).toBe(typed);
    const abort = new DOMException('aborted', 'AbortError');
    expect(classifyApiError(abort, QUOTA_MS)).toBe(abort);
  });
});

// In-stream `error` parts, today's `classifyInStreamFrame` table.
describe('classifyStreamError', () => {
  test('quota wording → QuotaExhaustedError without a retry hint', () => {
    const e = classifyStreamError({ message: 'weekly limit reached' }, QUOTA_MS);
    expect(e).toBeInstanceOf(QuotaExhaustedError);
    expect((e as QuotaExhaustedError).retryAfterSeconds).toBeNull();
  });
  test('timeout wording → transient in-stream-timeout', () => {
    expect(classifyStreamError({ message: 'upstream timed out' }, QUOTA_MS)).toMatchObject({ category: 'in-stream-timeout' });
    expect(classifyStreamError('connection reset by peer', QUOTA_MS)).toMatchObject({ category: 'in-stream-timeout' });
  });
  test('anything else in-stream → permanent in-stream', () => {
    const e = classifyStreamError({ message: 'bad request', code: 'invalid' }, QUOTA_MS);
    expect(e).toBeInstanceOf(PermanentUpstreamError);
    expect(e).toMatchObject({ category: 'in-stream', message: 'bad request' });
  });
  test('the SDK missing-finish error is a transient incomplete stream', () => {
    const e = classifyStreamError(new InvalidResponseDataError({ data: undefined, message: 'Response stream ended without a finish reason.' }), QUOTA_MS);
    expect(e).toBeInstanceOf(TransientUpstreamError);
    expect(e).toMatchObject({ category: 'socket' });
  });
  test('an oversized stream keeps its typed error', () => {
    const tooLarge = new TextResponseTooLargeError(10, 20);
    expect(classifyStreamError(tooLarge, QUOTA_MS)).toBe(tooLarge);
  });
});
