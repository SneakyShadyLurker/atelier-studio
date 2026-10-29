import type { Database } from 'bun:sqlite';
import type { ByokProvider } from '@atelier/shared';
import { decrypt, encrypt } from '../crypto/aes-gcm';
import { fingerprint } from '../crypto/fingerprint';

// Rows written with this version use AES-GCM additionalData to bind encrypted
// key material to (user_id, provider). This is not a master-key rotation
// mechanism: the store still has one masterAesKey, and rotating
// BYOK_ENCRYPTION_KEY remains unrecoverable (see docs/deployment.md § BYOK master-key
// loss). Legacy key_version=1 rows are upgraded lazily on successful load.
const AAD_KEY_VERSION = 2;

export const RECOVERY_REQUIRED_MESSAGE = 'The previously-stored BYOK key cannot be decrypted with the current master key. The master key has been rotated since this row was written. Delete the existing key (DELETE /api/keys/<provider>) to acknowledge that the historical batches BYOK association is permanently lost.';

export class RecoveryRequiredError extends Error {
  override readonly name = 'RecoveryRequiredError';

  constructor(
    readonly userId: string,
    readonly provider: ByokProvider,
  ) {
    super(RECOVERY_REQUIRED_MESSAGE);
  }
}

export interface KeyStoreDeps {
  db: Database;
  masterAesKey: CryptoKey | Promise<CryptoKey>;
  masterHmacKey: CryptoKey | Promise<CryptoKey>;
}

export interface KeyStore {
  providersFor(userId: string): Promise<Set<ByokProvider>>;
  load(
    userId: string,
    provider: ByokProvider,
  ): Promise<{ plaintext: string; fingerprint: string } | null>;
  /**
   * Stores or rotates a user's provider key only after proving any existing
   * row still decrypts with the current BYOK master key. If an existing row is
   * undecryptable, the store refuses to overwrite it and raises
   * RecoveryRequiredError so the caller can force explicit DELETE-then-PUT
   * recovery instead of silently blessing a rotated master key.
   */
  put(
    userId: string,
    provider: ByokProvider,
    plaintext: string,
    options?: { beforeWrite?: () => void },
  ): Promise<{ fingerprint: string; updatedAt: number }>;
  delete(userId: string, provider: ByokProvider): Promise<void>;
  touch(userId: string, provider: ByokProvider): Promise<void>;
}

interface DbKeyRow {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  key_version: number;
  fingerprint: string;
}

interface KeyRow {
  ciphertext: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  keyVersion: number;
  fingerprint: string;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameRow(a: KeyRow | null, b: KeyRow | null): boolean {
  if (!a || !b) return a === b;
  return a.fingerprint === b.fingerprint
    && a.keyVersion === b.keyVersion
    && sameBytes(a.ciphertext, b.ciphertext)
    && sameBytes(a.nonce, b.nonce);
}

function rowAad(userId: string, provider: ByokProvider): Uint8Array {
  return new TextEncoder().encode(`atelier-byok/v1\0${userId}\0${provider}`);
}

async function decryptRow(
  key: CryptoKey,
  userId: string,
  provider: ByokProvider,
  row: Pick<KeyRow, 'ciphertext' | 'nonce' | 'keyVersion'>,
): Promise<{ plaintext: string; legacy: boolean }> {
  try {
    return {
      plaintext: await decrypt(key, {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
      }, rowAad(userId, provider)),
      legacy: false,
    };
  } catch (aadError) {
    if (row.keyVersion >= AAD_KEY_VERSION) throw aadError;
    try {
      return {
        plaintext: await decrypt(key, {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
        }),
        legacy: true,
      };
    } catch {
      throw aadError;
    }
  }
}

async function encryptAadRow(
  key: CryptoKey,
  userId: string,
  provider: ByokProvider,
  plaintext: string,
): Promise<{ ciphertext: Uint8Array<ArrayBuffer>; nonce: Uint8Array<ArrayBuffer> }> {
  return encrypt(key, plaintext, rowAad(userId, provider));
}

function keyRowFromDb(row: DbKeyRow): KeyRow {
  return {
    ciphertext: copyBytes(row.ciphertext),
    nonce: copyBytes(row.nonce),
    keyVersion: row.key_version,
    fingerprint: row.fingerprint,
  };
}

async function assertFingerprint(
  key: CryptoKey,
  plaintext: string,
  expected: string,
): Promise<void> {
  const actual = await fingerprint(key, plaintext);
  if (actual !== expected) throw new Error('BYOK key fingerprint mismatch');
}

export function createKeyStore(deps: KeyStoreDeps): KeyStore {
  const { db } = deps;
  const masterAesKey = Promise.resolve(deps.masterAesKey);
  const masterHmacKey = Promise.resolve(deps.masterHmacKey);
  const readRow = (userId: string, provider: ByokProvider): KeyRow | null => {
    const row = db
      .query<DbKeyRow, [string, ByokProvider]>(
        `SELECT ciphertext, nonce, key_version, fingerprint
           FROM user_provider_keys
          WHERE user_id = ? AND provider = ?`,
      )
      .get(userId, provider);
    return row ? keyRowFromDb(row) : null;
  };

  const upgradeLegacyRow = async (
    aesKey: CryptoKey,
    userId: string,
    provider: ByokProvider,
    row: KeyRow,
    plaintext: string,
  ): Promise<void> => {
    const { ciphertext, nonce } = await encryptAadRow(aesKey, userId, provider, plaintext);
    const now = Date.now();
    db.transaction(() => {
      const current = readRow(userId, provider);
      if (!sameRow(current, row)) return;
      db.run(
        `UPDATE user_provider_keys
            SET ciphertext = ?,
                nonce = ?,
                key_version = ?,
                updated_at = ?
          WHERE user_id = ? AND provider = ?`,
        [ciphertext, nonce, AAD_KEY_VERSION, now, userId, provider],
      );
    })();
  };

  const loadPlaintext = async (
    aesKey: CryptoKey,
    hmacKey: CryptoKey,
    userId: string,
    provider: ByokProvider,
    row: KeyRow,
    upgradeLegacy: boolean,
  ): Promise<string> => {
    const decrypted = await decryptRow(aesKey, userId, provider, row);
    await assertFingerprint(hmacKey, decrypted.plaintext, row.fingerprint);
    if (upgradeLegacy && decrypted.legacy) {
      await upgradeLegacyRow(aesKey, userId, provider, row, decrypted.plaintext);
    }
    return decrypted.plaintext;
  };

  return {
    providersFor(userId) {
      const rows = db
        .query<{ provider: ByokProvider }, [string]>(
          `SELECT provider FROM user_provider_keys WHERE user_id = ?`,
        )
        .all(userId);
      return Promise.resolve(new Set(rows.map((row) => row.provider)));
    },

    async load(userId, provider) {
      const row = readRow(userId, provider);
      if (!row) {
        return null;
      }

      const plaintext = await loadPlaintext(
        await masterAesKey,
        await masterHmacKey,
        userId,
        provider,
        row,
        true,
      );
      return { plaintext, fingerprint: row.fingerprint };
    },

    async put(userId, provider, plaintext, options) {
      const aesKey = await masterAesKey;
      const hmacKey = await masterHmacKey;

      // A present row that no longer decrypts under the current master key
      // means the key rotated/was lost: refuse the silent overwrite and force
      // an explicit DELETE-then-PUT. Checked both at the top of each CAS
      // attempt and on the post-loop fallthrough.
      const assertExistingDecryptsOrRecovery = async (existing: ReturnType<typeof readRow>): Promise<void> => {
        if (!existing) return;
        try {
          await loadPlaintext(aesKey, hmacKey, userId, provider, existing, false);
        } catch {
          throw new RecoveryRequiredError(userId, provider);
        }
      };

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const existing = readRow(userId, provider);
        await assertExistingDecryptsOrRecovery(existing);

        const { ciphertext, nonce } = await encryptAadRow(aesKey, userId, provider, plaintext);
        const keyFingerprint = await fingerprint(hmacKey, plaintext);
        const now = Date.now();

        const write = () => {
          options?.beforeWrite?.();
          const current = readRow(userId, provider);
          if (!sameRow(current, existing)) return false;
          db.run(
            `INSERT INTO user_provider_keys
               (user_id, provider, ciphertext, nonce, key_version, fingerprint, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, provider) DO UPDATE SET
               ciphertext = excluded.ciphertext,
               nonce = excluded.nonce,
               key_version = excluded.key_version,
               fingerprint = excluded.fingerprint,
               updated_at = excluded.updated_at`,
            [
              userId,
              provider,
              ciphertext,
              nonce,
              AAD_KEY_VERSION,
              keyFingerprint,
              now,
              now,
            ],
          );
          return true;
        };

        const wrote = db.transaction(write)();
        if (wrote) {
          return { fingerprint: keyFingerprint, updatedAt: now };
        }
      }

      await assertExistingDecryptsOrRecovery(readRow(userId, provider));
      throw new Error('BYOK key row changed during put; retry the request');
    },

    delete(userId, provider) {
      db.run(
        `DELETE FROM user_provider_keys WHERE user_id = ? AND provider = ?`,
        [userId, provider],
      );
      return Promise.resolve();
    },

    touch(userId, provider) {
      db.run(
        `UPDATE user_provider_keys
            SET last_used_at = ?
          WHERE user_id = ? AND provider = ?`,
        [Date.now(), userId, provider],
      );
      return Promise.resolve();
    },
  };
}
