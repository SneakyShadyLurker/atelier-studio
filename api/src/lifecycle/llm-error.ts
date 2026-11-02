import type { GptModerationNotice, SseTerminalError } from '@atelier/shared';
import type { GptModerationFailureKind } from '../routing/gptModeration';

interface FailedLike {
  readonly type?: string;
  readonly kind?: 'transient' | 'permanent' | 'quota' | 'content-filter' | GptModerationFailureKind;
  readonly moderation?: GptModerationNotice;
  readonly status: number | null;
  readonly detail: string;
  readonly retryAfterSeconds?: number;
}

export function failedToSseError(failure: FailedLike): SseTerminalError {
  if (failure.moderation) {
    return {
      message: failure.moderation.reason === 'unavailable'
        ? 'Atelier could not complete the content check. Please try again.'
        : failure.moderation.target === 'image'
          ? 'Atelier blocked this request under its GPT content policy.'
          : 'Atelier blocked this request under its content policy.',
      code: failure.moderation.reason === 'unavailable' ? 'moderation-unavailable' : 'moderation-blocked',
      moderation: failure.moderation,
    };
  }
  if (failure.kind === 'quota') {
    return {
      message: 'Codex quota exhausted',
      code: 'quota-exhausted',
      ...(failure.retryAfterSeconds !== undefined ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
    };
  }
  if (failure.kind === 'content-filter') {
    return { message: 'The model refused this request.', code: 'content-filter' };
  }
  if (failure.kind === 'transient') {
    return { message: 'The AI service timed out or was briefly unavailable — please try again.', code: 'provider-error' };
  }
  return { message: 'The AI service returned an error — please try again.', code: 'provider-error' };
}
