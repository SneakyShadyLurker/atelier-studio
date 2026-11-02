import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../test/helpers';
import { ARTIFACT_NAME_RE, deleteArtifact, readArtifactBytes, writeAtomic } from './files';

describe('video artifact storage', () => {
  test('stores mp4 artifacts under images only', async () => {
    const dataDir = tempDir();
    const userId = 'test.user@example';
    const artifactId = 'vid1';
    const mp4Bytes = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

    const path = await writeAtomic(dataDir, 'images', userId, artifactId, 'mp4', mp4Bytes);

    expect(path).toBe(join(dataDir, 'images', userId, 'vid1.mp4'));
    expect(existsSync(path)).toBe(true);
    expect(ARTIFACT_NAME_RE.test('vid1.mp4')).toBe(true);

    const artifact = await readArtifactBytes(dataDir, 'images', userId, artifactId, 'mp4', 'video/mp4');
    expect(artifact?.bytes).toEqual(mp4Bytes);
    expect(artifact?.ext).toBe('mp4');
    expect(artifact?.mime).toBe('video/mp4');

    deleteArtifact(dataDir, 'images', userId, artifactId, 'mp4');
    expect(existsSync(path)).toBe(false);

    const assertUploadsRejectMp4 = (): void => {
      // @ts-expect-error uploads stay image-only and must reject video artifacts.
      void writeAtomic(dataDir, 'uploads', userId, artifactId, 'mp4', mp4Bytes);
    };
    expect(assertUploadsRejectMp4).toBeDefined();
  });
});
