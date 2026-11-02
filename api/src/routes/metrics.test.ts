import { describe, expect, test } from 'bun:test';
import { testRuntime } from '../test/helpers';

function postMetric(
  body: unknown,
  userId?: string,
  options: { rt?: ReturnType<typeof testRuntime>; headers?: Record<string, string> } = {},
): Promise<Response> {
  const rt = options.rt ?? testRuntime();
  const headers = new Headers({ 'content-type': 'application/json' });
  if (userId !== undefined) headers.set('Remote-User', userId);
  for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
  return rt.fetch('/api/_metrics', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/_metrics', () => {
  test('accepts a valid vitals metric', async () => {
    const res = await postMetric(
      {
        kind: 'vitals',
        name: 'LCP',
        value: 1234.5,
        delta: 100,
        id: 'vital-1',
        rating: 'good',
        navigationType: 'navigate',
        href: 'https://atelier.test/',
      },
      'alice',
    );

    expect(res.status).toBe(204);
  });

  test('accepts a valid render error metric', async () => {
    const res = await postMetric(
      {
        kind: 'error',
        name: 'Error',
        message: 'boom',
        stack: 'Error: boom',
        componentStack: 'at ThrowingChild',
        userAgent: 'test-agent',
        href: 'https://atelier.test/',
      },
      'alice',
    );

    expect(res.status).toBe(204);
  });

  test('redacts secret-shaped render error fields before logging', async () => {
    const rt = testRuntime({ LOG_LEVEL: 'info' });
    const googleKey = `AIza${'a'.repeat(35)}`;
    const bearer = `bearer ${'b'.repeat(20)}`;

    const res = await postMetric(
      {
        kind: 'error',
        name: 'Error',
        message: `boom ${googleKey}`,
        stack: `Error: ${bearer}`,
        componentStack: `at Widget (${googleKey})`,
        userAgent: `agent ${bearer}`,
        href: `https://atelier.test/?token=${googleKey}#${bearer}`,
      },
      'alice',
      { rt },
    );

    expect(res.status).toBe(204);
    const rendered = rt.logs.join('\n');
    expect(rendered).toContain('messageChars');
    expect(rendered).not.toContain(googleKey);
    expect(rendered).not.toContain(bearer);
    expect(rendered).not.toContain('?token=');
    expect(rendered).not.toContain('#bearer');
  });

  test('rejects an unknown metric kind', async () => {
    const res = await postMetric({ kind: 'unknown', name: 'LCP', value: 1 }, 'alice');

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'validation failed' });
  });

  test('requires Remote-User', async () => {
    const res = await postMetric({ kind: 'vitals', name: 'CLS', value: 0 });

    expect(res.status).toBe(401);
  });

  test('rejects cross-origin POSTs when CSRF protection is enabled', async () => {
    const rt = testRuntime({ CSRF_PROTECT: 'true' });
    const res = await postMetric(
      { kind: 'vitals', name: 'CLS', value: 0 },
      'alice',
      { rt, headers: { Origin: 'http://attacker.example', Host: 'local' } },
    );

    expect(res.status).toBe(403);
  });

  test('rate-limits rapid metric posts per user', async () => {
    const rt = testRuntime();
    const responses = await Promise.all(Array.from({ length: 30 }, () =>
      postMetric({ kind: 'vitals', name: 'CLS', value: 0 }, 'alice', { rt })));

    expect(responses.some((res) => res.status === 429)).toBe(true);
    expect(responses.filter((res) => res.status === 204).length).toBeGreaterThan(0);
  });
});
