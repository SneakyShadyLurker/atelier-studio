import type { Database } from 'bun:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaExt } from '@atelier/shared';
import { USER_ID_PATTERN } from '../user-id';
import { AGE_MAGIC, hasAgeMagic, type StorageKeyring } from './crypto';
import { ARTIFACT_NAME_RE, artifactFilePath, namedArtifactRoot, type ArtifactRoot } from './files';

export interface StorageVerifyFailure {
  readonly root: ArtifactRoot;
  readonly userId: string;
  readonly file: string;
  readonly reason: 'plaintext' | 'unauthenticated';
}

export interface StorageVerifyMissing {
  readonly kind: 'tile' | 'upload' | 'sequence-master';
  readonly userId: string;
  readonly id: string;
}

export interface StorageVerifyReport {
  readonly summary: {
    readonly userKeys: number;
    readonly userKeyFailures: number;
    readonly files: number;
    readonly bytes: number;
    readonly failures: number;
    readonly missing: number;
  };
  readonly userKeyFailures: readonly string[];
  readonly failures: readonly StorageVerifyFailure[];
  readonly missing: readonly StorageVerifyMissing[];
}

const ROOTS: readonly ArtifactRoot[] = ['images', 'uploads', 'thumbs'];
const NO_ABORT = new AbortController().signal;

// Full at-rest integrity pass (unsealed keyring required): unwraps every user
// identity, authenticates every stored artifact end to end (the plaintext is
// discarded), and lists DB-referenced artifacts whose file is missing. Never
// reports key material or plaintext.
export async function verifyStoredArtifacts(
  db: Database,
  dataDir: string,
  keyring: StorageKeyring,
): Promise<StorageVerifyReport> {
  const keys = await keyring.verifyUserKeys(NO_ABORT);
  const failures: StorageVerifyFailure[] = [];
  let files = 0;
  let bytes = 0;

  for (const root of ROOTS) {
    const rootDir = namedArtifactRoot(dataDir, root);
    if (!existsSync(rootDir)) continue;
    for (const userEntry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!userEntry.isDirectory() || !USER_ID_PATTERN.test(userEntry.name)) continue;
      const userId = userEntry.name;
      const userDir = join(rootDir, userId);
      for (const entry of readdirSync(userDir, { withFileTypes: true })) {
        const match = entry.isFile() ? ARTIFACT_NAME_RE.exec(entry.name) : null;
        if (!match || match.groups?.tmp) continue;
        files++;
        const file = Bun.file(join(userDir, entry.name));
        const head = new Uint8Array(await file.slice(0, AGE_MAGIC.length).arrayBuffer());
        if (!hasAgeMagic(head)) {
          failures.push({ root, userId, file: entry.name, reason: 'plaintext' });
          continue;
        }
        try {
          const { stream } = await keyring.decryptFile(userId, file, NO_ABORT);
          for await (const chunk of stream) bytes += chunk.length;
        } catch {
          failures.push({ root, userId, file: entry.name, reason: 'unauthenticated' });
        }
      }
    }
  }

  const missing: StorageVerifyMissing[] = [];
  const tiles = db
    .query<{ id: string; user_id: string; ext: MediaExt }, []>(
      "SELECT id, user_id, ext FROM tiles WHERE status = 'done' AND ext IS NOT NULL",
    )
    .all();
  for (const tile of tiles) {
    if (artifactFilePath(dataDir, 'images', tile.user_id, tile.id, tile.ext) === null) {
      missing.push({ kind: 'tile', userId: tile.user_id, id: tile.id });
    }
  }
  const uploads = db.query<{ id: string; user_id: string; ext: MediaExt }, []>('SELECT id, user_id, ext FROM uploads').all();
  for (const upload of uploads) {
    if (artifactFilePath(dataDir, 'uploads', upload.user_id, upload.id, upload.ext) === null) {
      missing.push({ kind: 'upload', userId: upload.user_id, id: upload.id });
    }
  }
  const masters = db
    .query<{ id: string; user_id: string }, []>("SELECT id, user_id FROM video_sequences WHERE master_status = 'ready'")
    .all();
  for (const master of masters) {
    if (artifactFilePath(dataDir, 'images', master.user_id, master.id, 'mp4') === null) {
      missing.push({ kind: 'sequence-master', userId: master.user_id, id: master.id });
    }
  }

  return {
    summary: {
      userKeys: keys.checked,
      userKeyFailures: keys.failed.length,
      files,
      bytes,
      failures: failures.length,
      missing: missing.length,
    },
    userKeyFailures: keys.failed,
    failures,
    missing,
  };
}
