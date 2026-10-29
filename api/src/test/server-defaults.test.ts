import { describe, expect, test } from 'bun:test';
import { ATELIER_BUN_SERVE_DEFAULTS } from '../server';
import { MAX_UPLOAD_REQUEST_BYTES } from '../routes/uploads';

describe('Bun.serve defaults', () => {
  test('ATELIER_BUN_SERVE_DEFAULTS pins idleTimeout to 0 for SSE safety', () => {
    expect(ATELIER_BUN_SERVE_DEFAULTS.idleTimeout).toBe(0);
  });

  test('ATELIER_BUN_SERVE_DEFAULTS pins maxRequestBodySize to the uploads cap', () => {
    expect(ATELIER_BUN_SERVE_DEFAULTS.maxRequestBodySize).toBe(MAX_UPLOAD_REQUEST_BYTES);
  });

  test('idleTimeout is the literal 0, not a widened number', () => {
    const _defaults: { idleTimeout: 0 } = ATELIER_BUN_SERVE_DEFAULTS;
    // @ts-expect-error -- 1 cannot be assigned to literal 0; locks the field at the type level.
    const _wrong: { idleTimeout: 0 } = { idleTimeout: 1 };
  });
});
