import { describe, expect, test } from 'bun:test';
import { failedToSseError, textFailureToSseError } from './llm-error';

describe('failedToSseError', () => {
  test('quota failure → code quota-exhausted + retryAfterSeconds', () => {
    expect(failedToSseError({ type: 'failed', kind: 'quota', status: 429, detail: 'x', retryAfterSeconds: 900 }))
      .toEqual({ message: 'Codex quota exhausted', code: 'quota-exhausted', retryAfterSeconds: 900 });
  });
  test('quota failure with no retryAfter → omit the field', () => {
    const e = failedToSseError({ type: 'failed', kind: 'quota', status: 429, detail: 'x' });
    expect(e).toEqual({ message: 'Codex quota exhausted', code: 'quota-exhausted' });
    expect('retryAfterSeconds' in e).toBe(false);
  });
  test('content-filter failure → content-filter code', () => {
    expect(failedToSseError({ type: 'failed', kind: 'content-filter', status: null, detail: 'x' }))
      .toEqual({ message: 'The model refused this request.', code: 'content-filter' });
  });
  test('transient/permanent → code provider-error, no retryAfter', () => {
    const e = failedToSseError({ type: 'failed', kind: 'transient', status: 503, detail: 'x' });
    expect(e.code).toBe('provider-error');
    expect(e.retryAfterSeconds).toBeUndefined();
  });

  test('a blocked text request names no vendor; a blocked image request keeps the GPT policy wording', () => {
    const blocked = (target: 'text' | 'image') => failedToSseError({
      type: 'failed', kind: 'moderation-blocked', status: 422, detail: 'x',
      moderation: { reason: 'graphic-violence', target, categories: ['graphic-violence'] },
    }).message;
    expect(blocked('text')).toBe('Atelier blocked this request under its content policy.');
    expect(blocked('image')).toBe('Atelier blocked this request under its GPT content policy.');
  });
});

describe('textFailureToSseError', () => {
  const FALLBACK = 'Could not do it. Please try again.';
  test('a typed failure goes through failedToSseError, quota keeping its retry hint', () => {
    const failure = { type: 'failed', kind: 'quota', status: 429, detail: 'x', retryAfterSeconds: 60 } as const;
    expect(textFailureToSseError(failure, FALLBACK)).toEqual(failedToSseError(failure));
    expect(textFailureToSseError(failure, FALLBACK)).toEqual({ message: 'Codex quota exhausted', code: 'quota-exhausted', retryAfterSeconds: 60 });
  });
  test('a moderation failure keeps its notice', () => {
    const failure: Parameters<typeof failedToSseError>[0] = {
      type: 'failed', kind: 'moderation-blocked', status: 422, detail: 'x',
      moderation: { reason: 'graphic-violence', target: 'text', categories: ['graphic-violence'] },
    };
    expect(textFailureToSseError(failure, FALLBACK)).toEqual(failedToSseError(failure));
  });
  test('a crash or timeout without a typed failure carries the fallback message and provider-error', () => {
    expect(textFailureToSseError(null, FALLBACK)).toEqual({ message: FALLBACK, code: 'provider-error' });
    expect(textFailureToSseError(undefined, FALLBACK)).toEqual({ message: FALLBACK, code: 'provider-error' });
  });
});
