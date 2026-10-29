import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateEvents, testRuntime } from './helpers';

describe('artifact extension allowlist', () => {
  test('unsupported provider ext fails before bytes touch disk', async () => {
    const { app, config } = testRuntime();
    const events = await generateEvents(app, {
      prompt: 'x',
      modelId: 'mock-gif',
      ratio: '1:1',
      count: 1,
    });
    const tile = events.find((event) => event.event === 'tile')?.data as { status: string; error: string };
    expect(tile).toMatchObject({ status: 'failed', error: 'unsupported format' });
    const dir = join(config.DATA_DIR, 'images');
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
});
