import { describe, expect, test, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setStorageOpsForTests, streamArtifact, writeAtomic } from '../storage/files';
import { configureStorageKeyring, createUnsealedKeyring, MemoryUserKeyStore } from '../storage/crypto';
import { rejectionOf, tempDir } from './helpers';

afterEach(() => { setStorageOpsForTests(null); configureStorageKeyring(null); });

describe('atomic write fsync ordering', () => {
  test('awaits each async fsync — file fsync, rename, then parent-dir fsync', async () => {
    const events: string[] = [];
    let nextFd = 10;
    const fdKind = new Map<number, string>();
    setStorageOpsForTests({
      openSync: (path, flags) => {
        const fd = nextFd++;
        fdKind.set(fd, flags === 'r+' ? 'file' : 'dir');
        events.push(`open:${basename(String(path))}:${flags}`);
        return fd;
      },
      // Delayed-async fake: the event is pushed only when the promise
      // RESOLVES. If writeAtomic failed to `await` an fsync, the synchronous
      // renameSync below would record before this fsync event and the
      // `rename > fileFsync` assertion would fail — so this test genuinely
      // proves the fsync is awaited, not just that it was called.
      fsync: async (fd) => {
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        events.push(`fsync:${fdKind.get(fd)}`);
      },
      closeSync: (fd) => events.push(`close:${fdKind.get(fd)}`),
      renameSync: (from, to) => {
        events.push(`rename:${basename(String(from))}->${basename(String(to))}`);
        renameSync(from, to);
      },
    });
    const userId = 'u';
    const dataDir = tempDir();
    const artifactId = crypto.randomUUID();
    const plaintext = new Uint8Array(3 * 1024 * 1024 + 7).fill(19);
    const path = await writeAtomic(dataDir, 'uploads', userId, artifactId, 'png', plaintext);
    const fileFsync = events.indexOf('fsync:file');
    const rename = events.findIndex((event) => event.startsWith('rename:'));
    // The user dir is created fresh, which fsyncs the images root BEFORE the
    // rename (so the new <userId>/ entry is durable). The post-rename fsync
    // is the user dir itself — assert that the LAST fsync:dir lands after
    // the rename so the file's directory entry is journaled.
    const lastDirFsync = events.lastIndexOf('fsync:dir');
    expect(fileFsync).toBeGreaterThanOrEqual(0);
    expect(rename).toBeGreaterThan(fileFsync);
    expect(lastDirFsync).toBeGreaterThan(rename);
    expect(basename(dirname(path))).toBe(userId);
    expect(events).toContain(`open:${userId}:r`);
    expect(events).toContain('open:uploads:r');
    const artifact = await streamArtifact(dataDir, 'uploads', userId, artifactId, 'png');
    expect(artifact?.size).toBe(plaintext.length);
    expect(artifact ? new Uint8Array(await new Response(artifact.stream).arrayBuffer()) : null).toEqual(plaintext);
  });

  test('a rejecting fsync closes the descriptor and rejects writeAtomic before rename', async () => {
    const closed: number[] = [];
    let nextFd = 50;
    setStorageOpsForTests({
      openSync: () => nextFd++,
      fsync: () => Promise.reject(new Error('fsync boom')),
      closeSync: (fd) => { closed.push(fd); },
      renameSync: () => { throw new Error('rename must not run once an fsync has rejected'); },
    });
    let caught: unknown;
    try {
      await writeAtomic(tempDir(), 'uploads', 'u', crypto.randomUUID(), 'png', new Uint8Array([1]));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain('fsync boom');
    // The try/finally around every fsync still closes the descriptor on the
    // rejection path — no FD leak when a degraded disk fails an fsync.
    expect(closed.length).toBeGreaterThan(0);
  });

  test('atomic artifact writes round-trip a large artifact through the encryption stream', async () => {
    const keyring = await createUnsealedKeyring(new MemoryUserKeyStore());
    configureStorageKeyring(keyring);
    const dataDir = tempDir();
    const plaintext = new Uint8Array(3 * 1024 * 1024 + 11).fill(23);
    await writeAtomic(dataDir, 'images', 'alice', 'streamed', 'mp4', plaintext);
    const artifact = await streamArtifact(dataDir, 'images', 'alice', 'streamed', 'mp4');
    expect(artifact?.size).toBe(plaintext.length);
    expect(artifact ? new Uint8Array(await new Response(artifact.stream).arrayBuffer()) : null).toEqual(plaintext);
  });

  test('an encryption stream failure removes its partial temp and preserves the previous artifact', async () => {
    const keyring = await createUnsealedKeyring(new MemoryUserKeyStore());
    configureStorageKeyring(keyring);
    const dataDir = tempDir();
    const final = await writeAtomic(dataDir, 'images', 'alice', 'streamed', 'mp4', new Uint8Array([1, 2, 3]));
    let first = true;
    const failure = new Error('encryption stream failed');
    const streaming = spyOn(keyring, 'encryptStream').mockResolvedValue(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(new Uint8Array(128 * 1024));
          return;
        }
        await Bun.sleep(5);
        controller.error(failure);
      },
    }));
    try {
      expect(await rejectionOf(writeAtomic(dataDir, 'images', 'alice', 'streamed', 'mp4', new Uint8Array([4])))).toBe(failure);
      expect(existsSync(`${final}.tmp`)).toBe(false);
      const artifact = await streamArtifact(dataDir, 'images', 'alice', 'streamed', 'mp4');
      expect(artifact ? new Uint8Array(await new Response(artifact.stream).arrayBuffer()) : null).toEqual(new Uint8Array([1, 2, 3]));
    } finally { streaming.mockRestore(); }
  });

  test('a failed ciphertext write removes any partial temp before publication', async () => {
    const keyring = await createUnsealedKeyring(new MemoryUserKeyStore());
    configureStorageKeyring(keyring);
    const dataDir = tempDir();
    const dir = join(dataDir, 'uploads', 'alice');
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, 'streamed.png.tmp');
    await Bun.write(tmp, new Uint8Array([9]));
    const failure = new Error('ciphertext write failed');
    const write = spyOn(Bun, 'write').mockRejectedValueOnce(failure);
    try {
      expect(await rejectionOf(writeAtomic(dataDir, 'uploads', 'alice', 'streamed', 'png', new Uint8Array([4])))).toBe(failure);
      expect(existsSync(tmp)).toBe(false);
      expect(existsSync(join(dir, 'streamed.png'))).toBe(false);
    } finally { write.mockRestore(); }
  });
});
