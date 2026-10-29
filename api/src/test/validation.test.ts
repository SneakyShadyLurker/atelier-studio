import { describe, expect, test } from 'bun:test';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { testRuntime } from './helpers';

const valid = { prompt: 'x', modelId: 'mock-fast', ratio: '1:1', count: 1 };

describe('route validation', () => {
  test.each([
    [{ ...valid, prompt: '' }],
    [{ ...valid, prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1) }],
    [{ ...valid, modelId: 'nope' }],
    [{ ...valid, modelId: 'mock-slow', ratio: '16:9' }],
    [{ ...valid, count: 0 }],
    [{ ...valid, count: 5 }],
  ])('rejects invalid generate body %#', async (body) => {
    const { app } = testRuntime();
    const res = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('rejects malformed JSON and non-UUID path params', async () => {
    const { app } = testRuntime();
    const malformed = await app.fetch(
      new Request('http://local/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
        body: '{',
      }),
    );
    expect(malformed.status).toBe(400);
    const badPath = await app.fetch(
      new Request('http://local/api/history/not-a-uuid', {
        method: 'DELETE',
        headers: { 'Remote-User': 'test' },
      }),
    );
    expect(badPath.status).toBe(400);
  });
});
