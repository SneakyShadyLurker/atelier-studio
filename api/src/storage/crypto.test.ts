import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateHybridIdentity, identityToRecipient } from 'age-encryption';
import { migrate } from '../db/migrate';
import { rejectionOf } from '../test/helpers';
import {
  DbUserKeyStore,
  MemoryUserKeyStore,
  StorageIntegrityError,
  StorageKeyring,
  StorageRootMismatchError,
  StorageSealedError,
  configureStorageKeyring,
  createUnsealedKeyring,
  hasAgeMagic,
  isStorageSealed,
  verifyOrSeedStorageRoot,
} from './crypto';

async function rootPair(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateHybridIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}

function migratedDb(): Database {
  const db = new Database(':memory:');
  migrate(db, mkdtempSync(join(tmpdir(), 'atelier-crypto-')));
  return db;
}

const never = () => new AbortController().signal;

async function encryptBytes(keyring: StorageKeyring, userId: string, plaintext: Uint8Array): Promise<Uint8Array> {
  return new Response(await keyring.encryptStream(userId, plaintext)).bytes();
}

function decryptBytes(
  keyring: StorageKeyring,
  userId: string,
  ciphertext: Uint8Array,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const path = join(mkdtempSync(join(tmpdir(), 'atelier-crypto-bytes-')), 'a.bin');
  writeFileSync(path, ciphertext);
  return keyring.decryptFileBytes(userId, Bun.file(path), signal);
}

afterEach(() => {
  configureStorageKeyring(null);
});

describe('StorageKeyring', () => {
  test('encrypts per user and round-trips bytes', async () => {
    const keyring = await createUnsealedKeyring(new MemoryUserKeyStore());
    const plaintext = crypto.getRandomValues(new Uint8Array(200_000));
    const ciphertext = await encryptBytes(keyring, 'alice', plaintext);
    expect(hasAgeMagic(ciphertext)).toBe(true);
    expect(Buffer.from(ciphertext).includes(Buffer.from(plaintext.subarray(0, 64)))).toBe(false);
    expect(await decryptBytes(keyring, 'alice', ciphertext, never())).toEqual(plaintext);
  });

  test('round-trips artifacts above the yielding threshold as bytes and as a file stream', async () => {
    const keyring = await createUnsealedKeyring(new MemoryUserKeyStore());
    const plaintext = crypto.getRandomValues(new Uint8Array(65_536)).map((_, index) => index % 251);
    const big = new Uint8Array(3 * 1024 * 1024 + 123);
    for (let offset = 0; offset < big.length; offset += plaintext.length) big.set(plaintext.subarray(0, Math.min(plaintext.length, big.length - offset)), offset);
    const ciphertext = await encryptBytes(keyring, 'alice', big);
    expect(await decryptBytes(keyring, 'alice', ciphertext, never())).toEqual(big);
    const path = join(mkdtempSync(join(tmpdir(), 'atelier-crypto-big-')), 'a.mp4');
    writeFileSync(path, ciphertext);
    const { stream, size } = await keyring.decryptFile('alice', Bun.file(path), never());
    expect(size).toBe(big.length);
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(big);
  });

  test('streams a large encrypted artifact directly to disk with per-user ownership', async () => {
    const keyring = await createUnsealedKeyring(new MemoryUserKeyStore());
    const plaintext = new Uint8Array(8 * 1024 * 1024 + 37).map((_, index) => index % 251);
    const ciphertext = await keyring.encryptStream('alice', plaintext);
    const path = join(mkdtempSync(join(tmpdir(), 'atelier-crypto-stream-')), 'a.mp4');
    await Bun.write(path, new Response(ciphertext));
    const artifact = await keyring.decryptFile('alice', Bun.file(path), never());
    expect(artifact.size).toBe(plaintext.length);
    expect(new Uint8Array(await new Response(artifact.stream).arrayBuffer())).toEqual(plaintext);
    await keyring.recipientFor('bob');
    expect(await rejectionOf(keyring.decryptFile('bob', Bun.file(path), never()))).toBeInstanceOf(StorageIntegrityError);
  });

  test("one user's key cannot decrypt another user's artifact", async () => {
    const keyring = await createUnsealedKeyring(new MemoryUserKeyStore());
    const ciphertext = await encryptBytes(keyring, 'alice', new Uint8Array([1, 2, 3]));
    await keyring.recipientFor('bob');
    expect(await rejectionOf(decryptBytes(keyring, 'bob', ciphertext, never()))).toBeInstanceOf(StorageIntegrityError);
  });

  test('streams a file with its exact plaintext size', async () => {
    const keyring = await createUnsealedKeyring(new MemoryUserKeyStore());
    const plaintext = crypto.getRandomValues(new Uint8Array(3 * 65_536 + 17));
    const path = join(mkdtempSync(join(tmpdir(), 'atelier-crypto-file-')), 'a.png');
    writeFileSync(path, await encryptBytes(keyring, 'alice', plaintext));
    const { stream, size } = await keyring.decryptFile('alice', Bun.file(path), never());
    expect(size).toBe(plaintext.length);
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(plaintext);
  });

  test('a corrupted chunk fails authentication instead of returning bytes', async () => {
    const keyring = await createUnsealedKeyring(new MemoryUserKeyStore());
    const ciphertext = await encryptBytes(keyring, 'alice', new Uint8Array(100_000));
    const tampered = new Uint8Array(ciphertext);
    tampered[tampered.length - 100] = (tampered[tampered.length - 100] ?? 0) ^ 0xff;
    expect(await rejectionOf(decryptBytes(keyring, 'alice', tampered, never()))).toBeInstanceOf(StorageIntegrityError);
  });

  test('strict mode rejects plaintext; legacy mode passes it through', async () => {
    const strict = await createUnsealedKeyring(new MemoryUserKeyStore());
    expect(await rejectionOf(decryptBytes(strict, 'alice', new Uint8Array([137, 80, 78, 71]), never()))).toBeInstanceOf(StorageIntegrityError);
    const legacy = await createUnsealedKeyring(new MemoryUserKeyStore(), { allowPlaintextReads: true });
    expect(await decryptBytes(legacy, 'alice', new Uint8Array([137, 80, 78, 71]), never())).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
  });

  test('writes work while sealed; reads wait for unseal and resume', async () => {
    const root = await rootPair();
    const store = new DbUserKeyStore(migratedDb());
    const first = new StorageKeyring({ rootRecipient: root.recipient, store });
    expect(first.sealed).toBe(true);
    const ciphertext = await encryptBytes(first, 'alice', new Uint8Array([9, 8, 7]));

    // A fresh process: same store, no cached identities, sealed.
    const restarted = new StorageKeyring({ rootRecipient: root.recipient, store });
    let unsealedFired = 0;
    restarted.onUnsealed(() => { unsealedFired++; });
    const pending = decryptBytes(restarted, 'alice', ciphertext, never());
    await Bun.sleep(20);
    expect(await restarted.unseal(root.identity)).toBe('unsealed');
    expect(await pending).toEqual(new Uint8Array([9, 8, 7]));
    expect(unsealedFired).toBe(1);
    expect(await restarted.unseal(root.identity)).toBe('already-unsealed');
    expect(unsealedFired).toBe(1);
  });

  test('a sealed read rejects with StorageSealedError when its signal aborts', async () => {
    const root = await rootPair();
    const keyring = new StorageKeyring({ rootRecipient: root.recipient, store: new MemoryUserKeyStore() });
    const other = new StorageKeyring({ rootRecipient: root.recipient, store: new MemoryUserKeyStore() });
    const ciphertext = await encryptBytes(other, 'alice', new Uint8Array([1]));
    // `keyring` has no key for alice and is sealed: the wait comes first.
    expect(await rejectionOf(decryptBytes(keyring, 'alice', ciphertext, AbortSignal.timeout(10)))).toBeInstanceOf(StorageSealedError);
    // The timed-out waiter is gone: a later unseal resolves nothing stale.
    expect(await keyring.unseal(root.identity)).toBe('unsealed');
  });

  test('unseal rejects the wrong root and malformed input without echoing it', async () => {
    const root = await rootPair();
    const wrong = await rootPair();
    const keyring = new StorageKeyring({ rootRecipient: root.recipient, store: new MemoryUserKeyStore() });
    const wrongError = await keyring.unseal(wrong.identity).catch((error: unknown) => error);
    expect(wrongError).toBeInstanceOf(StorageRootMismatchError);
    expect((wrongError as Error).message).not.toContain(wrong.identity);
    expect(await rejectionOf(keyring.unseal('not a key'))).toBeInstanceOf(StorageRootMismatchError);
    expect(keyring.sealed).toBe(true);
  });

  test('concurrent first writes for a user create exactly one durable key', async () => {
    const root = await rootPair();
    const db = migratedDb();
    const keyring = new StorageKeyring({ rootRecipient: root.recipient, store: new DbUserKeyStore(db) });
    const recipients = await Promise.all([1, 2, 3, 4].map(() => keyring.recipientFor('alice')));
    expect(new Set(recipients).size).toBe(1);
    expect(db.query('SELECT COUNT(*) AS n FROM user_storage_keys').get()).toEqual({ n: 1 });
    expect(db.query('SELECT id FROM users').all()).toEqual([{ id: 'alice' }]);
    expect(db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous).toBe(1);
  });

  test('verifyUserKeys reports undecryptable stored identities by user id only', async () => {
    const root = await rootPair();
    const db = migratedDb();
    const store = new DbUserKeyStore(db);
    const keyring = new StorageKeyring({ rootRecipient: root.recipient, store });
    await keyring.recipientFor('alice');
    db.run("INSERT INTO users (id, created_at) VALUES ('mallory', 1)");
    db.run("INSERT INTO user_storage_keys (user_id, recipient, wrapped_identity, created_at) VALUES ('mallory', 'age1x', x'00', 1)");
    await keyring.unseal(root.identity);
    expect(await keyring.verifyUserKeys(never())).toEqual({ checked: 2, failed: ['mallory'] });
  });
});

describe('storage root binding', () => {
  test('seeds on first boot and refuses a different root afterwards', () => {
    const db = migratedDb();
    verifyOrSeedStorageRoot(db, 'age1pq1first');
    expect(() => { verifyOrSeedStorageRoot(db, 'age1pq1first'); }).not.toThrow();
    expect(() => { verifyOrSeedStorageRoot(db, 'age1pq1second'); }).toThrow(StorageRootMismatchError);
  });
});

describe('seal state for dispatch gating', () => {
  test('unconfigured keyring never reports sealed', async () => {
    expect(isStorageSealed()).toBe(false);
    const root = await rootPair();
    const keyring = new StorageKeyring({ rootRecipient: root.recipient, store: new MemoryUserKeyStore() });
    configureStorageKeyring(keyring);
    expect(isStorageSealed()).toBe(true);
    await keyring.unseal(root.identity);
    expect(isStorageSealed()).toBe(false);
  });
});
