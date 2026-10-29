import { describe, expect, mock, test } from 'bun:test';
import type { GenerateRequest } from '@atelier/shared';
import { ApiError } from '../../api/client';
import { isDrainOwned } from '../drainOwnership';
import {
  admitPrepared,
  createAdmissionSequencer,
  postUntilAnswered,
  type AdmissionContext,
  type PreparedPress,
} from './orderedSubmission';
import type { FireItem } from './types';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const request = (prompt: string): GenerateRequest => ({ prompt, modelId: 'model-a', ratio: '1:1', count: 1 });
const queueFull429 = () => new ApiError(429, 'queue full', { code: 'QUEUE_FULL', retry_after_seconds: 2 }, undefined);

describe('createAdmissionSequencer', () => {
  test('turns open in reservation order, however they are released', async () => {
    const sequencer = createAdmissionSequencer();
    const a = sequencer.reserve();
    const b = sequencer.reserve();
    const c = sequencer.reserve();
    const opened: string[] = [];
    void a.ready.then(() => { opened.push('a'); });
    void b.ready.then(() => { opened.push('b'); });
    void c.ready.then(() => { opened.push('c'); });
    await tick();
    expect(opened).toEqual(['a']);
    expect(sequencer.pending()).toBe(3);

    // Later turns released early let nothing pass the turn still held.
    c.release();
    b.release();
    await tick();
    expect(opened).toEqual(['a']);

    a.release();
    a.release();
    await tick();
    expect(opened).toEqual(['a', 'b', 'c']);
    expect(sequencer.pending()).toBe(0);
  });

  test('a turn reserved after every earlier one was released opens at once', async () => {
    const sequencer = createAdmissionSequencer();
    sequencer.reserve().release();
    let opened = false;
    void sequencer.reserve().ready.then(() => { opened = true; });
    await tick();
    expect(opened).toBe(true);
  });
});

describe('postUntilAnswered', () => {
  test('answers at acceptance while the stream keeps running', async () => {
    const stream = Promise.withResolvers<undefined>();
    let accept: (() => void) | undefined;
    const answer = postUntilAnswered((_request, options) => {
      accept = () => { options?.onAccepted?.('batch-1'); };
      return stream.promise;
    }, request('p'));
    let answered = false;
    void answer.then(() => { answered = true; });
    await tick();
    expect(answered).toBe(false);
    accept?.();
    expect(await answer).toEqual({ kind: 'started' });
    stream.resolve(undefined);
  });

  test('classifies a POST that settles without an acceptance', async () => {
    const answerFor = (error: Error) => postUntilAnswered(() => Promise.reject(error), request('p'));
    expect(await postUntilAnswered(() => Promise.resolve(), request('p'))).toEqual({ kind: 'started' });
    // A batch may exist: never requeued.
    expect(await answerFor(Object.assign(new Error('lost'), { name: 'StreamTruncatedError', batchId: 'b1' })))
      .toEqual({ kind: 'started' });
    expect(await answerFor(new DOMException('cancelled', 'AbortError'))).toEqual({ kind: 'started' });
    expect(await answerFor(queueFull429())).toEqual({ kind: 'backpressure', retryAfterMs: 2000 });
    expect(await answerFor(new ApiError(500, 'down', undefined, undefined))).toEqual({ kind: 'failed' });
  });
});

describe('admitPrepared', () => {
  const prepared: FireItem = { key: 'press-1', text: 'filled', provenance: undefined };
  const press: PreparedPress = { item: prepared, paid: false };
  const paidPress: PreparedPress = { item: prepared, paid: true };

  function context(overrides: Partial<AdmissionContext> = {}) {
    const enqueued: [FireItem, boolean][] = [];
    const fired: string[] = [];
    const generate = mock((_request: GenerateRequest) => Promise.resolve());
    const ctx: AdmissionContext = {
      generate,
      makeRequest: (item) => request(item.text),
      queueOwned: () => false,
      enqueue: (item, paid) => { enqueued.push([item, paid]); return true; },
      onFire: () => { fired.push('fire'); },
      ...overrides,
    };
    return { ctx, enqueued, fired, generate };
  }

  test('POSTs the prepared item, marked as owned so capacity is not toasted twice', async () => {
    const { ctx, enqueued, fired, generate } = context();
    expect(await admitPrepared(ctx, press)).toBe('started');
    expect(fired).toEqual(['fire']);
    expect(generate.mock.calls.map((call) => call[0].prompt)).toEqual(['filled']);
    const submitted = generate.mock.calls[0]?.[0];
    if (submitted === undefined) throw new Error('expected a submitted request');
    expect(isDrainOwned(submitted)).toBe(true);
    expect(enqueued).toEqual([]);
  });

  test('joins a queue a drain owns instead of POSTing past the rolls it holds', async () => {
    const { ctx, enqueued, fired, generate } = context({ queueOwned: () => true });
    expect(await admitPrepared(ctx, press)).toBe('queued');
    // The prepared text joins, so the drain never prepares it again; an unpaid
    // press is a user admission under the cap.
    expect(enqueued).toEqual([[prepared, false]]);
    expect(fired).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  test('a paid press joining a drain keeps its paid text past the cap', async () => {
    const { ctx, enqueued } = context({ queueOwned: () => true });
    expect(await admitPrepared(ctx, paidPress)).toBe('queued');
    expect(enqueued).toEqual([[prepared, true]]);
  });

  test('a QUEUE_FULL answer requeues the prepared item as system work', async () => {
    const { ctx, enqueued } = context({ generate: () => Promise.reject(queueFull429()) });
    expect(await admitPrepared(ctx, press)).toBe('capacity');
    expect(enqueued).toEqual([[prepared, true]]);
  });

  test('a genuine refusal reports failed and queues nothing', async () => {
    const { ctx, enqueued } = context({ generate: () => Promise.reject(new ApiError(500, 'down', undefined, undefined)) });
    expect(await admitPrepared(ctx, press)).toBe('failed');
    expect(enqueued).toEqual([]);
  });

  test('a queue that refuses the item reports refused', async () => {
    const { ctx } = context({ queueOwned: () => true, enqueue: () => false });
    expect(await admitPrepared(ctx, press)).toBe('refused');
  });
});
