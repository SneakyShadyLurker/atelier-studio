import { expect, test } from 'bun:test';
import { TaskCancelledError } from 'cockatiel';
import { rejectionOf } from '../../test/helpers';
import { textCallPolicies, type TextPolicyKnobs } from './featureHelpers';

const KNOBS: TextPolicyKnobs = {
  RESILIENT_PER_ATTEMPT_TIMEOUT_MS: 20,
  RESILIENT_MAX_ATTEMPTS: 1,
  RESILIENT_INITIAL_BACKOFF_MS: 1,
  RESILIENT_MAX_BACKOFF_MS: 1,
  RESILIENT_BREAKER_THRESHOLD: 8,
  RESILIENT_HALF_OPEN_AFTER_MS: 30_000,
  INFER_TAXONOMY_TIMEOUT_MS: 20,
  AI_FILL_PER_ATTEMPT_TIMEOUT_MS: 20,
};

const slowCall = (): Promise<string> => new Promise((resolve) => setTimeout(() => { resolve('ok'); }, 80));

test('rescue attempts keep the configured timeout on standard rows', async () => {
  const { rescuePolicy } = textCallPolicies(KNOBS, 'standard');
  expect(await rejectionOf(rescuePolicy.execute(slowCall))).toBeInstanceOf(TaskCancelledError);
});

test('rescue attempts get the slow floor on slow rows, infer retry-gaps does not', async () => {
  const { rescuePolicy, inferRetryGapsPolicy } = textCallPolicies(KNOBS, 'slow');
  expect(await rescuePolicy.execute(slowCall)).toBe('ok');
  expect(await rejectionOf(inferRetryGapsPolicy.execute(slowCall))).toBeInstanceOf(TaskCancelledError);
});
