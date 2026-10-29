import { afterEach, describe, expect, test } from 'bun:test';
import { MAX_UPLOAD_FILE_BYTES } from '@atelier/shared';
import {
  extractLastFramePng,
  FFMPEG_LAST_FRAME_ARGS,
  FFMPEG_LAST_FRAME_FALLBACK_ARGS,
  LastFrameCommandError,
  LastFrameTimeoutError,
  LastFrameTooLargeError,
  setLastFrameRunnerForTests,
  setLastFrameTimeoutForTests,
} from './lastFrame';

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

afterEach(() => {
  setLastFrameRunnerForTests(null);
  setLastFrameTimeoutForTests(null);
});

describe('extractLastFramePng', () => {
  test('seeks from EOF to extract the native-resolution last frame with the upload-size cap', async () => {
    const output = new Uint8Array([1, 2, 3]);
    let seen: readonly string[] = [];
    let seenCap = 0;
    setLastFrameRunnerForTests((args, _signal, maxOutputBytes) => {
      seen = args;
      seenCap = maxOutputBytes;
      return Promise.resolve(output);
    });
    expect(await extractLastFramePng('/tmp/source.mp4')).toBe(output);
    expect(seen).toEqual(FFMPEG_LAST_FRAME_ARGS('/tmp/source.mp4'));
    expect(seen).toContain('-sseof');
    // reverse must run INSIDE the -sseof window: -update is inert on pipe:1,
    // so without reverse the first frame of the window (~1s early) would win.
    expect(seen.indexOf('reverse')).toBeGreaterThan(seen.indexOf('-sseof'));
    expect(seen).not.toContain('-update');
    expect(seenCap).toBe(MAX_UPLOAD_FILE_BYTES);
  });

  test('falls back to reverse only when the EOF seek produces no frame', async () => {
    const output = new Uint8Array([1, 2, 3]);
    const calls: string[][] = [];
    setLastFrameRunnerForTests((args) => {
      calls.push([...args]);
      return Promise.resolve(calls.length === 1 ? new Uint8Array() : output);
    });

    expect(await extractLastFramePng('/tmp/source.mp4')).toBe(output);
    expect(calls).toEqual([
      [...FFMPEG_LAST_FRAME_ARGS('/tmp/source.mp4')],
      [...FFMPEG_LAST_FRAME_FALLBACK_ARGS('/tmp/source.mp4')],
    ]);
    expect(calls[1]).toContain('reverse');
  });

  test('surfaces ffmpeg nonzero failures', async () => {
    setLastFrameRunnerForTests(() => Promise.reject(new LastFrameCommandError('ffmpeg failed: bad')));
    const error = await captureError(() => extractLastFramePng('/tmp/source.mp4'));
    expect(error).toBeInstanceOf(LastFrameCommandError);
  });

  test('times out and aborts the runner', async () => {
    setLastFrameTimeoutForTests(10);
    let aborted = false;
    setLastFrameRunnerForTests((_args, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(abortReason(signal));
      }, { once: true });
    }));
    const error = await captureError(() => extractLastFramePng('/tmp/source.mp4'));
    expect(error).toBeInstanceOf(LastFrameTimeoutError);
    expect(aborted).toBe(true);
  });

  test('honors caller abort and the output cap', async () => {
    const controller = new AbortController();
    setLastFrameRunnerForTests((_args, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(abortReason(signal)); }, { once: true });
    }));
    const pending = extractLastFramePng('/tmp/source.mp4', { signal: controller.signal });
    controller.abort(new DOMException('stop', 'AbortError'));
    const abort = await captureError(() => pending);
    expect(abort).toHaveProperty('name', 'AbortError');

    setLastFrameRunnerForTests(() => Promise.resolve(new Uint8Array(5)));
    const tooLarge = await captureError(
      () => extractLastFramePng('/tmp/source.mp4', { maxOutputBytes: 4 }),
    );
    expect(tooLarge).toBeInstanceOf(LastFrameTooLargeError);
  });

  // Real-binary contract test: arg-shape assertions cannot prove which frame
  // comes out (the -update regression shipped green under them). testsrc2's
  // per-frame counter overlay makes every frame byte-distinct, so equality
  // with the full-clip reverse ground truth pins "the actual last frame".
  test('extracts the true last frame from a real clip (real ffmpeg)', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'atelier-lastframe-'));
    try {
      const clip = join(dir, 'clip.mp4');
      const make = Bun.spawnSync([
        'ffmpeg', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=64x64:rate=24',
        '-pix_fmt', 'yuv420p', '-y', clip,
      ]);
      expect(make.exitCode).toBe(0);

      const truth = Bun.spawnSync([
        'ffmpeg', '-nostdin', '-i', clip, '-vf', 'reverse', '-frames:v', '1',
        '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
      ]);
      expect(truth.exitCode).toBe(0);
      expect(truth.stdout.byteLength).toBeGreaterThan(0);

      const extracted = await extractLastFramePng(clip);
      writeFileSync(join(dir, 'extracted.png'), extracted);
      expect(Buffer.from(extracted).equals(Buffer.from(truth.stdout))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
