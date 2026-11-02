import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BunFile } from 'bun';
import type { MediaExt } from '@atelier/shared';
import { ByteBudget } from './decryptedTemp';
import { streamArtifact } from './files';

// Video playback needs HTTP Range: iOS Safari refuses a <video> source that
// answers without 206, and every browser needs it to seek. Bun answers Range
// natively for a `Response(BunFile)`, but an age-encrypted artifact can only
// be served as a decrypted stream. So a video that is being played gets a
// short-lived plaintext copy in the container's tmpfs (never a disk file),
// served through a reader lease with HTTP Range support.
//
// The cache has its OWN byte budget, separate from processing
// (decryptedTemp.ts), so hot playback can never starve stitching or tail
// extraction. Eviction retires an entry; its file and reservation remain
// alive until the last reader closes, regardless of download duration.
//
// Callers must authorise the request (owner-scoped DB row) BEFORE calling.
// `version` distinguishes content that is replaced under the same id
// (sequence masters are re-stitched in place); immutable tiles pass none.

export const VIDEO_CACHE_BUDGET_BYTES = 1024 ** 3;
export const VIDEO_CACHE_IDLE_TTL_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

const budget = new ByteBudget(VIDEO_CACHE_BUDGET_BYTES);

interface Entry {
  readonly path: string;
  readonly size: number;
  lastUsed: number;
  readers: number;
  retired: boolean;
}

export interface DecryptedVideoLease {
  readonly file: BunFile;
  /** Call only once the underlying reader has closed. Idempotent. */
  release(): void;
}

const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry | null>>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function drop(key: string, entry: Entry): void {
  if (entries.get(key) === entry) entries.delete(key);
  entry.retired = true;
  if (entry.readers > 0) return;
  rmSync(entry.path, { force: true });
  budget.release(entry.size);
}

function acquire(entry: Entry): DecryptedVideoLease {
  entry.readers += 1;
  entry.lastUsed = Date.now();
  let released = false;
  return {
    file: Bun.file(entry.path),
    release() {
      if (released) return;
      released = true;
      entry.readers -= 1;
      entry.lastUsed = Date.now();
      if (entry.retired && entry.readers === 0) {
        rmSync(entry.path, { force: true });
        budget.release(entry.size);
      }
    },
  };
}

export function sweepDecryptedVideoCache(now = Date.now()): void {
  for (const [key, entry] of entries) {
    // Active responses enforce their own progress deadline. Keep their cached
    // copy reusable by seeks instead of materializing a duplicate on age alone.
    if (entry.readers === 0 && now - entry.lastUsed >= VIDEO_CACHE_IDLE_TTL_MS) drop(key, entry);
  }
}

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => { sweepDecryptedVideoCache(); }, SWEEP_INTERVAL_MS);
  sweeper.unref();
}

function cacheDir(): string {
  const dir = join(tmpdir(), 'atelier-video');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function materialize(
  dataDir: string,
  userId: string,
  artifactId: string,
  ext: MediaExt,
): Promise<Entry | null> {
  const artifact = await streamArtifact(dataDir, 'images', userId, artifactId, ext);
  if (!artifact) return null;
  if (!budget.tryAcquire(artifact.size)) {
    sweepDecryptedVideoCache();
    if (!budget.tryAcquire(artifact.size)) {
      await artifact.stream.cancel().catch(() => undefined);
      return null;
    }
  }
  let path: string | null = null;
  try {
    path = join(cacheDir(), `${randomUUID()}.${ext}`);
    await Bun.write(path, new Response(artifact.stream));
    ensureSweeper();
    return { path, size: artifact.size, lastUsed: Date.now(), readers: 0, retired: false };
  } catch (error) {
    await artifact.stream.cancel().catch(() => undefined);
    if (path !== null) rmSync(path, { force: true });
    budget.release(artifact.size);
    throw error;
  }
}

// A seekable plaintext handle for a stored video in `images/`, or null when
// the artifact is missing or the cache budget is exhausted.
export async function acquireDecryptedVideo(
  dataDir: string,
  userId: string,
  artifactId: string,
  ext: MediaExt,
  version = '',
  isCurrent: () => boolean = () => true,
): Promise<DecryptedVideoLease | null> {
  const key = `${userId}/${artifactId}.${ext}#${version}`;
  const cached = entries.get(key);
  if (cached && existsSync(cached.path)) {
    if (!isCurrent()) return null;
    return acquire(cached);
  }
  if (cached) drop(key, cached);
  // A new version replaces older copies of the same artifact.
  if (version !== '') forgetDecryptedVideo(userId, artifactId);
  let inFlight = pending.get(key);
  if (!inFlight) {
    inFlight = materialize(dataDir, userId, artifactId, ext)
      .then((entry) => {
        if (entry) entries.set(key, entry);
        return entry;
      })
      .finally(() => pending.delete(key));
    pending.set(key, inFlight);
  }
  const entry = await inFlight;
  if (!entry || entry.retired) return null;
  // A master may be published while the old artifact is being decrypted.
  // Never retain or hand out that old copy under the caller's snapshot.
  if (!isCurrent()) {
    if (entries.get(key) === entry) drop(key, entry);
    return null;
  }
  return acquire(entry);
}

// Drops every cached version of an artifact (e.g. a re-stitched master).
function forgetDecryptedVideo(userId: string, artifactId: string): void {
  const prefix = `${userId}/${artifactId}.`;
  for (const [key, entry] of entries) {
    if (key.startsWith(prefix)) drop(key, entry);
  }
}

export function resetDecryptedVideoCacheForTests(): void {
  for (const [key, entry] of entries) drop(key, entry);
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

export function videoCacheBudgetForTests(): ByteBudget {
  return budget;
}
