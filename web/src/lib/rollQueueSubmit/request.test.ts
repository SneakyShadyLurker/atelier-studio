import { describe, expect, test } from 'bun:test';
import type { GenerateRequest } from '@atelier/shared';
import { ApiError } from '../../api/client';
import type { RollSubmission } from '../../store/atelier';
import { batchAlreadyStarted, generateBackpressure, makeGenerateRequest, makeSubmissionRequest } from './request';

const apiError = (status: number, body: unknown) => new ApiError(status, 'refused', body, undefined);

describe('generateBackpressure', () => {
  test('a typed 429 QUEUE_FULL is backpressure with the clamped server hint', () => {
    expect(generateBackpressure(apiError(429, { code: 'QUEUE_FULL', retry_after_seconds: 2 }))).toBe(2000);
    expect(generateBackpressure(apiError(429, { code: 'QUEUE_FULL', retry_after_seconds: 0 }))).toBe(800);
    expect(generateBackpressure(apiError(429, { code: 'QUEUE_FULL', retry_after_seconds: 60 }))).toBe(3000);
    expect(generateBackpressure(apiError(429, { code: 'QUEUE_FULL' }))).toBe(1000);
  });

  test('a 429 VIDEO_BUSY is not backpressure', () => {
    expect(generateBackpressure(apiError(429, { code: 'VIDEO_BUSY' }))).toBeNull();
  });

  test('a non-429 or non-API failure is not backpressure', () => {
    expect(generateBackpressure(apiError(503, { code: 'QUEUE_FULL' }))).toBeNull();
    expect(generateBackpressure(new Error('offline'))).toBeNull();
    expect(generateBackpressure(new DOMException('aborted', 'AbortError'))).toBeNull();
  });
});

describe('batchAlreadyStarted', () => {
  test('only a stream truncation that carries a batch id means a batch exists', () => {
    expect(batchAlreadyStarted(Object.assign(new Error('lost'), { name: 'StreamTruncatedError', batchId: 'b1' }))).toBe(true);
    expect(batchAlreadyStarted(Object.assign(new Error('lost'), { name: 'StreamTruncatedError' }))).toBe(false);
    expect(batchAlreadyStarted(new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(batchAlreadyStarted(null)).toBe(false);
  });
});

describe('makeGenerateRequest', () => {
  const base: GenerateRequest = {
    prompt: 'composer text',
    modelId: 'model-1',
    ratio: '1:1',
    count: 4,
    provenance: { templateId: 'draft-template', rollSeed: 1, pins: {} },
  };

  test('historical replay preserves an omitted seed and raw motion with one stable logical key', () => {
    const submission: RollSubmission = {
      request: { modelId: 'video', ratio: '16:9', count: 1, motionPrompt: 'original motion', durationFrames: 243 },
      lockedSeed: null, wantsMotion: false, motionFields: {}, prepared: true,
    };
    const item = { key: 'internal-roll', text: 'original caption', provenance: undefined, submission };
    expect(makeSubmissionRequest(submission, item)).toEqual({ ...submission.request, prompt: item.text, idempotencyKey: item.key });
    expect(makeSubmissionRequest({ ...submission, lockedSeed: 42 }, item)).toEqual({ ...submission.request, prompt: item.text, seed: 42, idempotencyKey: item.key });
  });

  test('sends the item text, clamped count, item provenance and the roll key', () => {
    const request = makeGenerateRequest(
      base,
      { key: 'roll-1', text: 'roll text', provenance: { templateId: 'roll-template', rollSeed: 2, pins: {} } },
      2,
      77,
    );
    expect(request).toEqual({
      prompt: 'roll text',
      modelId: 'model-1',
      ratio: '1:1',
      count: 2,
      seed: 77,
      provenance: { templateId: 'roll-template', rollSeed: 2, pins: {} },
      idempotencyKey: 'roll-1',
    });
  });

  test('omits provenance the item lacks and draws a fresh seed when unlocked', () => {
    const first = makeGenerateRequest(base, { key: 'k', text: 't', provenance: undefined }, 4, null);
    const second = makeGenerateRequest(base, { key: 'k', text: 't', provenance: undefined }, 4, null);
    expect('provenance' in first).toBe(false);
    expect(typeof first.seed).toBe('number');
    expect(first.seed).not.toBe(second.seed);
  });

  test("a press's settings become the request, whatever the composer holds now", () => {
    const submission: RollSubmission = {
      request: { modelId: 'model-b', ratio: '16:9', count: 2, refImageIds: ['ref-1'] },
      lockedSeed: 4242,
      wantsMotion: false,
      motionFields: {},
    };
    expect(makeSubmissionRequest(submission, { key: 'press-1', text: 'filled text', provenance: undefined, submission }))
      .toEqual({
        prompt: 'filled text',
        modelId: 'model-b',
        ratio: '16:9',
        count: 2,
        refImageIds: ['ref-1'],
        seed: 4242,
        idempotencyKey: 'press-1',
      });
    const video: RollSubmission = {
      ...submission,
      request: { modelId: 'video', ratio: '9:16', count: 1, motionPrompt: 'raw motion', durationFrames: 243 },
      lockedSeed: null,
    };
    const request = makeSubmissionRequest(video, { key: 'press-2', text: 'enhanced motion', provenance: undefined });
    expect(request).toMatchObject({ prompt: 'enhanced motion', motionPrompt: 'enhanced motion', durationFrames: 243 });
    expect(typeof request.seed).toBe('number');
  });

  test('syncs the motion prompt to the item text only when the base carries one', () => {
    const motion = makeGenerateRequest({ ...base, motionPrompt: 'raw motion' }, { key: 'k', text: 'enhanced', provenance: undefined }, 1, 5);
    expect(motion.motionPrompt).toBe('enhanced');
    const still = makeGenerateRequest(base, { key: 'k', text: 'enhanced', provenance: undefined }, 1, 5);
    expect('motionPrompt' in still).toBe(false);
  });
});
