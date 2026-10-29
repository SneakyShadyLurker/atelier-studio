import { describe, expect, test } from 'bun:test';
import { ConfigError, loadConfig } from '../config';

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
    expect(config.CLIPROXY_TEXT_MAX_RESPONSE_BYTES).toBe(1 * 1024 * 1024);
    expect(config.CLIPROXY_TEXT_INFER_MAX_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
  });

  test('enhancer config honors overrides', () => {
    const config = loadConfig({
      CLIPROXY_BASE_URL: 'http://127.0.0.1:1',
      CLIPROXY_TOKEN: 'stub',
      DATA_DIR: '/tmp',
      CLIPROXY_TEXT_MAX_RESPONSE_BYTES: '2048',
    });
    expect(config.CLIPROXY_TEXT_MAX_RESPONSE_BYTES).toBe(2048);
  });
});
