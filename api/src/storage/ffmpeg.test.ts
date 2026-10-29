import { describe, expect, test } from 'bun:test';
import { FfmpegOutputTooLargeError, readStreamWithCap } from './ffmpeg';

function streamOf(...chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
}

describe('readStreamWithCap', () => {
  test('concatenates chunks within the cap', async () => {
    const bytes = await readStreamWithCap(streamOf([1, 2], [3], [4, 5, 6]), 6);
    expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('rejects output above the cap', async () => {
    const error = await readStreamWithCap(streamOf([1, 2], [3, 4]), 3).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(FfmpegOutputTooLargeError);
  });

  test('an oversized cap override still reads instead of failing the reservation', async () => {
    const bytes = await readStreamWithCap(streamOf([7, 8]), 8 * 1024 * 1024 * 1024);
    expect([...bytes]).toEqual([7, 8]);
  });
});
