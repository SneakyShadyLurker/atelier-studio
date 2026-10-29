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
