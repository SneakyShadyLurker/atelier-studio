import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSequenceStitchArgs,
  sequenceMasterFrames,
  SequenceStitchCommandError,
  SequenceStitchTimeoutError,
  SequenceStitchTooLargeError,
  setSequenceStitchRunnerForTests,
  stitchSequence,
} from './stitchSequence';

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

/** Still-frame handoff segments: no guide head, so the legacy seam rules apply. */
function still(path: string, durationFrames: number) {
  return { path, durationFrames, contextFrames: 0 };
}

/** Native AddGuide continuation: carries a context head the stitcher must drop. */
function guided(path: string, durationFrames: number, contextFrames = 22) {
  return { path, durationFrames, contextFrames };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

afterEach(() => {
  setSequenceStitchRunnerForTests(null);
});

describe('stitchSequence', () => {
  test('builds seam-dedup, normalization, concat, and audio acrossfade filters', () => {
    const args = buildSequenceStitchArgs([still('/a.mp4', 24), still('/b.mp4', 24), still('/c.mp4', 24)]);
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('[0:v]trim=start_frame=0:end_frame=24,setpts=PTS-STARTPTS');
    expect(graph).toContain('[1:v]trim=start_frame=1:');
    expect(graph).toContain('[vraw1][vref0]scale2ref=flags=lanczos');
    expect(graph).toContain('[vraw2][vref1]scale2ref=flags=lanczos');
    expect(graph).toContain(`atrim=start=${(1 / 24).toFixed(9)}`);
    expect(graph).toContain('acrossfade=d=0.06');
    expect(graph).toContain('[ajoin2]apad=whole_dur=2.916666667[aout]');
    expect(graph).toContain('scale=');
    expect(graph).toContain('format=yuv420p');
    expect(graph).toContain('aresample=48000');
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args[args.indexOf('-map') + 3]).toBe('[aout]');
  });

  test('passes a full-video audio timeline to ffmpeg after seam-frame deduction', async () => {
    let recorded: readonly string[] = [];
    setSequenceStitchRunnerForTests((args) => {
      recorded = args;
      return Promise.resolve(new Uint8Array([1]));
    });

    await stitchSequence([still('/a.mp4', 24), still('/b.mp4', 24), still('/c.mp4', 24)], {
      timeoutBaselineMs: 100,
      maxOutputBytes: 10,
    });

    const graph = recorded[recorded.indexOf('-filter_complex') + 1] ?? '';
    // Three 24-frame segments lose one seam frame at each join: 72 - 2 = 70 frames.
    expect(graph).toContain(`apad=whole_dur=${(70 / 24).toFixed(9)}`);
  });

  test('surfaces ffmpeg failure and output-cap failure', async () => {
    setSequenceStitchRunnerForTests(() => Promise.reject(new SequenceStitchCommandError('bad')));
    const commandError = await captureError(() => stitchSequence([still('/a.mp4', 124), still('/b.mp4', 124)], {
      timeoutBaselineMs: 100,
      maxOutputBytes: 10,
    }));
    expect(commandError).toBeInstanceOf(SequenceStitchCommandError);

    setSequenceStitchRunnerForTests(() => Promise.resolve(new Uint8Array(11)));
    const tooLarge = await captureError(() => stitchSequence([still('/a.mp4', 124), still('/b.mp4', 124)], {
      timeoutBaselineMs: 100,
      maxOutputBytes: 10,
    }));
    expect(tooLarge).toBeInstanceOf(SequenceStitchTooLargeError);
  });

  test('scales the timeout and aborts a stuck runner', async () => {
    let aborted = false;
    setSequenceStitchRunnerForTests((_args, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(abortReason(signal));
      }, { once: true });
    }));
    const error = await captureError(() => stitchSequence([still('/a.mp4', 124), still('/b.mp4', 124)], {
      timeoutBaselineMs: 5,
      maxOutputBytes: 10,
    }));
    expect(error).toBeInstanceOf(SequenceStitchTimeoutError);
    expect(aborted).toBe(true);
  });

  test('drops the guide head and butt-joins audio on a native continuation', () => {
    const args = buildSequenceStitchArgs([still('/a.mp4', 124), guided('/b.mp4', 124)]);
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    // 22 frames of guide context come off the front, not the 1-frame seam.
    expect(graph).toContain('[1:v]trim=start_frame=22:');
    expect(graph).toContain(`atrim=start=${(22 / 24).toFixed(9)}`);
    // The soundtrack genuinely continues, so crossfading it would smear the join.
    expect(graph).toContain('[a0][a1]concat=n=2:v=0:a=1[ajoin1]');
    expect(graph).not.toContain('acrossfade');
  });

  test('delivers exactly the requested duration from a guided segment', () => {
    // 124 + 22 renders 158, but only frames 22..145 ship: the 22-frame head AND
    // the 12-frame grid overshoot are both dropped, so the link contributes 124.
    expect(sequenceMasterFrames([still('/a.mp4', 124), guided('/b.mp4', 124)])).toBe(124 + 124);
    // A still-frame join still pays the one-frame seam.
    expect(sequenceMasterFrames([still('/a.mp4', 124), still('/b.mp4', 124)])).toBe(124 + 123);
  });

  test('drops the grid overshoot off the end of a guided segment', () => {
    const args = buildSequenceStitchArgs([still('/a.mp4', 124), guided('/b.mp4', 124)]);
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('[1:v]trim=start_frame=22:end_frame=146');
    expect(graph).toContain(`:end=${(146 / 24).toFixed(9)}`);
    // A still-frame segment's end trim is a no-op, so legacy output is unchanged.
    expect(graph).toContain('[0:v]trim=start_frame=0:end_frame=124');
  });

  test('mixes guided and still-frame joins in one sequence', () => {
    const args = buildSequenceStitchArgs([still('/a.mp4', 124), guided('/b.mp4', 124), still('/c.mp4', 124)]);
    const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
    expect(graph).toContain('[1:v]trim=start_frame=22');
    expect(graph).toContain('[2:v]trim=start_frame=1:');
    expect(graph).toContain('[a0][a1]concat=n=2:v=0:a=1[ajoin1]');
    expect(graph).toContain('[ajoin1][a2]acrossfade=d=0.06');
  });

  test('encodes the master above x264 defaults', () => {
    const args = buildSequenceStitchArgs([still('/a.mp4', 124), still('/b.mp4', 124)]);
    expect(args[args.indexOf('-crf') + 1]).toBe('16');
    expect(args[args.indexOf('-preset') + 1]).toBe('slow');
    expect(args[args.indexOf('-b:a') + 1]).toBe('192k');
  });

  test('honors an external abort signal', async () => {
    const controller = new AbortController();
    setSequenceStitchRunnerForTests((_args, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(abortReason(signal)); }, { once: true });
    }));
    const pending = stitchSequence([still('/a.mp4', 124), still('/b.mp4', 124)], {
      timeoutBaselineMs: 1_000,
      maxOutputBytes: 10,
      signal: controller.signal,
    });
    controller.abort(new DOMException('stop', 'AbortError'));
    const error = await captureError(() => pending);
    expect(error).toHaveProperty('name', 'AbortError');
  });
});

/** Top-level ISO BMFF box types in file order (size 1 = 64-bit size, 0 = to end). */
function topLevelBoxes(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types: string[] = [];
  for (let offset = 0; offset + 8 <= bytes.byteLength;) {
    let size = view.getUint32(offset);
    types.push(new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8)));
    if (size === 1) size = Number(view.getBigUint64(offset + 8));
    else if (size === 0) size = bytes.byteLength - offset;
    if (size < 8) throw new Error(`malformed box at ${offset}`);
    offset += size;
  }
  return types;
}

describe('stitchSequence master file (real ffmpeg)', () => {
  test('writes a regular faststart MP4: moov before mdat, no fragments, temp file removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-stitch-'));
    try {
      const clips = ['a', 'b'].map((name, index) => {
        const path = join(dir, `${name}.mp4`);
        const make = Bun.spawnSync([
          'ffmpeg', '-nostdin', '-f', 'lavfi', '-i', `testsrc2=duration=1:size=64x64:rate=24`,
          '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 220}:duration=1`,
          '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', '-y', path,
        ]);
        expect(make.exitCode).toBe(0);
        return still(path, 24);
      });
      const master = await stitchSequence(clips, { timeoutBaselineMs: 60_000, maxOutputBytes: 64 * 1024 * 1024 });
      const boxes = topLevelBoxes(master);
      expect(boxes).toContain('moov');
      expect(boxes).toContain('mdat');
      expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
      expect(boxes).not.toContain('moof');
      expect(boxes).not.toContain('mfra');
      // Only the decrypted inputs remain; the master never outlives the call.
      expect(readdirSync(dir).sort()).toEqual(['a.mp4', 'b.mp4']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('the master is written into the private directory of the inputs, never to a pipe', () => {
    const args = buildSequenceStitchArgs([still('/private/x/0.mp4', 24), still('/private/x/1.mp4', 24)]);
    expect(args).not.toContain('pipe:1');
    expect(args.at(-1)).toMatch(/^\/private\/x\/[^/]+\.mp4$/);
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart');
  });
});
