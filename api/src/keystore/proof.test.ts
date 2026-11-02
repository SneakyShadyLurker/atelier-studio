import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encrypt, importMasterKey } from '../crypto/aes-gcm';
import { openDb } from '../db/client';
import { migrate } from '../db/migrate';
import { KeystoreProofError, verifyOrSeedKeystoreProof } from './proof';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

interface Harness {
  dataDir: string;
  db: Database;
}

let harness: Harness;

beforeEach(() => {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-keystore-proof-'));
  const db = openDb({ dataDir });
  migrate(db, dataDir);
  harness = { dataDir, db };
});

afterEach(() => {
  harness.db.close();
  rmSync(harness.dataDir, { recursive: true, force: true });
});

describe('verifyOrSeedKeystoreProof', () => {
  test('first boot seeds the sentinel and is idempotent on the next call', async () => {
    const key = await importMasterKey(KEY_A);

    // Pre-state: empty table.
    expect(
      harness.db
        .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM keystore_proof')
        .get()?.c,
    ).toBe(0);

    await verifyOrSeedKeystoreProof(harness.db, key);

    // Post-state: exactly one row, id = 1.
    const rows = harness.db
      .query<{ id: number; ciphertext: Uint8Array; nonce: Uint8Array }, []>(
        'SELECT id, ciphertext, nonce FROM keystore_proof',
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(1);
    expect(rows[0]?.ciphertext.length).toBeGreaterThan(0);
    expect(rows[0]?.nonce.length).toBe(12);

    // Second call under the same key is a no-throw, no-op.
    await verifyOrSeedKeystoreProof(harness.db, key);
    const after = harness.db
      .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM keystore_proof')
      .get()?.c;
    expect(after).toBe(1);
  });

  test('throws KeystoreProofError when the master key was rotated', async () => {
    const keyA = await importMasterKey(KEY_A);
    await verifyOrSeedKeystoreProof(harness.db, keyA);

    const keyB = await importMasterKey(KEY_B);
    let thrown: unknown;
    try {
      await verifyOrSeedKeystoreProof(harness.db, keyB);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KeystoreProofError);
    expect((thrown as KeystoreProofError).message).toContain('BYOK_ENCRYPTION_KEY mismatch');
    expect((thrown as KeystoreProofError).message).toContain('docs/deployment.md');
  });

  test('throws KeystoreProofError when the stored ciphertext is tampered', async () => {
    const key = await importMasterKey(KEY_A);
    await verifyOrSeedKeystoreProof(harness.db, key);

    // Flip the first ciphertext byte — AES-GCM tag will reject.
    const row = harness.db
      .query<{ ciphertext: Uint8Array }, []>('SELECT ciphertext FROM keystore_proof WHERE id = 1')
      .get();
    if (!row) throw new Error('proof row missing after seed');
    const tampered = Uint8Array.from(row.ciphertext);
    const firstByte = tampered[0] ?? 0;
    tampered[0] = firstByte ^ 0xff;
    harness.db.run('UPDATE keystore_proof SET ciphertext = ? WHERE id = 1', [tampered]);

    let thrown: unknown;
    try {
      await verifyOrSeedKeystoreProof(harness.db, key);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KeystoreProofError);
  });

  test('first v17 boot with existing decryptable keys seeds and future boots pass', async () => {
    // Audit T2-002: a deployment that picked up v17 with pre-existing
    // user_provider_keys rows must still seed the proof when the rows are
    // decryptable under the current key (i.e. the "legitimate first v17
    // boot post-data" case).
    const key = await importMasterKey(KEY_A);
    await seedExistingBYOKRow(harness.db, key, 'user-a', 'google-key-1');

    // No proof row yet; pre-existing BYOK rows present and decryptable.
    expect(
      harness.db
        .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM keystore_proof')
        .get()?.c,
    ).toBe(0);

    await verifyOrSeedKeystoreProof(harness.db, key);

    expect(
      harness.db
        .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM keystore_proof')
        .get()?.c,
    ).toBe(1);

    // Future boots with the same key are clean no-ops.
    await verifyOrSeedKeystoreProof(harness.db, key);
  });

  test('first v17 boot with existing UNdecryptable keys throws and does not seed', async () => {
    // Audit T2-002: the bad-rotation case. Pre-existing BYOK rows encrypted
    // under the OLD key; operator boots v17 with the NEW key. Without the
    // guard, this seeds a sentinel under the NEW key and silently blesses
    // an unrecoverable corruption. With the guard, the boot path refuses.
    const oldKey = await importMasterKey(KEY_A);
    await seedExistingBYOKRow(harness.db, oldKey, 'user-a', 'google-key-1');

    const newKey = await importMasterKey(KEY_B);
    let thrown: unknown;
    try {
      await verifyOrSeedKeystoreProof(harness.db, newKey);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(KeystoreProofError);
    expect((thrown as KeystoreProofError).message).toContain('First v17 boot');
    expect((thrown as KeystoreProofError).message).toContain('DELETE FROM');
    expect((thrown as KeystoreProofError).message).toContain('docs/deployment.md');

    // No proof row was created — boot must fail before the seed insert.
    expect(
      harness.db
        .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM keystore_proof')
        .get()?.c,
    ).toBe(0);
  });

  test('concurrent first-boot callers are idempotent (single row preserved)', async () => {
    const key = await importMasterKey(KEY_A);

    await Promise.all([
      verifyOrSeedKeystoreProof(harness.db, key),
      verifyOrSeedKeystoreProof(harness.db, key),
      verifyOrSeedKeystoreProof(harness.db, key),
    ]);

    const count = harness.db
      .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM keystore_proof')
      .get()?.c;
    expect(count).toBe(1);

    // And a subsequent verification still passes against the surviving row.
    await verifyOrSeedKeystoreProof(harness.db, key);
  });
});

async function seedExistingBYOKRow(
  db: Database,
  key: CryptoKey,
  userId: string,
  plaintext: string,
): Promise<void> {
  // Mirror the schema set up by db/migrate so the proof guard's sample
  // SELECT actually finds rows. The fingerprint/key_version/timestamp
  // values are placeholders — the guard reads ciphertext + nonce only.
  db.run('INSERT INTO users (id, created_at) VALUES (?, ?)', [userId, Date.now()]);
  const { ciphertext, nonce } = await encrypt(key, plaintext);
  db.run(
    `INSERT INTO user_provider_keys
       (user_id, provider, ciphertext, nonce, key_version, fingerprint, created_at, updated_at)
     VALUES (?, 'google', ?, ?, 1, ?, ?, ?)`,
    [userId, ciphertext, nonce, 'fp-' + userId, Date.now(), Date.now()],
  );
}
