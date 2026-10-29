import { describe, expect, test } from 'bun:test';
import { generateEvents, testRuntime } from './helpers';

describe('structured logging', () => {
  test('request logs include reqId and generation failures include batchId/tileId', async () => {
    const { app, logs } = testRuntime({ LOG_LEVEL: 'info' });
    await generateEvents(app, { prompt: 'x', modelId: 'mock-fail', ratio: '1:1', count: 1 });
    const parsed = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.some((line) => typeof line.reqId === 'string')).toBe(true);
    expect(parsed.some((line) => typeof line.batchId === 'string' && typeof line.tileId === 'string')).toBe(true);
  });
});
