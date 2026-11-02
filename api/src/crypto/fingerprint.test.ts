import { describe, test, expect } from 'bun:test';
import { fingerprint, importHmacKey } from './fingerprint';

const HEX64 = 'a'.repeat(64);

describe('fingerprint', () => {
  test('returns a 16-hex-char string', async () => {
    const key = await importHmacKey(HEX64);
    const fp = await fingerprint(key, 'AIza-some-plaintext');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  test('is stable across calls with the same plaintext + master', async () => {
    const key = await importHmacKey(HEX64);
    const a = await fingerprint(key, 'AIza');
    const b = await fingerprint(key, 'AIza');
    expect(a).toBe(b);
  });

  test('differs across plaintexts', async () => {
    const key = await importHmacKey(HEX64);
    const a = await fingerprint(key, 'AIza-1');
    const b = await fingerprint(key, 'AIza-2');
    expect(a).not.toBe(b);
  });

  test('differs across master keys', async () => {
    const k1 = await importHmacKey(HEX64);
    const k2 = await importHmacKey('b'.repeat(64));
    const a = await fingerprint(k1, 'same');
    const b = await fingerprint(k2, 'same');
    expect(a).not.toBe(b);
  });
});
