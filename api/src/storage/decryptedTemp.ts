import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaExt } from '@atelier/shared';
import { streamArtifact, type ArtifactReadOptions, type ArtifactStream } from './files';

// Path-based tools (ffmpeg with `-sseof`/multi-input concat) cannot read an
// age-encrypted artifact, and MP4 demuxing needs a seekable file, not a pipe.
// Artifacts are decrypted into a private directory under os.tmpdir() — a
// tmpfs in the container (infra/docker/docker-compose.yml), so plaintext never
// lands in a file on disk — and removed as soon as the callback settles.
//
// tmpfs pages count against the container memory limit, so concurrently
// materialised plaintext is capped process-wide. A single request larger than
// the whole budget fails fast instead of waiting forever.
const DECRYPTED_TEMP_BUDGET_BYTES = 1536 * 1024 ** 2;

export class DecryptedTempBudgetError extends Error {
  constructor(bytes: number) {
    super(`decrypted inputs need ${bytes} bytes, above the ${DECRYPTED_TEMP_BUDGET_BYTES}-byte temp budget`);
    this.name = 'DecryptedTempBudgetError';
  }
}

interface BudgetWaiter {
  readonly bytes: number;
  readonly resolve: () => void;
}

export class ByteBudget {
  private available: number;
  private readonly waiters: BudgetWaiter[] = [];

  constructor(private readonly capacity: number) {
    this.available = capacity;
  }

  async acquire(bytes: number, signal?: AbortSignal): Promise<void> {
    if (bytes > this.capacity) throw new DecryptedTempBudgetError(bytes);
    if (this.waiters.length === 0 && bytes <= this.available) {
      this.available -= bytes;
      return;
    }
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const waiter: BudgetWaiter = {
        bytes,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
        this.drain();
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Non-blocking: reserves only when nobody is queued and the bytes fit now.
  tryAcquire(bytes: number): boolean {
    if (bytes > this.capacity || this.waiters.length > 0 || bytes > this.available) return false;
    this.available -= bytes;
    return true;
  }

  release(bytes: number): void {
    this.available += bytes;
    this.drain();
  }

  // FIFO: the head waiter is served first so a large request is not starved
  // by a stream of small ones.
  private drain(): void {
    for (;;) {
      const head = this.waiters[0];
      if (!head || head.bytes > this.available) return;
      this.waiters.shift();
      this.available -= head.bytes;
      head.resolve();
    }
  }
}

// Processing budget (ffmpeg inputs). Playback copies have their own budget
// (decryptedVideoCache.ts) so they can never starve processing.
const decryptedTempBudget = new ByteBudget(DECRYPTED_TEMP_BUDGET_BYTES);

export interface DecryptedTempInput {
  readonly root: 'images' | 'uploads';
  readonly userId: string;
  readonly artifactId: string;
  readonly ext: MediaExt;
}

function openArtifactStream(
  dataDir: string,
  input: DecryptedTempInput,
  options: ArtifactReadOptions,
): Promise<ArtifactStream | null> {
  return input.root === 'images'
    ? streamArtifact(dataDir, 'images', input.userId, input.artifactId, input.ext, options)
    : streamArtifact(dataDir, 'uploads', input.userId, input.artifactId, uploadExt(input.ext), options);
}

// Decrypts every input into a fresh private temp dir, runs `fn` with the
// plaintext paths (same order as `inputs`), then deletes the dir. Returns null
// without calling `fn` when any input artifact is missing. Every exit path
// cancels opened streams, removes the dir and releases the budget.
export async function withDecryptedArtifactFiles<T>(
  dataDir: string,
  inputs: readonly DecryptedTempInput[],
  options: ArtifactReadOptions,
  fn: (paths: readonly string[]) => Promise<T>,
): Promise<T | null> {
  const streams: ArtifactStream[] = [];
  let reserved = 0;
  let dir: string | null = null;
  try {
    for (const input of inputs) {
      const artifact = await openArtifactStream(dataDir, input, options);
      if (!artifact) return null;
      streams.push(artifact);
    }
    const total = streams.reduce((sum, artifact) => sum + artifact.size, 0);
    await decryptedTempBudget.acquire(total, options.signal);
    reserved = total;
    dir = await mkdtemp(join(tmpdir(), 'atelier-plain-'));
    const paths: string[] = [];
    for (const [index, artifact] of streams.entries()) {
      const input = inputs[index];
      if (!input) throw new Error('decrypted temp input/stream mismatch');
      const path = join(dir, `${index}.${input.ext}`);
      await Bun.write(path, new Response(artifact.stream));
      paths.push(path);
    }
    return await fn(paths);
  } finally {
    await Promise.all(streams.map((artifact) => artifact.stream.cancel().catch(() => undefined)));
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    if (reserved > 0) decryptedTempBudget.release(reserved);
  }
}

function uploadExt(ext: MediaExt): 'png' | 'webp' | 'jpg' {
  if (ext === 'mp4') throw new TypeError('uploads cannot be video');
  return ext;
}
