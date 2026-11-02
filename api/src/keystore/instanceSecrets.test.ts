import { describe, expect, test } from 'bun:test';
import { fingerprint, importHmacKey } from '../crypto/fingerprint';
import {
  ByokNotConfiguredError,
  createTextSecretsForKey,
  TEXT_SECRET_KEY_VERSION,
  TextSecretUnreadableError,
} from './instanceSecrets';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

function secretsFor(hex: string) {
  const secrets = createTextSecretsForKey(hex);
  if (!secrets) throw new Error('expected text secrets');
  return secrets;
}

describe('text provider instance secrets', () => {
  test('seal then open round-trips for the same provider id', async () => {
    const secrets = secretsFor(HEX_A);
    const sealed = await secrets.seal('provider-1', 'sk-TOPSECRET');

    expect(sealed.keyVersion).toBe(TEXT_SECRET_KEY_VERSION);
    expect(sealed.nonce.byteLength).toBe(12);
    expect(Buffer.from(sealed.ciphertext).toString('utf8')).not.toContain('TOPSECRET');
    expect(await secrets.open('provider-1', sealed)).toBe('sk-TOPSECRET');
  });

  test('a ciphertext moved to another provider id fails the AAD check', async () => {
    const secrets = secretsFor(HEX_A);
    const sealed = await secrets.seal('provider-1', 'sk-TOPSECRET');

    const error = await secrets.open('provider-2', sealed).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TextSecretUnreadableError);
    expect((error as TextSecretUnreadableError).providerId).toBe('provider-2');
  });

  test('a different master key cannot open the secret', async () => {
    const sealed = await secretsFor(HEX_A).seal('provider-1', 'sk-TOPSECRET');
    const error = await secretsFor(HEX_B).open('provider-1', sealed).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TextSecretUnreadableError);
  });

  test('the fingerprint matches the shared HMAC helper', async () => {
    const secrets = secretsFor(HEX_A);
    const expected = await fingerprint(await importHmacKey(HEX_A), 'sk-TOPSECRET');

    expect(await secrets.fingerprint('sk-TOPSECRET')).toBe(expected);
    expect((await secrets.seal('provider-1', 'sk-TOPSECRET')).fingerprint).toBe(expected);
  });

  test('a tampered fingerprint is refused on open', async () => {
    const secrets = secretsFor(HEX_A);
    const sealed = await secrets.seal('provider-1', 'sk-TOPSECRET');
    const error = await secrets
      .open('provider-1', { ...sealed, fingerprint: '0000000000000000' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TextSecretUnreadableError);
  });

  test('no master key configured means no secrets', () => {
    expect(createTextSecretsForKey(undefined)).toBeUndefined();
    expect(createTextSecretsForKey('')).toBeUndefined();
  });

  test('ByokNotConfiguredError carries the public error code', () => {
    const error = new ByokNotConfiguredError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ByokNotConfiguredError');
    expect(error.code).toBe('byok-not-configured');
  });
});
