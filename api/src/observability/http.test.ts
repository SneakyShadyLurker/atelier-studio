import { describe, expect, test } from 'bun:test';
import { testRuntime } from '../test/helpers';

describe('requestLogger', () => {
  test('echoes the client request id for log correlation', async () => {
    const rt = testRuntime();

    const response = await rt.fetch('/api/health', {
      headers: { 'X-Request-Id': 'client-req-123' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Request-Id')).toBe('client-req-123');
  });
});
