import { describe, expect, test } from 'bun:test';
import { generateEvents, testRuntime } from './helpers';

describe('per-tile timeout', () => {
  test('slow mock fails with timed out within configured timeout', async () => {
    const { app } = testRuntime({ LOCAL_TIMEOUT_MS: '25', MOCK_PROVIDER_DELAY_MS: '200' });
    const started = Date.now();
    const events = await generateEvents(app, { prompt: 'slow', modelId: 'mock-slow', ratio: '1:1', count: 1 });
    const elapsed = Date.now() - started;
    const tile = events.find((event) => event.event === 'tile')?.data as { status: string; error: string };
    expect(tile).toMatchObject({ status: 'failed', error: 'timed out' });
    expect(elapsed).toBeLessThan(500);
  });
});
