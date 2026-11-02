import { describe, expect, test } from 'bun:test';
import { ConfigError, loadConfig, renamedEnvVarsInUse } from '../config';

describe('server config contract', () => {
  test('missing DATA_DIR still fails with the variable name', () => {
    expect(() =>
      loadConfig({
        CLIPROXY_BASE_URL: 'http://127.0.0.1:1',
        CLIPROXY_TOKEN: 'stub',
      }),
    ).toThrow(ConfigError);
  });

  test('enhancer config defaults', () => {
    const config = loadConfig({
      CLIPROXY_BASE_URL: 'http://127.0.0.1:1',
      CLIPROXY_TOKEN: 'stub',
      DATA_DIR: '/tmp',
    });
    expect(config.TEXT_MAX_RESPONSE_BYTES).toBe(1 * 1024 * 1024);
    expect(config.TEXT_INFER_MAX_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
  });

  test('enhancer config honors overrides', () => {
    const config = loadConfig({
      CLIPROXY_BASE_URL: 'http://127.0.0.1:1',
      CLIPROXY_TOKEN: 'stub',
      DATA_DIR: '/tmp',
      TEXT_MAX_RESPONSE_BYTES: '2048',
    });
    expect(config.TEXT_MAX_RESPONSE_BYTES).toBe(2048);
  });

  test('the renamed text byte caps still read their old CLIPROXY_ names, and the new names win', () => {
    const base = { DATA_DIR: '/tmp' };
    const legacy = loadConfig({ ...base, CLIPROXY_TEXT_MAX_RESPONSE_BYTES: '4096', CLIPROXY_TEXT_INFER_MAX_RESPONSE_BYTES: '8192' });
    expect(legacy.TEXT_MAX_RESPONSE_BYTES).toBe(4096);
    expect(legacy.TEXT_INFER_MAX_RESPONSE_BYTES).toBe(8192);
    const both = loadConfig({ ...base, CLIPROXY_TEXT_MAX_RESPONSE_BYTES: '4096', TEXT_MAX_RESPONSE_BYTES: '2048' });
    expect(both.TEXT_MAX_RESPONSE_BYTES).toBe(2048);
    expect(renamedEnvVarsInUse({ CLIPROXY_TEXT_MAX_RESPONSE_BYTES: '4096', CLIPROXY_TEXT_INFER_MAX_RESPONSE_BYTES: '' }))
      .toEqual([{ from: 'CLIPROXY_TEXT_MAX_RESPONSE_BYTES', to: 'TEXT_MAX_RESPONSE_BYTES' }]);
  });
});
