import { closeSync, existsSync, fsync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { MEDIA_EXT_MIME, MEDIA_EXTS, TILE_EXTS } from '@atelier/shared';
import type { MediaExt, MediaMime, TileExt, TileMime } from '@atelier/shared';
import { USER_ID_PATTERN } from '../user-id';
import { readWaitSignal, storageKeyring } from './crypto';

export type ArtifactRoot = 'images' | 'uploads' | 'thumbs';
type ImageArtifactRoot = 'images';
type ImageOnlyArtifactRoot = Exclude<ArtifactRoot, ImageArtifactRoot>;

// Runtime allowlist for the artifact root. The ArtifactRoot union is the
// compile-time guard; this Set is the defense-in-depth runtime check at the
// single path-construction chokepoint (namedArtifactRoot), so an untyped or
// bad-positional caller can never build a path outside images/uploads/thumbs.
const ARTIFACT_ROOTS: ReadonlySet<string> = new Set<ArtifactRoot>(['images', 'uploads', 'thumbs']);

// fsync runs on the libuv threadpool (async) so a slow or degraded disk cannot
// block the event loop. A synchronous fsync here would defeat the per-tile
// timeout watchdog and, for the single-slot local pool, wedge the whole pool
// behind one stuck write.
const fsyncAsync = promisify(fsync);

interface StorageOps {
  openSync: typeof openSync;
  fsync: (fd: number) => void | Promise<void>;
  closeSync: typeof closeSync;
  renameSync: typeof renameSync;
}

const defaultOps: StorageOps = { openSync, fsync: fsyncAsync, closeSync, renameSync };
let ops: StorageOps = defaultOps;

export function setStorageOpsForTests(next: Partial<StorageOps> | null): void {
  ops = next ? { ...defaultOps, ...next } : defaultOps;
}

export interface Artifact<TExt extends MediaExt = MediaExt, TMime extends MediaMime = MediaMime> {
  bytes: Uint8Array;
  ext: TExt;
  mime: TMime;
  path: string;
}

export class InvalidUserIdError extends Error {
  constructor(userId: string) {
    super(`invalid storage userId: ${JSON.stringify(userId)}`);
    this.name = 'InvalidUserIdError';
  }
}

export class InvalidArtifactIdError extends Error {
  constructor(artifactId: string) {
    super(`invalid storage artifactId: ${JSON.stringify(artifactId)}`);
    this.name = 'InvalidArtifactIdError';
  }
}

function validateUserId(userId: string): void {
  if (
    userId.length === 0 ||
    userId === '.' ||
    userId === '..' ||
    userId.includes('/') ||
    userId.includes('\\') ||
    userId.includes('\0') ||
    !USER_ID_PATTERN.test(userId)
  ) {
    throw new InvalidUserIdError(userId);
  }
}

function validateArtifactId(artifactId: string): void {
  if (
    artifactId.length === 0 ||
    artifactId === '.' ||
    artifactId === '..' ||
    artifactId.includes('/') ||
    artifactId.includes('\\') ||
    artifactId.includes('\0') ||
    isAbsolute(artifactId)
  ) {
    throw new InvalidArtifactIdError(artifactId);
  }
}

export function namedArtifactRoot(dataDir: string, root: ArtifactRoot): string {
  if (!ARTIFACT_ROOTS.has(root)) throw new TypeError(`invalid artifact root: ${JSON.stringify(root)}`);
  return join(dataDir, root);
}

function toArtifactExt(root: ImageOnlyArtifactRoot, ext: string): TileExt;
function toArtifactExt(root: ArtifactRoot, ext: string): MediaExt;
function toArtifactExt(root: ArtifactRoot, ext: string): MediaExt {
  const allowedExts = root === 'images' ? MEDIA_EXTS : TILE_EXTS;
  for (const candidate of allowedExts) {
    if (candidate === ext) return candidate;
  }
  throw new TypeError(`invalid artifact ext: ${JSON.stringify(ext)}`);
}

function toArtifactMime(root: ImageOnlyArtifactRoot, mime: string): TileMime;
function toArtifactMime(root: ArtifactRoot, mime: string): MediaMime;
function toArtifactMime(root: ArtifactRoot, mime: string): MediaMime {
  const allowedExts = root === 'images' ? MEDIA_EXTS : TILE_EXTS;
  for (const ext of allowedExts) {
    const candidate = MEDIA_EXT_MIME[ext];
    if (candidate === mime) return candidate;
  }
  throw new TypeError(`invalid artifact mime: ${JSON.stringify(mime)}`);
}

// Path string is constrained by validateUserId, but the storage APIs do not
// reject pre-existing symlinks at `${DATA_DIR}/<root>/` or `${DATA_DIR}/<root>/<userId>/`.
// That gap is acceptable because the bind mount is owned by the api UID
// (`1000:1000` per infra/docker/.env.production.example) — only host root or
// the api itself can create entries there, both already inside the trust
// boundary. If `${DATA_DIR}` is ever moved to a shared mount or made writable
// to other host users, add lstat/realpath containment checks here.
export function namedArtifactDir(dataDir: string, root: ArtifactRoot, userId: string): string {
  validateUserId(userId);
  return join(namedArtifactRoot(dataDir, root), userId);
}

// The single (root, userId, artifactId, ext) -> ciphertext path rule: validates
// the ext against the root's allowlist and the id before joining.
function artifactPath(
  dataDir: string,
  root: ArtifactRoot,
  userId: string,
  artifactId: string,
  ext: string,
): { path: string; dir: string; artifactExt: MediaExt } {
  const artifactExt = toArtifactExt(root, ext);
  validateArtifactId(artifactId);
  const dir = namedArtifactDir(dataDir, root, userId);
  return { path: join(dir, `${artifactId}.${artifactExt}`), dir, artifactExt };
}

export function writeAtomic(
  dataDir: string,
  root: ImageArtifactRoot,
  userId: string,
  artifactId: string,
  ext: MediaExt,
  bytes: Uint8Array,
): Promise<string>;
export function writeAtomic(
  dataDir: string,
  root: ImageOnlyArtifactRoot,
  userId: string,
  artifactId: string,
  ext: TileExt,
  bytes: Uint8Array,
): Promise<string>;
export async function writeAtomic(
  dataDir: string,
  root: ArtifactRoot,
  userId: string,
  artifactId: string,
  ext: MediaExt,
  bytes: Uint8Array,
): Promise<string> {
  const prepared = await prepareAtomicWrite(dataDir, root, userId, artifactId, ext, bytes);
  await publishAtomicWrite(prepared);
  return prepared.final;
}

export async function writeAtomicPublishThenCommit(
  dataDir: string,
  root: ImageArtifactRoot,
  userId: string,
  artifactId: string,
  ext: MediaExt,
  bytes: Uint8Array,
  commit: () => boolean,
): Promise<string | null> {
  const prepared = await prepareAtomicWrite(dataDir, root, userId, artifactId, ext, bytes);
  const backup = join(prepared.dir, `${artifactId}-previous.${prepared.artifactExt}.tmp`);
  removeIfPresent(backup);
  const hadPrevious = existsSync(prepared.final);
  if (hadPrevious) ops.renameSync(prepared.final, backup);
  try {
    await publishAtomicWrite(prepared);
  } catch (error) {
    await restorePreviousAtomicWrite(prepared, backup, hadPrevious);
    throw error;
  }

  let committed: boolean;
  try {
    committed = commit();
  } catch (error) {
    await restorePreviousAtomicWrite(prepared, backup, hadPrevious);
    throw error;
  }
  if (!committed) {
    await restorePreviousAtomicWrite(prepared, backup, hadPrevious);
    return null;
  }
  if (hadPrevious) removeIfPresent(backup);
  return prepared.final;
}

interface PreparedAtomicWrite {
  readonly artifactExt: MediaExt;
  readonly dir: string;
  readonly tmp: string;
  readonly final: string;
}

async function prepareAtomicWrite(
  dataDir: string,
  root: ArtifactRoot,
  userId: string,
  artifactId: string,
  ext: MediaExt,
  bytes: Uint8Array,
): Promise<PreparedAtomicWrite> {
  const { path: final, dir, artifactExt } = artifactPath(dataDir, root, userId, artifactId, ext);
  // mkdirSync(recursive=true) returns the first directory created, or
  // undefined if the dir already existed. When we create the per-user dir
  // for the first time, fsync the parent artifact root so the new
  // directory entry is durable on disk — otherwise a power loss after the
  // file write but before the parent's journal flush could lose the
  // <userId>/ binding entirely.
  const created = mkdirSync(dir, { recursive: true });
  if (created !== undefined) {
    await fsyncDirectory(namedArtifactRoot(dataDir, root));
  }
  const tmp = `${final}.tmp`;
  // Every artifact is stored age-encrypted to its owner (storage/crypto.ts).
  // Encryption needs only the user's public recipient, so writes never wait
  // for the storage root to be unsealed.
  let ciphertext: ReadableStream<Uint8Array> | undefined;
  try {
    ciphertext = await (await storageKeyring()).encryptStream(userId, bytes);
    await Bun.write(tmp, new Response(ciphertext));
    const fileFd = ops.openSync(tmp, 'r+');
    try {
      await ops.fsync(fileFd);
    } finally {
      ops.closeSync(fileFd);
    }
  } catch (error) {
    await ciphertext?.cancel(error).catch(() => undefined);
    removeIfPresent(tmp);
    throw error;
  }
  return { artifactExt, dir, tmp, final };
}

async function publishAtomicWrite(prepared: PreparedAtomicWrite): Promise<void> {
  ops.renameSync(prepared.tmp, prepared.final);
  await fsyncDirectory(prepared.dir);
}

async function restorePreviousAtomicWrite(
  prepared: PreparedAtomicWrite,
  backup: string,
  hadPrevious: boolean,
): Promise<void> {
  removeIfPresent(prepared.final);
  if (hadPrevious) ops.renameSync(backup, prepared.final);
  await fsyncDirectory(prepared.dir);
}

async function fsyncDirectory(dir: string): Promise<void> {
  const dirFd = ops.openSync(dir, 'r');
  try {
    await ops.fsync(dirFd);
  } finally {
    ops.closeSync(dirFd);
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export interface ArtifactReadOptions {
  // Bounds how long a read waits while storage is sealed (combined with the
  // default STORAGE_READ_WAIT_MS budget); abort rejects with StorageSealedError.
  readonly signal?: AbortSignal;
}

// Async plaintext read for consumers that need raw bytes (sharp decode,
// ref-image base64, ffmpeg stdin). The on-disk artifact is age-encrypted; this
// authenticates and decrypts it. `path` is the ciphertext location.
export function readArtifactBytes(
  dataDir: string,
  root: ImageArtifactRoot,
  userId: string,
  artifactId: string,
  ext: MediaExt,
  mime: MediaMime,
  options?: ArtifactReadOptions,
): Promise<Artifact | null>;
export function readArtifactBytes(
  dataDir: string,
  root: ImageOnlyArtifactRoot,
  userId: string,
  artifactId: string,
  ext: TileExt,
  mime: TileMime,
  options?: ArtifactReadOptions,
): Promise<Artifact<TileExt, TileMime> | null>;
export async function readArtifactBytes(
  dataDir: string,
  root: ArtifactRoot,
  userId: string,
  artifactId: string,
  ext: MediaExt,
  mime: MediaMime,
  options: ArtifactReadOptions = {},
): Promise<Artifact | null> {
  const { path, artifactExt } = artifactPath(dataDir, root, userId, artifactId, ext);
  const artifactMime = toArtifactMime(root, mime);
  // A missing file (or one unlinked mid-read by a concurrent delete) is
  // null, so callers (thumb route, loadRefImages) converge to a 404 / clean
  // failure instead of a 500.
  try {
    const bytes = await (await storageKeyring()).decryptFileBytes(
      userId,
      Bun.file(path),
      readWaitSignal(options.signal),
    );
    return { bytes, ext: artifactExt, mime: artifactMime, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export interface ArtifactStream {
  // Decrypted plaintext; errors mid-stream if the ciphertext fails to
  // authenticate (truncation, tampering).
  readonly stream: ReadableStream<Uint8Array>;
  // Exact plaintext length, for Content-Length.
  readonly size: number;
  readonly path: string;
}

// Streaming plaintext handle for hot response paths
// (`GET /api/img/:tileId(/thumb)`, uploads, sequence masters).
export function streamArtifact(
  dataDir: string,
  root: ImageArtifactRoot,
  userId: string,
  artifactId: string,
  ext: MediaExt,
  options?: ArtifactReadOptions,
): Promise<ArtifactStream | null>;
export function streamArtifact(
  dataDir: string,
  root: ImageOnlyArtifactRoot,
  userId: string,
  artifactId: string,
  ext: TileExt,
  options?: ArtifactReadOptions,
): Promise<ArtifactStream | null>;
export async function streamArtifact(
  dataDir: string,
  root: ArtifactRoot,
  userId: string,
  artifactId: string,
  ext: MediaExt,
  options: ArtifactReadOptions = {},
): Promise<ArtifactStream | null> {
  // No existence stat first: decryptFile's header read rejects with ENOENT
  // for a missing file, which the catch maps to null.
  const { path } = artifactPath(dataDir, root, userId, artifactId, ext);
  try {
    const { stream, size } = await (await storageKeyring()).decryptFile(
      userId,
      Bun.file(path),
      readWaitSignal(options.signal),
    );
    return { stream, size, path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// On-disk (ciphertext) location of an existing artifact, or null. For
// existence checks and for handing an artifact to a path-based tool through
// storage/decryptedTemp.ts — never read the returned file directly.
export function artifactFilePath(
  dataDir: string,
  root: ArtifactRoot,
  userId: string,
  artifactId: string,
  ext: MediaExt,
): string | null {
  const { path } = artifactPath(dataDir, root, userId, artifactId, ext);
  // Use existsSync for presence: BunFile.size returns 0 for both missing AND
  // empty (0-byte) files, so a pure `size === 0` check would silently 404 a
  // corrupted-but-present file (hiding it from observability and from the
  // reconciler's missing-artifact sweep, which also uses existsSync). Better
  // to surface the (broken) bytes and let upstream catch the corruption.
  return existsSync(path) ? path : null;
}

// Async existence check for request paths that must not block the event loop
// on stat(2) (e.g. the /generate pre-flight, which runs outside the write
// transaction). An ext or id the root does not allow is simply absent.
export async function artifactExists(
  dataDir: string,
  root: ArtifactRoot,
  userId: string,
  artifactId: string,
  ext: string,
): Promise<boolean> {
  let path: string;
  try {
    path = artifactPath(dataDir, root, userId, artifactId, ext).path;
  } catch (error) {
    if (error instanceof TypeError || error instanceof InvalidArtifactIdError) return false;
    throw error;
  }
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function deleteArtifact(
  dataDir: string,
  root: ImageArtifactRoot,
  userId: string,
  artifactId: string,
  ext: MediaExt,
): void;
export function deleteArtifact(
  dataDir: string,
  root: ImageOnlyArtifactRoot,
  userId: string,
  artifactId: string,
  ext: TileExt,
): void;
export function deleteArtifact(
  dataDir: string,
  root: ArtifactRoot,
  userId: string,
  artifactId: string,
  ext: MediaExt,
): void {
  const { path } = artifactPath(dataDir, root, userId, artifactId, ext);
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export interface ArtifactFile {
  path: string;
  artifactId: string;
  ext: MediaExt | null;
  userId: string | null;
  temporary: boolean;
}

export const ARTIFACT_NAME_RE = /^(?<artifactId>[\w-]+)\.(?<ext>png|webp|jpg|mp4)(?<tmp>\.tmp)?$/;

function artifactFileFromName(
  dir: string,
  root: ArtifactRoot,
  name: string,
  userId: string | null,
  knownFiles: ReadonlySet<string>,
): ArtifactFile | null {
  const match = ARTIFACT_NAME_RE.exec(name);
  if (!match?.groups) return null;
  const artifactId = match.groups.artifactId;
  const extValue = match.groups.ext;
  if (!artifactId || !extValue) return null;
  let ext: MediaExt;
  try {
    ext = toArtifactExt(root, extValue);
  } catch {
    return null;
  }
  const temporary = Boolean(match.groups.tmp);
  const knownKey = userId === null ? null : `${userId}/${artifactId}.${ext}`;
  if (!temporary && knownKey !== null && knownFiles.has(knownKey)) return null;
  return { path: join(dir, name), artifactId, ext, userId, temporary };
}

export function findOrphans(dataDir: string, rootName: ArtifactRoot, knownFiles: ReadonlySet<string>): ArtifactFile[] {
  const root = namedArtifactRoot(dataDir, rootName);
  mkdirSync(root, { recursive: true });
  const files: ArtifactFile[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile()) {
      const file = artifactFileFromName(root, rootName, entry.name, null, knownFiles);
      if (file) files.push(file);
      continue;
    }
    if (!entry.isDirectory()) continue;
    // Skip directories whose name isn't a valid userId — protects backup
    // snapshot dirs (`.zfs/`, `.snapshots/`, etc.), system dirs, and any
    // future bind-mount neighbours from being walked + cannibalized.
    try {
      validateUserId(entry.name);
    } catch {
      continue;
    }
    const userId = entry.name;
    const userDir = join(root, userId);
    for (const child of readdirSync(userDir, { withFileTypes: true })) {
      if (!child.isFile()) continue;
      const file = artifactFileFromName(userDir, rootName, child.name, userId, knownFiles);
      if (file) files.push(file);
    }
  }
  return files;
}
