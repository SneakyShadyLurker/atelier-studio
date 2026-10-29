import { describe, test, expect } from 'bun:test';
import { encrypt, decrypt, importMasterKey } from './aes-gcm';

const HEX64 = 'a'.repeat(64);

async function expectRejects(operation: Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await operation;
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
}

describe('aes-gcm', () => {
  test('round-trips a string', async () => {
    const key = await importMasterKey(HEX64);
    const { ciphertext, nonce } = await encrypt(key, 'AIza-secret-payload');
    expect(ciphertext.byteLength).toBeGreaterThanOrEqual(
      'AIza-secret-payload'.length + 16, // gcm tag is 16 bytes
    );
    expect(nonce.byteLength).toBe(12);

    const recovered = await decrypt(key, { ciphertext, nonce });
    expect(recovered).toBe('AIza-secret-payload');
  });

  test('two encrypts of the same plaintext yield distinct ciphertexts', async () => {
    const key = await importMasterKey(HEX64);
    const a = await encrypt(key, 'same');
    const b = await encrypt(key, 'same');
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  test('decrypt with wrong key throws', async () => {
    const k1 = await importMasterKey(HEX64);
    const k2 = await importMasterKey('b'.repeat(64));
    const { ciphertext, nonce } = await encrypt(k1, 'secret');
    await expectRejects(decrypt(k2, { ciphertext, nonce }));
  });

  test('importMasterKey rejects non-hex / wrong length', async () => {
    await expectRejects(importMasterKey('not-hex'));
    await expectRejects(importMasterKey('a'.repeat(63)));
    await expectRejects(importMasterKey('a'.repeat(65)));
  });
});
