import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encrypt, importMasterKey } from '../crypto/aes-gcm';
import { fingerprint, importHmacKey } from '../crypto/fingerprint';
import { migrate } from '../db/migrate';
import { createKeyStore } from './index';

const HEX64 = 'c'.repeat(64);

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-keystore-'));
  const db = new Database(':memory:');
  migrate(db, dataDir);
  db.run(`INSERT INTO users (id, created_at) VALUES ('alice', 1000)`);
  db.run(`INSERT INTO users (id, created_at) VALUES ('bob', 1000)`);
  const masterAesKey = await importMasterKey(HEX64);
  const masterHmacKey = await importHmacKey(HEX64);
  return { db, store: createKeyStore({ db, masterAesKey, masterHmacKey }) };
}

describe('keyStore', () => {
  test('put then load round-trips', async () => {
    const { store } = await setup();
    const put = await store.put('alice', 'google', 'AIzaTOPSECRET');
    expect(put.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(put.updatedAt).toBeGreaterThan(0);

    const loaded = await store.load('alice', 'google');
    expect(loaded?.plaintext).toBe('AIzaTOPSECRET');
    expect(loaded?.fingerprint).toBe(put.fingerprint);
  });

  test('put succeeds when no row exists', async () => {
    const { db, store } = await setup();

    await store.put('alice', 'google', 'AIzaNEW');

    const row = db
      .query<{ c: number }, [string, string]>(
        `SELECT COUNT(*) AS c FROM user_provider_keys WHERE user_id = ? AND provider = ?`,
      )
      .get('alice', 'google');
    expect(row?.c).toBe(1);
    expect(await store.load('alice', 'google')).toMatchObject({ plaintext: 'AIzaNEW' });
  });

  test('load returns null when row missing', async () => {
    const { store } = await setup();
    expect(await store.load('alice', 'google')).toBeNull();
  });

  test('providersFor scopes per-user', async () => {
    const { store } = await setup();
    await store.put('alice', 'google', 'AIzaA');
    expect(await store.providersFor('alice')).toEqual(new Set(['google']));
    expect(await store.providersFor('bob')).toEqual(new Set());
  });

  test('ciphertext cannot be transplanted to another user row', async () => {
    const { db, store } = await setup();
    await store.put('alice', 'google', 'AIzaALICE');
    await store.put('bob', 'google', 'AIzaBOB');
    const aliceRow = db
      .query<{ ciphertext: Uint8Array; nonce: Uint8Array; key_version: number; fingerprint: string }, [string, string]>(
        `SELECT ciphertext, nonce, key_version, fingerprint FROM user_provider_keys WHERE user_id = ? AND provider = ?`,
      )
      .get('alice', 'google');
    if (!aliceRow) throw new Error('expected alice row');
    db.run(
      `UPDATE user_provider_keys
          SET ciphertext = ?, nonce = ?, key_version = ?, fingerprint = ?
        WHERE user_id = ? AND provider = ?`,
      [aliceRow.ciphertext, aliceRow.nonce, aliceRow.key_version, aliceRow.fingerprint, 'bob', 'google'],
    );

    let thrown: unknown;
    try {
      await store.load('bob', 'google');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test('legacy no-AAD rows are upgraded on load before row binding is enforced', async () => {
    const { db, store } = await setup();
    const aesKey = await importMasterKey(HEX64);
    const hmacKey = await importHmacKey(HEX64);
    const legacy = await encrypt(aesKey, 'AIzaLEGACY');
    const legacyFingerprint = await fingerprint(hmacKey, 'AIzaLEGACY');
    db.run(
      `INSERT INTO user_provider_keys
         (user_id, provider, ciphertext, nonce, key_version, fingerprint, created_at, updated_at)
       VALUES (?, 'google', ?, ?, 1, ?, 1, 1)`,
      ['alice', legacy.ciphertext, legacy.nonce, legacyFingerprint],
    );

    const loaded = await store.load('alice', 'google');
    expect(loaded?.plaintext).toBe('AIzaLEGACY');
    const upgraded = db
      .query<{ ciphertext: Uint8Array; nonce: Uint8Array; key_version: number; fingerprint: string }, [string, string]>(
        `SELECT ciphertext, nonce, key_version, fingerprint
           FROM user_provider_keys
          WHERE user_id = ? AND provider = ?`,
      )
      .get('alice', 'google');
    if (!upgraded) throw new Error('expected upgraded row');
    expect(upgraded.key_version).toBe(2);

    db.run(
      `INSERT INTO user_provider_keys
         (user_id, provider, ciphertext, nonce, key_version, fingerprint, created_at, updated_at)
       VALUES (?, 'google', ?, ?, ?, ?, 1, 1)`,
      ['bob', upgraded.ciphertext, upgraded.nonce, upgraded.key_version, upgraded.fingerprint],
    );

    let thrown: unknown;
    try {
      await store.load('bob', 'google');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test('put overwrites atomically (same user, same provider)', async () => {
    const { store } = await setup();
    const first = await store.put('alice', 'google', 'AIzaFIRST');
    const second = await store.put('alice', 'google', 'AIzaSECOND');
    expect(second.fingerprint).not.toBe(first.fingerprint);
    const loaded = await store.load('alice', 'google');
    expect(loaded?.plaintext).toBe('AIzaSECOND');
  });

  test('put succeeds when existing row decrypts under the current master', async () => {
    const { store } = await setup();
    await store.put('alice', 'google', 'AIzaOLD');

    const put = await store.put('alice', 'google', 'AIzaNEW');

    expect(put.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(await store.load('alice', 'google')).toMatchObject({ plaintext: 'AIzaNEW' });
  });

  test('put throws RecoveryRequiredError when existing row was encrypted under a different master', async () => {
    const { db } = await setup();
    const oldAes = await importMasterKey('d'.repeat(64));
    const oldHmac = await importHmacKey('d'.repeat(64));
    const oldStore = createKeyStore({
      db,
      masterAesKey: oldAes,
      masterHmacKey: oldHmac,
    });
    await oldStore.put('alice', 'google', 'AIzaOLD');

    const masterAesKey = await importMasterKey(HEX64);
    const masterHmacKey = await importHmacKey(HEX64);
    const store = createKeyStore({ db, masterAesKey, masterHmacKey });
    let thrown: unknown;
    try {
      await store.put('alice', 'google', 'AIzaNEW');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('RecoveryRequiredError');
    const row = await store.load('alice', 'google').catch(() => null);
    expect(row).toBeNull();
  });

  test('put does not overwrite an undecryptable row created after the initial read', async () => {
    const { db, store } = await setup();
    const oldPlaintext = 'AIzaOLD';
    const oldAes = await importMasterKey('d'.repeat(64));
    const oldHmac = await importHmacKey('d'.repeat(64));
    const oldEncrypted = await encrypt(oldAes, oldPlaintext);
    const oldFingerprint = await fingerprint(oldHmac, oldPlaintext);
    let inserted = false;
    let thrown: unknown;

    try {
      await store.put('alice', 'google', 'AIzaNEW', {
        beforeWrite: () => {
          if (inserted) return;
          inserted = true;
          db.run(
            `INSERT INTO user_provider_keys
               (user_id, provider, ciphertext, nonce, key_version, fingerprint, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              'alice',
              'google',
              oldEncrypted.ciphertext,
              oldEncrypted.nonce,
              1,
              oldFingerprint,
              1000,
              1000,
            ],
          );
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('RecoveryRequiredError');
    let loadError: unknown;
    try {
      await store.load('alice', 'google');
    } catch (err) {
      loadError = err;
    }
    expect(loadError).toBeInstanceOf(Error);
  });

  test('delete is idempotent', async () => {
    const { store } = await setup();
    await store.put('alice', 'google', 'AIzaX');
    await store.delete('alice', 'google');
    await store.delete('alice', 'google');
    expect(await store.load('alice', 'google')).toBeNull();
  });

  test('load throws when ciphertext was encrypted under a different key', async () => {
    const { db } = await setup();
    const altAes = await importMasterKey('d'.repeat(64));
    const altHmac = await importHmacKey('d'.repeat(64));
    const altStore = createKeyStore({
      db,
      masterAesKey: altAes,
      masterHmacKey: altHmac,
    });
    await altStore.put('alice', 'google', 'AIzaX');

    const masterAesKey = await importMasterKey(HEX64);
    const masterHmacKey = await importHmacKey(HEX64);
    const store = createKeyStore({ db, masterAesKey, masterHmacKey });
    let thrown: unknown;
    try {
      await store.load('alice', 'google');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test('touch updates last_used_at', async () => {
    const { db, store } = await setup();
    await store.put('alice', 'google', 'AIzaX');
    await store.touch('alice', 'google');
    const row = db.query<{ last_used_at: number | null }, [string]>(
      `SELECT last_used_at FROM user_provider_keys WHERE user_id = ?`,
    ).get('alice');
    expect(row?.last_used_at).toBeGreaterThan(0);
  });
});
