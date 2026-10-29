import { describe, expect, test } from 'bun:test';
import { testRuntime } from '../test/helpers';

describe('health and readiness routes', () => {
  test('/api/health remains public liveness', async () => {
    const rt = testRuntime();

    const res = await rt.fetch('/api/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '0.0.0' });
  });

  test('/api/ready verifies the database path after auth', async () => {
    const rt = testRuntime();

    const res = await rt.fetch('/api/ready', {
      headers: { 'Remote-User': 'healthcheck' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
