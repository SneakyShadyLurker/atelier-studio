import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  writeAtomic,
  streamArtifact,
  deleteArtifact,
  InvalidArtifactIdError,
  InvalidUserIdError,
  namedArtifactDir,
  namedArtifactRoot,
} from '../storage/files';
import { rejectionOf, tempDir } from './helpers';

describe('artifact storage', () => {
  test('writes, reads, and idempotently deletes artifacts', async () => {
    const dataDir = tempDir();
    const userId = 'test.user@example';
    const tileId = crypto.randomUUID();
    const path = await writeAtomic(dataDir, 'images', userId, tileId, 'png', new TextEncoder().encode('bytes'));
    expect(path).toBe(join(dataDir, 'images', userId, `${tileId}.png`));
    expect(existsSync(path)).toBe(true);
    // On disk the artifact is age-encrypted to its owner, never plaintext.
    const onDisk = await Bun.file(path).text();
    expect(onDisk.startsWith('age-encryption.org/v1\n')).toBe(true);
    expect(onDisk.includes('bytes')).toBe(false);
    const artifact = await streamArtifact(dataDir, 'images', userId, tileId, 'png');
    expect(artifact).not.toBeNull();
    expect(artifact?.size).toBe(5);
    expect(artifact ? await new Response(artifact.stream).text() : null).toBe('bytes');
    deleteArtifact(dataDir, 'images', userId, tileId, 'png');
    deleteArtifact(dataDir, 'images', userId, tileId, 'png');
    expect(existsSync(path)).toBe(false);
  });

  test('named artifact roots and dirs are root-specific and reject unsafe user ids', () => {
    const dataDir = tempDir();
    expect(namedArtifactRoot(dataDir, 'images')).toBe(join(dataDir, 'images'));
    expect(namedArtifactRoot(dataDir, 'uploads')).toBe(join(dataDir, 'uploads'));
    expect(namedArtifactDir(dataDir, 'images', 'u')).toBe(join(dataDir, 'images', 'u'));
    expect(namedArtifactDir(dataDir, 'uploads', 'u')).toBe(join(dataDir, 'uploads', 'u'));
    expect(() => namedArtifactDir(dataDir, 'uploads', '..')).toThrow(InvalidUserIdError);
    expect(() => namedArtifactDir(dataDir, 'uploads', '/tmp/u')).toThrow(InvalidUserIdError);
  });

  test('writes uploads with the same artifact recipe and rejects unsafe artifact ids', async () => {
    const dataDir = tempDir();
    const userId = 'u';
    const uploadId = crypto.randomUUID();
    const path = await writeAtomic(dataDir, 'uploads', userId, uploadId, 'webp', new Uint8Array([1, 2, 3]));
    expect(path).toBe(join(dataDir, 'uploads', userId, `${uploadId}.webp`));
    expect(existsSync(path)).toBe(true);
    expect(await rejectionOf(streamArtifact(dataDir, 'uploads', userId, '..', 'webp'))).toBeInstanceOf(InvalidArtifactIdError);
    expect(() => {
      deleteArtifact(dataDir, 'uploads', userId, '/tmp/upload', 'webp');
    }).toThrow(InvalidArtifactIdError);
    let caught: unknown;
    try {
      await writeAtomic(dataDir, 'images', userId, '../tile', 'png', new Uint8Array([1]));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidArtifactIdError);
  });

  test('rejects unsafe user ids at the storage boundary', async () => {
    const dataDir = tempDir();
    const tileId = crypto.randomUUID();
    expect(await rejectionOf(streamArtifact(dataDir, 'images', '..', tileId, 'png'))).toBeInstanceOf(InvalidUserIdError);
    expect(() => {
      deleteArtifact(dataDir, 'images', 'bad/user', tileId, 'png');
    }).toThrow(InvalidUserIdError);
    let caught: unknown;
    try {
      await writeAtomic(dataDir, 'images', 'bad/user', tileId, 'png', new Uint8Array([1]));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidUserIdError);
  });
});
