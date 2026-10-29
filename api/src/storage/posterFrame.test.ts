import { afterEach, describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import {
  extractPosterWebp,
  FFMPEG_FRAME_ARGS,
  PosterFrameTooLargeError,
  PosterFrameTimeoutError,
  setFfmpegRunnerForTests,
  setPosterTimeoutForTests,
} from './posterFrame';

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

async function pngFixture(): Promise<Uint8Array> {
  const buffer = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 48, g: 96, b: 160 },
    },
  }).png().toBuffer();
  return new Uint8Array(buffer);
}

afterEach(() => {
  setFfmpegRunnerForTests(null);
  setPosterTimeoutForTests(null);
});

describe('extractPosterWebp', () => {
  test('extracts frame zero with ffmpeg args and emits WebP bytes', async () => {
    const png = await pngFixture();
    const calls: { args: readonly string[]; input: Uint8Array }[] = [];
    setFfmpegRunnerForTests((args, input) => {
      calls.push({ args, input });
      return Promise.resolve(png);
    });

    const mp4 = new Uint8Array([0, 1, 2, 3]);
    const output = await extractPosterWebp(mp4);

    expect(calls).toEqual([{ args: FFMPEG_FRAME_ARGS, input: mp4 }]);
    expect(isWebp(output)).toBe(true);
    expect((await sharp(output).metadata()).format).toBe('webp');
  });

  test('rejects when frame extraction exceeds the timeout', async () => {
    setPosterTimeoutForTests(20);
    setFfmpegRunnerForTests((_args, _input, signal) => new Promise<Uint8Array>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      }, { once: true });
    }));

    let caught: unknown;
    try {
      await extractPosterWebp(new Uint8Array([0, 1, 2, 3]));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PosterFrameTimeoutError);
  });

  test('rejects over-cap frame output before Sharp decode', async () => {
    setFfmpegRunnerForTests(() => Promise.resolve(new Uint8Array([1, 2, 3, 4, 5])));

    let caught: unknown;
    try {
      await extractPosterWebp(new Uint8Array([0, 1, 2, 3]), { maxOutputBytes: 4 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PosterFrameTooLargeError);
  });
});
