import { describe, expect, it } from 'bun:test';
import { MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_INPUT_BYTES } from '../src/index';

describe('upload size constants', () => {
  it('input ceiling is 50 MB and exceeds the stored cap', () => {
    expect(MAX_UPLOAD_INPUT_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_UPLOAD_INPUT_BYTES).toBeGreaterThan(MAX_UPLOAD_FILE_BYTES);
  });
});
