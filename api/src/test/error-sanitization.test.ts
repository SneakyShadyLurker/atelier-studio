import { describe, expect, test } from 'bun:test';
import { redactSecrets } from '../observability/redact';
import { generateEvents, testRuntime } from './helpers';

describe('provider error sanitization', () => {
  test('redacts Google AIza API keys', () => {
    const key = `AIza${'x'.repeat(35)}`;

    const redacted = redactSecrets(`google echoed ${key}`);

    expect(redacted).not.toContain(key);
    expect(redacted).toContain('[redacted]');
  });

  test('raw provider error is absent from logs, SSE and DB', async () => {
    const { app, db, logs } = testRuntime({ LOG_LEVEL: 'error' });
    const events = await generateEvents(app, {
      prompt: 'x',
      modelId: 'mock-fail',
      ratio: '1:1',
      count: 1,
    });
    const tile = events.find((event) => event.event === 'tile')?.data as { error: string };
    expect(tile.error).toBe('internal error');
    expect(JSON.stringify(events)).not.toContain('/home/secret/path');
    const row = db.query<{ error: string }, []>('SELECT error FROM tiles').get();
    expect(row?.error).toBe('internal error');
    expect(JSON.stringify(row)).not.toContain('/home/secret/path');
    expect(logs.join('')).not.toContain('/home/secret/path');
    expect(logs.join('')).toContain('internal error');
  });
});
