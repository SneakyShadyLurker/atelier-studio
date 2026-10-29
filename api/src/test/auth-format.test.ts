import { describe, expect, test } from 'bun:test';
import { USER_ID_PATTERN } from '../user-id';
import { testRuntime } from './helpers';

describe('Remote-User format', () => {
  test.each(['bad user', 'bad/slash', 'x\u0001y', 'a'.repeat(257)])(
    'rejects malformed value %#',
    async (user) => {
      const { app, logs } = testRuntime({ LOG_LEVEL: 'warn' });
      const res = await app.fetch(new Request('http://local/api/models', { headers: { 'Remote-User': user } }));
      expect(res.status).toBe(401);
      expect(logs.join('')).toContain('malformed Remote-User');
    },
  );

  test('regex rejects CR/LF before a proxy can pass header injection through', () => {
    expect(USER_ID_PATTERN.test('x\nInject: y')).toBe(false);
    expect(USER_ID_PATTERN.test('x\ry')).toBe(false);
  });
});
