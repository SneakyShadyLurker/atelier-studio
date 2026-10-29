// One-shot migration of a plaintext Atelier DATA_DIR into a fresh, per-user
// encrypted DATA_DIR (docs/deployment.md § Artifact encryption, migration).
// All-or-nothing: the destination must be empty, every artifact is verified
// by decrypting it back and comparing SHA-256 with its source, any failure
// exits non-zero, and the data-volume marker is written last. Re-running
// means emptying the destination first; the source is only ever read.
//
// Needs only the public STORAGE_ROOT_RECIPIENT: user identities are created
// here, so this process can verify its own output without the root secret.
//
//   STORAGE_ROOT_RECIPIENT=age1pq1… bun scripts/encrypt-migrate.ts \
//     --source /src --dest /app/data
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, fsyncSync, mkdtempSync, openSync, closeSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_EXT_MIME, type MediaExt, type TileExt } from '@atelier/shared';
import { openDb } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { USER_ID_PATTERN } from '../src/user-id';
import {
  DbUserKeyStore,
  StorageKeyring,
  configureStorageKeyring,
  hasAgeMagic,
  verifyOrSeedStorageRoot,
} from '../src/storage/crypto';
import { DATA_VOLUME_MARKER } from '../src/storage/encryptionBoot';
import { ARTIFACT_NAME_RE, readArtifactBytes, writeAtomic, type ArtifactRoot } from '../src/storage/files';

export class EncryptMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptMigrationError';
  }
}

export interface EncryptMigrationOptions {
  readonly source: string;
  readonly dest: string;
  readonly rootRecipient: string;
  readonly log?: (line: string) => void;
}

export interface EncryptMigrationSummary {
  readonly users: number;
  readonly files: Record<ArtifactRoot, number>;
  readonly bytes: number;
  readonly batches: number;
  readonly tiles: number;
}

const ROOTS: readonly ArtifactRoot[] = ['images', 'uploads', 'thumbs'];
const NO_ABORT = new AbortController().signal;
const DB_FILE = 'atelier.sqlite';

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// VACUUM INTO from a private copy of the (stopped) source database: the
// source mount is read-only and SQLite cannot open a WAL database there.
function snapshotDatabase(source: string, dest: string, log: (line: string) => void): void {
  const sourceDb = join(source, DB_FILE);
  if (!existsSync(sourceDb)) throw new EncryptMigrationError(`${sourceDb} not found`);
  const scratch = mkdtempSync(join(tmpdir(), 'atelier-migrate-db-'));
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(sourceDb + suffix)) copyFileSync(sourceDb + suffix, join(scratch, DB_FILE + suffix));
    }
    const copy = new Database(join(scratch, DB_FILE));
    try {
      const integrity = copy.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check;
      if (integrity !== 'ok') throw new EncryptMigrationError(`source database integrity_check: ${integrity}`);
      copy.query('VACUUM INTO ?').run(join(dest, DB_FILE));
    } finally {
      copy.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  log('database snapshot written (VACUUM INTO)');
}

// VACUUM renumbers batches.rowid; the prompt FTS index is keyed on it
// (docs/deployment.md § WAL grows unexpectedly). Rebuild it from batches exactly
// as the insert triggers would, then prove every row lines up.
function resyncPromptIndex(db: Database): void {
  db.transaction(() => {
    db.run('DELETE FROM batch_prompt_fts');
    db.run(
      'INSERT INTO batch_prompt_fts(rowid, user_id, batch_id, prompt) SELECT rowid, user_id, id, prompt FROM batches WHERE archived_at IS NULL',
    );
  })();
  const mismatched = db
    .query<{ n: number }, []>(
      'SELECT count(*) AS n FROM batch_prompt_fts_content c JOIN batches b ON b.rowid = c.id WHERE b.id <> c.c1',
    )
    .get()?.n ?? -1;
  const indexed = db.query<{ n: number }, []>('SELECT count(*) AS n FROM batch_prompt_fts_content').get()?.n ?? -1;
  const live = db.query<{ n: number }, []>('SELECT count(*) AS n FROM batches WHERE archived_at IS NULL').get()?.n ?? -2;
  if (mismatched !== 0 || indexed !== live) {
    throw new EncryptMigrationError(`prompt index re-sync failed (mismatched=${mismatched}, indexed=${indexed}, live=${live})`);
  }
}

function sourceFiles(source: string, root: ArtifactRoot): { userId: string; name: string; id: string; ext: MediaExt }[] {
  const rootDir = join(source, root);
  if (!existsSync(rootDir)) return [];
  const files: { userId: string; name: string; id: string; ext: MediaExt }[] = [];
  for (const userEntry of readdirSync(rootDir, { withFileTypes: true })) {
    if (!userEntry.isDirectory()) continue;
    if (!USER_ID_PATTERN.test(userEntry.name)) {
      throw new EncryptMigrationError(`unexpected directory ${root}/${userEntry.name}`);
    }
    for (const entry of readdirSync(join(rootDir, userEntry.name), { withFileTypes: true })) {
      const match = entry.isFile() ? ARTIFACT_NAME_RE.exec(entry.name) : null;
      const id = match?.groups?.artifactId;
      const ext = match?.groups?.ext as MediaExt | undefined;
      if (!match || match.groups?.tmp || !id || !ext) continue;
      files.push({ userId: userEntry.name, name: entry.name, id, ext });
    }
  }
  return files;
}

async function migrateArtifact(
  source: string,
  dest: string,
  root: ArtifactRoot,
  file: { userId: string; name: string; id: string; ext: MediaExt },
): Promise<number> {
  const plaintext = new Uint8Array(await Bun.file(join(source, root, file.userId, file.name)).arrayBuffer());
  if (hasAgeMagic(plaintext)) {
    throw new EncryptMigrationError(`${root}/${file.userId}/${file.name} is already age-encrypted`);
  }
  const mime = MEDIA_EXT_MIME[file.ext];
  let stored;
  if (root === 'images') {
    await writeAtomic(dest, 'images', file.userId, file.id, file.ext, plaintext);
    stored = await readArtifactBytes(dest, 'images', file.userId, file.id, file.ext, mime, { signal: NO_ABORT });
  } else {
    if (file.ext === 'mp4') throw new EncryptMigrationError(`${root}/${file.userId}/${file.name}: video outside images/`);
    const ext: TileExt = file.ext;
    const tileMime = MEDIA_EXT_MIME[ext];
    await writeAtomic(dest, root, file.userId, file.id, ext, plaintext);
    stored = await readArtifactBytes(dest, root, file.userId, file.id, ext, tileMime, { signal: NO_ABORT });
  }
  if (!stored || sha256(stored.bytes) !== sha256(plaintext)) {
    throw new EncryptMigrationError(`${root}/${file.userId}/${file.name}: decrypted copy does not match the source`);
  }
  return plaintext.length;
}

function assertReferencedArtifactsPresent(db: Database, dest: string): void {
  const missing: string[] = [];
  const has = (root: ArtifactRoot, userId: string, name: string) => existsSync(join(dest, root, userId, name));
  for (const tile of db
    .query<{ id: string; user_id: string; ext: string }, []>("SELECT id, user_id, ext FROM tiles WHERE status = 'done' AND ext IS NOT NULL")
    .all()) {
    if (!has('images', tile.user_id, `${tile.id}.${tile.ext}`)) missing.push(`tile ${tile.id}`);
  }
  for (const upload of db.query<{ id: string; user_id: string; ext: string }, []>('SELECT id, user_id, ext FROM uploads').all()) {
    if (!has('uploads', upload.user_id, `${upload.id}.${upload.ext}`)) missing.push(`upload ${upload.id}`);
  }
  for (const master of db
    .query<{ id: string; user_id: string }, []>("SELECT id, user_id FROM video_sequences WHERE master_status = 'ready'")
    .all()) {
    if (!has('images', master.user_id, `${master.id}.mp4`)) missing.push(`sequence master ${master.id}`);
  }
  if (missing.length > 0) {
    throw new EncryptMigrationError(`database references ${missing.length} missing artifact(s): ${missing.slice(0, 10).join(', ')}`);
  }
}

export async function runEncryptMigration(options: EncryptMigrationOptions): Promise<EncryptMigrationSummary> {
  const log = options.log ?? ((line: string) => { console.error(line); });
  const { source, dest } = options;
  if (!existsSync(dest)) throw new EncryptMigrationError(`destination ${dest} does not exist`);
  const leftovers = readdirSync(dest);
  if (leftovers.length > 0) {
    throw new EncryptMigrationError(`destination ${dest} is not empty (${leftovers.slice(0, 5).join(', ')}); empty it to retry`);
  }

  snapshotDatabase(source, dest, log);
  const db = openDb({ dataDir: dest });
  try {
    migrate(db, dest);
    resyncPromptIndex(db);
    const integrity = db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') throw new EncryptMigrationError(`destination integrity_check: ${integrity}`);
    if (db.query('PRAGMA foreign_key_check').all().length > 0) {
      throw new EncryptMigrationError('destination foreign_key_check reported violations');
    }
    log('database migrated, prompt index re-synced, integrity ok');

    verifyOrSeedStorageRoot(db, options.rootRecipient);
    configureStorageKeyring(new StorageKeyring({ rootRecipient: options.rootRecipient, store: new DbUserKeyStore(db) }));

    const files: Record<ArtifactRoot, number> = { images: 0, uploads: 0, thumbs: 0 };
    let bytes = 0;
    for (const root of ROOTS) {
      for (const file of sourceFiles(source, root)) {
        bytes += await migrateArtifact(source, dest, root, file);
        files[root]++;
      }
      log(`${root}: ${files[root]} artifact(s) encrypted and verified`);
    }
    assertReferencedArtifactsPresent(db, dest);

    const users = db.query<{ n: number }, []>('SELECT count(*) AS n FROM user_storage_keys').get()?.n ?? 0;
    const batches = db.query<{ n: number }, []>('SELECT count(*) AS n FROM batches').get()?.n ?? 0;
    const tiles = db.query<{ n: number }, []>('SELECT count(*) AS n FROM tiles').get()?.n ?? 0;
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    const summary: EncryptMigrationSummary = { users, files, bytes, batches, tiles };

    // Last: the marker is what lets production boot on this directory.
    const marker = join(dest, DATA_VOLUME_MARKER);
    writeFileSync(marker, `${JSON.stringify({ migratedAt: new Date().toISOString(), ...summary })}\n`, { flag: 'wx' });
    fsyncPath(marker);
    fsyncPath(dest);
    return summary;
  } finally {
    configureStorageKeyring(null);
    db.close();
  }
}

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? fallback;
}

if (import.meta.main) {
  const rootRecipient = process.env.STORAGE_ROOT_RECIPIENT?.trim();
  if (!rootRecipient) {
    console.error('STORAGE_ROOT_RECIPIENT is required');
    process.exit(1);
  }
  try {
    const summary = await runEncryptMigration({
      source: argValue('--source', '/src'),
      dest: argValue('--dest', '/app/data'),
      rootRecipient,
    });
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(error instanceof EncryptMigrationError ? `migration failed: ${error.message}` : error);
    process.exit(1);
  }
}
