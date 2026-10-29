import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { ImageTooLargeError, UnsupportedImageError } from './normalizeUpload';

const HEIC_DECODE_TIMEOUT_MS = 20_000;
// Cap the decoded PNG that heif-convert materializes before we read it into RAM.
// A small HEVC HEIC can decode to a gigapixel raster; the upstream pixel guards
// catch honest dimensions, and this bounds the case where the dimensions are not
// known until after decode. ~80 MP RGBA ≈ 320 MB, so allow some headroom.
const MAX_DECODED_OUTPUT_BYTES = 384 * 1024 * 1024;

export class TranscodeTimeoutError extends Error {
  constructor(message = 'transcode timed out') { super(message); this.name = 'TranscodeTimeoutError'; }
}

export type HeicDecoder = (input: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
export type HeifCommand = (inputPath: string, outputPath: string) => string[];

export function buildHeifConvertArgs(inputPath: string, outputPath: string): string[] {
  return [inputPath, outputPath];
}

interface HeicShimConfig {
  command: HeifCommand;
  timeoutMs: number;
  maxOutputBytes: number;
}

const DEFAULT_CONFIG: HeicShimConfig = {
  command: (inputPath, outputPath) => ['heif-convert', ...buildHeifConvertArgs(inputPath, outputPath)],
  timeoutMs: HEIC_DECODE_TIMEOUT_MS,
  maxOutputBytes: MAX_DECODED_OUTPUT_BYTES,
};

let shimConfig: HeicShimConfig = { ...DEFAULT_CONFIG };

// Override the subprocess command / timeout / output cap so the lifecycle
// (timeout, abort, output-size rejection) can be exercised on any platform
// without a real `heif-convert` binary. Pass null to restore defaults.
export function setHeicShimConfigForTests(overrides: Partial<HeicShimConfig> | null): void {
  shimConfig = overrides ? { ...DEFAULT_CONFIG, ...overrides } : { ...DEFAULT_CONFIG };
}

export const systemHeicDecoder: HeicDecoder = async (input, signal) => {
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'atelier-heic-'));
  const inputPath = join(directory, 'input.heic');
  const outputPath = join(directory, 'output.png');
  try {
    await chmod(directory, 0o700);
    signal.throwIfAborted();
    await Bun.write(inputPath, input);
    // Cancellation may arrive while the input write is suspended. Bun's native
    // signal handling also checks at spawn and kills a running child with SIGKILL.
    signal.throwIfAborted();
    const proc = Bun.spawn(shimConfig.command(inputPath, outputPath), {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      signal,
      killSignal: 'SIGKILL',
    });
    // SIGKILL (not SIGTERM) on both abort and timeout so a heif-convert that
    // ignores graceful termination cannot pin the upload slot. Race output
    // collection against the deadline, then reap the killed child before cleanup.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new TranscodeTimeoutError()); }, shimConfig.timeoutMs);
    });
    const work = Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    try {
      const [, stderr, code] = await Promise.race([work, deadline]);
      signal.throwIfAborted();
      if (code !== 0) throw new UnsupportedImageError(`heif-convert failed: ${stderr.slice(0, 200)}`);
    } finally {
      if (timer) clearTimeout(timer);
      // Never remove scratch files while the child can still write siblings.
      // Reap it after timeout/read failures as well as successful conversion.
      if (proc.exitCode === null) proc.kill('SIGKILL');
      await proc.exited;
    }
    signal.throwIfAborted();
    // libheif emits output-1.png, output-2.png for multi-image inputs. Reject
    // that shape rather than choosing an arbitrary image from the container.
    if ((await readdir(directory)).some((name) => /^output-\d+\.png$/.test(name))) {
      throw new UnsupportedImageError('multiple HEIC images are unsupported');
    }
    // Stat before read so a gigapixel decode can't be pulled into a Uint8Array.
    const outFile = Bun.file(outputPath);
    if (!await outFile.exists()) throw new UnsupportedImageError('HEIC decoder produced no image');
    if (outFile.size > shimConfig.maxOutputBytes) throw new ImageTooLargeError();
    const bytes = await outFile.bytes();
    signal.throwIfAborted();
    return bytes;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

let current: HeicDecoder = systemHeicDecoder;
export function setHeicDecoderForTests(decoder: HeicDecoder | null): void { current = decoder ?? systemHeicDecoder; }
export function decodeHeicToPng(input: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  return current(input, signal);
}
