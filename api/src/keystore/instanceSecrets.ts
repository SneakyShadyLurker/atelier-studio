import { decrypt, encrypt, importMasterKey } from '../crypto/aes-gcm';
import { fingerprint, importHmacKey } from '../crypto/fingerprint';

// Instance-wide credentials of admin-managed text providers. Same master keys
// and AES-GCM as the per-user BYOK keystore, but the ciphertext lives on the
// `text_providers` row and the AAD binds it to that row's id, so a secret
// copied onto another provider never decrypts.

/** Matches the keystore's AAD-bound row version. */
export const TEXT_SECRET_KEY_VERSION = 2;

/** Saving a provider key needs `BYOK_ENCRYPTION_KEY`; routes answer 503 `byok-not-configured`. */
export class ByokNotConfiguredError extends Error {
  override readonly name = 'ByokNotConfiguredError';
  readonly code = 'byok-not-configured' as const;

  constructor() {
    super('BYOK_ENCRYPTION_KEY is not set, so provider API keys cannot be stored or read.');
  }
}

/**
 * A stored provider key no longer decrypts (master key rotated, row tampered or
 * moved). Recovery is to replace or remove the key on that provider.
 */
export class TextSecretUnreadableError extends Error {
  override readonly name = 'TextSecretUnreadableError';

  constructor(readonly providerId: string) {
    super('The stored API key for this text provider cannot be decrypted with the current BYOK_ENCRYPTION_KEY. Enter the key again or remove it.');
  }
}

export interface SealedTextSecret {
  readonly ciphertext: Uint8Array<ArrayBuffer>;
  readonly nonce: Uint8Array<ArrayBuffer>;
  readonly keyVersion: number;
  readonly fingerprint: string;
}

export interface TextSecrets {
  /** Encrypts a credential bound to `providerId`. */
  seal(providerId: string, plaintext: string): Promise<SealedTextSecret>;
  /** Decrypts and checks the fingerprint; throws TextSecretUnreadableError. */
  open(providerId: string, sealed: SealedTextSecret): Promise<string>;
  fingerprint(plaintext: string): Promise<string>;
}

export interface TextSecretsDeps {
  masterAesKey: CryptoKey | Promise<CryptoKey>;
  masterHmacKey: CryptoKey | Promise<CryptoKey>;
}

function providerAad(providerId: string): Uint8Array {
  return new TextEncoder().encode(`atelier-text-provider/v1\0${providerId}`);
}

export function createTextSecrets(deps: TextSecretsDeps): TextSecrets {
  const masterAesKey = Promise.resolve(deps.masterAesKey);
  const masterHmacKey = Promise.resolve(deps.masterHmacKey);
  return {
    async seal(providerId, plaintext) {
      const { ciphertext, nonce } = await encrypt(await masterAesKey, plaintext, providerAad(providerId));
      return {
        ciphertext,
        nonce,
        keyVersion: TEXT_SECRET_KEY_VERSION,
        fingerprint: await fingerprint(await masterHmacKey, plaintext),
      };
    },

    async open(providerId, sealed) {
      let plaintext: string;
      try {
        plaintext = await decrypt(
          await masterAesKey,
          { ciphertext: sealed.ciphertext, nonce: sealed.nonce },
          providerAad(providerId),
        );
      } catch {
        throw new TextSecretUnreadableError(providerId);
      }
      if (await fingerprint(await masterHmacKey, plaintext) !== sealed.fingerprint) {
        throw new TextSecretUnreadableError(providerId);
      }
      return plaintext;
    },

    async fingerprint(plaintext) {
      return fingerprint(await masterHmacKey, plaintext);
    },
  };
}

/** Text secrets for `BYOK_ENCRYPTION_KEY`, or undefined when it is unset. */
export function createTextSecretsForKey(masterKeyHex: string | undefined): TextSecrets | undefined {
  if (!masterKeyHex) return undefined;
  return createTextSecrets({
    masterAesKey: importMasterKey(masterKeyHex),
    masterHmacKey: importHmacKey(masterKeyHex),
  });
}
