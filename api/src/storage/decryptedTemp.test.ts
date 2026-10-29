import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { rejectionOf, tempDir } from '../test/helpers';
import { ByteBudget, DecryptedTempBudgetError, withDecryptedArtifactFiles } from './decryptedTemp';
import { writeAtomic } from './files';

describe('withDecryptedArtifactFiles', () => {
  test('hands plaintext paths to the callback and removes them afterwards', async () => {
    const dataDir = tempDir();
    const first = new TextEncoder().encode('first clip');
    const second = new TextEncoder().encode('second clip');
    await writeAtomic(dataDir, 'images', 'alice', 'a', 'mp4', first);
    await writeAtomic(dataDir, 'images', 'alice', 'b', 'mp4', second);
    let seen: readonly string[] = [];
    const result = await withDecryptedArtifactFiles(
      dataDir,
      [
        { root: 'images', userId: 'alice', artifactId: 'a', ext: 'mp4' },
        { root: 'images', userId: 'alice', artifactId: 'b', ext: 'mp4' },
      ],
      {},
      (paths) => {
        seen = paths;
        return Promise.resolve(paths.map((path) => readFileSync(path, 'utf8')));
      },
    );
    expect(result).toEqual(['first clip', 'second clip']);
    expect(seen.every((path) => !path.startsWith(dataDir))).toBe(true);
    expect(seen.some((path) => existsSync(path))).toBe(false);
  });

  test('removes plaintext when the callback throws', async () => {
    const dataDir = tempDir();
    await writeAtomic(dataDir, 'images', 'alice', 'a', 'mp4', new Uint8Array([1, 2, 3]));
    let seen: readonly string[] = [];
    expect(String(await rejectionOf(withDecryptedArtifactFiles(
      dataDir,
      [{ root: 'images', userId: 'alice', artifactId: 'a', ext: 'mp4' }],
      {},
      (paths) => {
        seen = paths;
        return Promise.reject(new Error('ffmpeg failed'));
      },
    )))).toMatch('ffmpeg failed');
    expect(seen).toHaveLength(1);
    expect(seen.some((path) => existsSync(path))).toBe(false);
  });

  test('returns null without calling back when an input is missing', async () => {
    const dataDir = tempDir();
    let called = false;
    const result = await withDecryptedArtifactFiles(
      dataDir,
      [{ root: 'images', userId: 'alice', artifactId: 'nope', ext: 'mp4' }],
      {},
      () => {
        called = true;
        return Promise.resolve('unreachable');
      },
    );
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  test('byte budget: over-capacity fails fast, waits are FIFO, aborted waiters leave the queue', async () => {
    const budget = new ByteBudget(10);
    expect(await rejectionOf(budget.acquire(11))).toBeInstanceOf(DecryptedTempBudgetError);
    await budget.acquire(6);
    const order: string[] = [];
    const big = budget.acquire(8).then(() => { order.push('big'); });
    const abort = new AbortController();
    const aborted = budget.acquire(1, abort.signal).catch(() => { order.push('aborted'); });
    const small = budget.acquire(2).then(() => { order.push('small'); });
    abort.abort();
    await aborted;
    budget.release(6);
    await Promise.all([big, small]);
    // `small` (2) fits beside `big` (8) only once `big` has been served first.
    expect(order).toEqual(['aborted', 'big', 'small']);
  });
});
