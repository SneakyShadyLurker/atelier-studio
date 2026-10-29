import type { Database } from 'bun:sqlite';
import { decrypt, encrypt } from '../crypto/aes-gcm';

// Sentinel plaintext encrypted under the current master key and persisted in
// the single-row `keystore_proof` table. On every subsequent boot we attempt
// to decrypt the stored ciphertext with the current master key. Mismatch
// (rotated key, corrupt blob) → KeystoreProofError. The string value is
// arbitrary; only the round-trip property matters. Versioned so a future
// re-seed can be distinguished from drift without breaking the wire format.
const KEYSTORE_PROOF_SENTINEL = 'atelier-keystore-proof-v1';

export class KeystoreProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeystoreProofError';
  }
}

interface ProofRow {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

interface UserProviderKeyRow {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

// Verify the keystore master key has not been rotated since the last boot.
//
// First boot (empty table) seeds the row with a sentinel encrypted under the
// current `BYOK_ENCRYPTION_KEY`. Every subsequent boot attempts to decrypt
// the stored sentinel: success → continue; AES-GCM tag mismatch (rotated
// key, tampered ciphertext) → throw KeystoreProofError so the boot path
// exits 1 instead of presenting a misleading per-request "NEEDS_GOOGLE_KEY"
// to every BYOK user.
//
// Does NOT recover the actual stored keys; rotation is still unrecoverable
// (see docs/deployment.md § BYOK master-key loss). This is a
// detection-only guard so operators see a clear signal.
export async function verifyOrSeedKeystoreProof(
  db: Database,
  masterAesKey: CryptoKey,
): Promise<void> {
  const row = db
    .query<ProofRow, []>('SELECT ciphertext, nonce FROM keystore_proof WHERE id = 1')
    .get();

  if (!row) {
    // First v17 boot: if there are pre-existing BYOK rows from before the
    // proof table existed, the current master key MUST be able to decrypt
    // them — otherwise seeding now would "bless" the wrong key and every
    // BYOK user would silently 401 against Google forever. Audit T2-002.
    const sample = db
      .query<UserProviderKeyRow, []>(
        'SELECT ciphertext, nonce FROM user_provider_keys LIMIT 1',
      )
      .get();
    if (sample) {
      try {
        await decrypt(masterAesKey, {
          ciphertext: Uint8Array.from(sample.ciphertext),
          nonce: Uint8Array.from(sample.nonce),
        });
      } catch {
        throw new KeystoreProofError(
          'First v17 boot detected pre-existing BYOK keys that cannot be decrypted with the ' +
            'current BYOK_ENCRYPTION_KEY. If you rotated the key, restore the previous value; ' +
            'if you intentionally want to reset BYOK, run: DELETE FROM keystore_proof; ' +
            'DELETE FROM user_provider_keys; (see docs/deployment.md § BYOK master-key loss).',
        );
      }
    }
    const { ciphertext, nonce } = await encrypt(masterAesKey, KEYSTORE_PROOF_SENTINEL);
    // INSERT OR IGNORE handles the (theoretical) concurrent-first-boot race:
    // two callers see the empty table, both encrypt a fresh sentinel, one
    // wins the INSERT, the other becomes a no-op. The CHECK(id=1) keeps the
    // table single-row regardless of caller count.
    db.run(
      `INSERT OR IGNORE INTO keystore_proof (id, ciphertext, nonce, key_version, created_at)
       VALUES (1, ?, ?, ?, ?)`,
      [ciphertext, nonce, 1, Date.now()],
    );
    return;
  }

  try {
    const decrypted = await decrypt(masterAesKey, {
      ciphertext: Uint8Array.from(row.ciphertext),
      nonce: Uint8Array.from(row.nonce),
    });
    if (decrypted !== KEYSTORE_PROOF_SENTINEL) {
      // Decrypt succeeded but the plaintext is unexpected — either a future
      // sentinel format we don't know how to read or an attacker who swapped
      // the row with their own ciphertext under the current key. Refuse to
      // boot rather than continue with an unknown trust posture.
      throw new KeystoreProofError(
        'BYOK_ENCRYPTION_KEY mismatch: stored keystore_proof decrypts to an unexpected sentinel. ' +
          'See docs/deployment.md § BYOK master-key loss.',
      );
    }
  } catch (err) {
    if (err instanceof KeystoreProofError) throw err;
    throw new KeystoreProofError(
      'BYOK_ENCRYPTION_KEY mismatch: stored ciphertext cannot be decrypted with the current key. ' +
        'Did you rotate without re-encrypting? See docs/deployment.md § BYOK master-key loss.',
    );
  }
}
