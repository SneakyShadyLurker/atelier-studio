import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildVideoTailArgs,
  extractVideoTail,
  setVideoTailRunnerForTests,
  VideoTailCommandError,
  VideoTailTimeoutError,
  VideoTailTooLargeError,
} from './videoTail';

afterEach(() => {
  setVideoTailRunnerForTests(null);
});

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

describe('buildVideoTailArgs', () => {
  test('cuts video and audio from the same instant at the end of the clip', () => {
    const args = buildVideoTailArgs('/seg.mp4', 124, 22);
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('trim=start_frame=102');
    expect(graph).toContain(`atrim=start=${(102 / 24).toFixed(9)}`);
    // Both streams must end together, or the guide's audio anchor drifts.
    expect(args[args.indexOf('-frames:v') + 1]).toBe('22');
  });

  test('clamps rather than fails when the clip is shorter than the head', () => {
    const graph = buildVideoTailArgs('/seg.mp4', 10, 22)[
      buildVideoTailArgs('/seg.mp4', 10, 22).indexOf('-filter_complex') + 1
    ] ?? '';
    expect(graph).toContain('trim=start_frame=0');
  });

  test('cuts back from the delivered endpoint of a guided predecessor', () => {
    // A guided segment renders 158 frames but only delivers frames 22..145, so
    // the handoff must end at 146 — anchoring on the file's last frame would
    // continue from 12 frames the stitcher already threw away.
    const args = buildVideoTailArgs('/seg.mp4', 22 + 124, 22);
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('trim=start_frame=124');
  });

  test('rejects a non-positive context length', () => {
    expect(() => buildVideoTailArgs('/seg.mp4', 124, 0)).toThrow();
  });
});

describe('extractVideoTail', () => {
  test('rejects an empty result rather than uploading a zero-frame guide', async () => {
    setVideoTailRunnerForTests(() => Promise.resolve(new Uint8Array(0)));
    const error = await captureError(() => extractVideoTail('/seg.mp4', {
      sourceEndFrame: 124, contextFrames: 22, timeoutMs: 100, maxOutputBytes: 10,
    }));
    expect(error).toBeInstanceOf(VideoTailCommandError);
  });

  test('enforces the output cap and the timeout', async () => {
    setVideoTailRunnerForTests(() => Promise.resolve(new Uint8Array(11)));
    expect(await captureError(() => extractVideoTail('/seg.mp4', {
      sourceEndFrame: 124, contextFrames: 22, timeoutMs: 100, maxOutputBytes: 10,
    }))).toBeInstanceOf(VideoTailTooLargeError);

    setVideoTailRunnerForTests((_args, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason as Error); }, { once: true });
    }));
    expect(await captureError(() => extractVideoTail('/seg.mp4', {
      sourceEndFrame: 124, contextFrames: 22, timeoutMs: 5, maxOutputBytes: 10,
    }))).toBeInstanceOf(VideoTailTimeoutError);
  });
});
