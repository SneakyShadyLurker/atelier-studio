import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateHybridIdentity, identityToRecipient } from 'age-encryption';
import { openDb } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { DbUserKeyStore, StorageKeyring, configureStorageKeyring } from '../src/storage/crypto';
import { DATA_VOLUME_MARKER } from '../src/storage/encryptionBoot';
import { readArtifactBytes } from '../src/storage/files';
import { EncryptMigrationError, runEncryptMigration } from './encrypt-migrate';
import { rejectionOf } from '../src/test/helpers';

const dir = (label: string) => mkdtempSync(join(tmpdir(), `atelier-encmig-${label}-`));
const quiet = () => undefined;

// A pre-encryption production layout: plaintext files next to a WAL database
// at schema 44-or-later, with archived and live batches (rowid gaps after
// deletes exercise the FTS re-sync).
function seedPlaintextSource(): { source: string; tileId: string; uploadId: string; image: Uint8Array } {
  const source = dir('src');
  const db = openDb({ dataDir: source });
  migrate(db, source);
  db.run("INSERT INTO users (id, created_at) VALUES ('alice', 1), ('bob', 1)");
  const tileId = crypto.randomUUID();
  const uploadId = crypto.randomUUID();
  for (const [index, batchId] of ['b0', 'b1', 'b2'].entries()) {
    db.query(
      `INSERT INTO batches (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, archived_at)
       VALUES (?, 'alice', ?, '1:1', 'mock-fast', 'Mock', 1, 'done', 'shared', ?)`,
    ).run(batchId, `prompt ${index}`, index === 1 ? 5 : null);
  }
  db.run("DELETE FROM batches WHERE id = 'b0'");
  db.query(
    `INSERT INTO tiles (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at)
     VALUES (?, 'b2', 'alice', 0, 1, 'done', 'png', 'image/png', 1)`,
  ).run(tileId);
  db.query(
    `INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at)
     VALUES (?, 'bob', 'webp', 'image/webp', 3, 1, 1, 'x', 1)`,
  ).run(uploadId);
  db.close();

  const image = crypto.getRandomValues(new Uint8Array(150_000));
  mkdirSync(join(source, 'images', 'alice'), { recursive: true });
  mkdirSync(join(source, 'uploads', 'bob'), { recursive: true });
  mkdirSync(join(source, 'thumbs', 'alice'), { recursive: true });
  writeFileSync(join(source, 'images', 'alice', `${tileId}.png`), image);
  writeFileSync(join(source, 'uploads', 'bob', `${uploadId}.webp`), new Uint8Array([7, 7, 7]));
  writeFileSync(join(source, 'thumbs', 'alice', `${tileId}.webp`), new Uint8Array([1, 2]));
  writeFileSync(join(source, 'images', 'alice', 'leftover.png.tmp'), new Uint8Array([0]));
  writeFileSync(join(source, 'scratch.sqlite'), new Uint8Array([0]));
  return { source, tileId, uploadId, image };
}

async function rootPair() {
  const identity = await generateHybridIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}

afterEach(() => {
  configureStorageKeyring(null);
});

describe('encrypt-migrate', () => {
  test('encrypts and verifies every artifact, re-syncs the prompt index, and writes the marker last', async () => {
    const { source, tileId, uploadId, image } = seedPlaintextSource();
    const dest = dir('dest');
    const root = await rootPair();

    const summary = await runEncryptMigration({ source, dest, rootRecipient: root.recipient, log: quiet });
    expect(summary).toMatchObject({ users: 2, files: { images: 1, uploads: 1, thumbs: 1 }, batches: 2, tiles: 1 });

    const marker = JSON.parse(readFileSync(join(dest, DATA_VOLUME_MARKER), 'utf8')) as { users: number };
    expect(marker.users).toBe(2);
    expect(existsSync(join(dest, 'scratch.sqlite'))).toBe(false);
    expect(existsSync(join(dest, 'images', 'alice', 'leftover.png.tmp'))).toBe(false);
    for (const path of [
      join(dest, 'images', 'alice', `${tileId}.png`),
      join(dest, 'uploads', 'bob', `${uploadId}.webp`),
      join(dest, 'thumbs', 'alice', `${tileId}.webp`),
    ]) {
      expect(readFileSync(path, 'utf8').startsWith('age-encryption.org/v1\n')).toBe(true);
    }

    // A later process holding only the root identity reads everything back.
    const db = new Database(join(dest, 'atelier.sqlite'));
    try {
      const keyring = new StorageKeyring({ rootRecipient: root.recipient, store: new DbUserKeyStore(db) });
      await keyring.unseal(root.identity);
      configureStorageKeyring(keyring);
      const signal = AbortSignal.timeout(5_000);
      expect((await readArtifactBytes(dest, 'images', 'alice', tileId, 'png', 'image/png', { signal }))?.bytes).toEqual(image);
      expect((await readArtifactBytes(dest, 'uploads', 'bob', uploadId, 'webp', 'image/webp', { signal }))?.bytes)
        .toEqual(new Uint8Array([7, 7, 7]));
      expect(db.query('SELECT recipient FROM storage_root').get()).toEqual({ recipient: root.recipient });
      const fts = db.query<{ batch_id: string }, [string]>(
        'SELECT batch_id FROM batch_prompt_fts WHERE batch_prompt_fts MATCH ?',
      ).all('prompt');
      expect(fts.map((row) => row.batch_id)).toEqual(['b2']);
    } finally {
      db.close();
    }
  });

  test('refuses a non-empty destination', async () => {
    const { source } = seedPlaintextSource();
    const dest = dir('dest');
    writeFileSync(join(dest, 'something'), '');
    const root = await rootPair();
    expect(await rejectionOf(runEncryptMigration({ source, dest, rootRecipient: root.recipient, log: quiet }))).toBeInstanceOf(EncryptMigrationError);
  });

  test('a DB-referenced artifact missing from the source is fatal and leaves no marker', async () => {
    const { source, uploadId } = seedPlaintextSource();
    unlinkSync(join(source, 'uploads', 'bob', `${uploadId}.webp`));
    const dest = dir('dest');
    const root = await rootPair();
    expect(String(await rejectionOf(runEncryptMigration({ source, dest, rootRecipient: root.recipient, log: quiet })))).toMatch(/missing artifact/);
    expect(existsSync(join(dest, DATA_VOLUME_MARKER))).toBe(false);
  });
});
