import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cancelStory, parseStoryPlanStream } from './stories';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

describe('story planning stream', () => {
  test('parses status, plan, and error frames', async () => {
    const body = [
      'event: status\ndata: {"phase":"planning"}\n\n',
      'event: plan\ndata: {"storyId":"story-1","logline":"A storm closes in.","segments":[{"beat":"She runs.","durationFrames":124}],"etaMs":90000}\n\n',
      'event: error\ndata: {"message":"Planner unavailable","code":"UPSTREAM"}\n\n',
    ].join('');
    const events = [];
    for await (const event of parseStoryPlanStream(streamOf(body))) events.push(event);
    expect(events).toEqual([
      { event: 'status', data: { phase: 'planning' } },
      {
        event: 'plan',
        data: {
          storyId: 'story-1',
          logline: 'A storm closes in.',
          segments: [{ beat: 'She runs.', durationFrames: 124 }],
          etaMs: 90_000,
        },
      },
      { event: 'error', data: { message: 'Planner unavailable', code: 'UPSTREAM' } },
    ]);
  });
});

describe('story planning error frames', () => {
  test('keep the quota and moderation detail of the shared terminal error frame', async () => {
    const body = [
      'event: error\ndata: {"message":"Codex quota exhausted","code":"quota-exhausted","retryAfterSeconds":600}\n\n',
      'event: error\ndata: {"message":"blocked","moderation":{"reason":"graphic-violence","target":"text"}}\n\n',
    ].join('');
    const events = [];
    for await (const event of parseStoryPlanStream(streamOf(body))) events.push(event);
    expect(events).toEqual([
      { event: 'error', data: { message: 'Codex quota exhausted', code: 'quota-exhausted', retryAfterSeconds: 600 } },
      { event: 'error', data: { message: 'blocked', moderation: { reason: 'graphic-violence', target: 'text' } } },
    ]);
  });
});

describe('cancelStory', () => {
  test('validates the cancel response', async () => {
    globalThis.fetch = mock(() => Response.json({ inflightBatchId: 'batch-1' })) as unknown as typeof fetch;
    expect(await cancelStory('story-1')).toEqual({ inflightBatchId: 'batch-1' });
  });

  test('rejects an invalid cancel response', async () => {
    globalThis.fetch = mock(() => Response.json({ inflightBatchId: 42 })) as unknown as typeof fetch;
    const error = await rejectedValue(cancelStory('story-1'));
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('expected cancelStory to reject');
    expect(error.message).toBe('invalid response shape');
  });
});

describe('story plan segments', () => {
  test('rejects a plan whose segment has an unsupported clip length', async () => {
    const body = 'event: plan\ndata: {"storyId":"story-1","logline":"x","segments":[{"beat":"She runs.","durationFrames":125}],"etaMs":1}\n\n';
    const error = await rejectedValue(Array.fromAsync(parseStoryPlanStream(streamOf(body))));
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('expected the plan frame to be rejected');
    expect(error.message).toBe('invalid plan SSE payload');
  });

  test('rejects a plan whose segment has no beat', async () => {
    const body = 'event: plan\ndata: {"storyId":"story-1","logline":"x","segments":[{"durationFrames":124}],"etaMs":1}\n\n';
    const error = await rejectedValue(Array.fromAsync(parseStoryPlanStream(streamOf(body))));
    expect(error).toBeInstanceOf(Error);
  });
});

describe('story planning status and eta', () => {
  test('rejects a status frame with an unknown phase', async () => {
    const error = await rejectedValue(Array.fromAsync(parseStoryPlanStream(streamOf('event: status\ndata: {"phase":"writing"}\n\n'))));
    expect((error as Error).message).toBe('invalid status SSE payload');
  });

  test('rejects a plan with a negative eta', async () => {
    const body = 'event: plan\ndata: {"storyId":"story-1","logline":"x","segments":[],"etaMs":-1}\n\n';
    const error = await rejectedValue(Array.fromAsync(parseStoryPlanStream(streamOf(body))));
    expect((error as Error).message).toBe('invalid plan SSE payload');
  });

  test('yields only the documented plan fields', async () => {
    const body = 'event: plan\ndata: {"storyId":"story-1","logline":"x","segments":[],"etaMs":0,"extra":1}\n\n';
    expect(await Array.fromAsync(parseStoryPlanStream(streamOf(body))))
      .toEqual([{ event: 'plan', data: { storyId: 'story-1', logline: 'x', segments: [], etaMs: 0 } }]);
  });
});
