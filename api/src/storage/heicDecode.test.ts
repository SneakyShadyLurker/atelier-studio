import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildHeifConvertArgs,
  decodeHeicToPng,
  setHeicDecoderForTests,
  setHeicShimConfigForTests,
  systemHeicDecoder,
  TranscodeTimeoutError,
} from './heicDecode';
import { ImageTooLargeError, UnsupportedImageError } from './normalizeUpload';

describe('buildHeifConvertArgs', () => {
  it('maps input and output paths', () => {
    expect(buildHeifConvertArgs('/tmp/in.heic', '/tmp/out.png')).toEqual(['/tmp/in.heic', '/tmp/out.png']);
  });
});

describe('TranscodeTimeoutError', () => {
  it('has the correct name', () => {
    expect(new TranscodeTimeoutError().name).toBe('TranscodeTimeoutError');
  });
});

const hasHeif = Bun.which('heif-convert') !== null;
const hasHeifEnc = Bun.which('heif-enc') !== null;
const hasSips = Bun.which('sips') !== null;

afterEach(() => { setHeicDecoderForTests(null); setHeicShimConfigForTests(null); });

// Subprocess lifecycle, exercised on any platform via an injected command so the
// timeout/abort/output-cap paths have real coverage on Linux/CI (no heif-convert).
describe('systemHeicDecoder lifecycle (injected command)', () => {
  const heic = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);

  function fixture(script: string, options: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
    let directory = '';
    setHeicShimConfigForTests({
      ...options,
      command: (inputPath, outputPath) => {
        directory = dirname(inputPath);
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        return [process.execPath, '-e', `
          const fs = require('node:fs');
          const path = require('node:path');
          const output = process.argv.at(-1);
          const directory = path.dirname(output);
          fs.mkdirSync(path.join(directory, 'extra'));
          fs.writeFileSync(path.join(directory, 'extra', 'plaintext'), 'scratch');
          ${script}
        `, inputPath, outputPath];
      },
    });
    return { directory: () => directory };
  }

  it('decodes a single output and recursively removes its private scratch directory', async () => {
    const job = fixture("fs.writeFileSync(output, 'decoded png');");
    const bytes = await systemHeicDecoder(heic, new AbortController().signal);
    expect(new TextDecoder().decode(bytes)).toBe('decoded png');
    expect(existsSync(job.directory())).toBe(false);
  });

  for (const includeBase of [false, true]) {
    it(`rejects numbered multi-image outputs and removes every sibling (base output: ${includeBase})`, async () => {
      const job = fixture(`
        fs.writeFileSync(output.replace('.png', '-1.png'), 'first');
        fs.writeFileSync(output.replace('.png', '-2.png'), 'second');
        ${includeBase ? "fs.writeFileSync(output, 'base');" : ''}
      `);
      const error = await systemHeicDecoder(heic, new AbortController().signal).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(UnsupportedImageError);
      expect(existsSync(job.directory())).toBe(false);
    });
  }

  it('maps a successful command with no output to UnsupportedImageError and cleans scratch', async () => {
    const job = fixture('');
    const error = await systemHeicDecoder(heic, new AbortController().signal).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(UnsupportedImageError);
    expect(existsSync(job.directory())).toBe(false);
  });

  it('removes siblings written before a subprocess error', async () => {
    const job = fixture("fs.writeFileSync(output.replace('.png', '-1.png'), 'first'); process.exit(1);");
    const error = await systemHeicDecoder(heic, new AbortController().signal).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(UnsupportedImageError);
    expect(existsSync(job.directory())).toBe(false);
  });

  for (const abort of [false, true]) {
    it(`reaps the child before recursively cleaning scratch on ${abort ? 'abort' : 'timeout'}`, async () => {
      const job = fixture(`
        fs.writeFileSync(output.replace('.png', '-1.png'), 'first');
        process.on('SIGTERM', () => {});
        fs.writeFileSync(path.join(directory, 'ready'), String(process.pid));
        setInterval(() => fs.writeFileSync(output.replace('.png', '-2.png'), 'second'), 5);
      `, { timeoutMs: abort ? 5_000 : 500 });
      const ac = new AbortController();
      const started = performance.now();
      // Attach the rejection observer before waiting for the child's ready file.
      const result = systemHeicDecoder(heic, ac.signal).catch((error: unknown) => error);
      while (!job.directory() || !existsSync(join(job.directory(), 'ready'))) {
        if (performance.now() - started > 2_000) throw new Error('fixture did not start');
        await Bun.sleep(5);
      }
      const pid = Number(await Bun.file(join(job.directory(), 'ready')).text());
      if (abort) ac.abort();
      const error = await result;
      if (abort) expect((error as Error).name).toBe('AbortError');
      else expect(error).toBeInstanceOf(TranscodeTimeoutError);
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(existsSync(job.directory())).toBe(false);
      await Bun.sleep(25);
      expect(existsSync(job.directory())).toBe(false);
    });
  }

  it('honors cancellation during the input write without spawning a child', async () => {
    const ac = new AbortController();
    let inputPath = '';
    let spawned = false;
    const write = Bun.write;
    const writeMock = spyOn(Bun, 'write').mockImplementationOnce(async (destination, data) => {
      if (typeof destination !== 'string') throw new Error('expected a scratch file path');
      if (!(data instanceof Uint8Array)) throw new Error('expected HEIC input bytes');
      inputPath = destination;
      const count = await write(destination, data);
      ac.abort();
      return count;
    });
    setHeicShimConfigForTests({ command: () => { spawned = true; return ['sleep', '30']; } });
    try {
      const error = await systemHeicDecoder(heic, ac.signal).catch((error: unknown) => error);
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(spawned).toBe(false);
      expect(inputPath).not.toBe('');
      expect(existsSync(dirname(inputPath))).toBe(false);
    } finally {
      writeMock.mockRestore();
    }
  });

  it('enforces a hard timeout by killing a hung process', async () => {
    setHeicShimConfigForTests({ command: () => ['sleep', '30'], timeoutMs: 100 });
    const start = Bun.nanoseconds();
    let caught: unknown;
    try {
      await systemHeicDecoder(heic, new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TranscodeTimeoutError);
    expect((Bun.nanoseconds() - start) / 1e9).toBeLessThan(5); // unblocked well before sleep 30
  });

  it('aborts a running process on signal', async () => {
    setHeicShimConfigForTests({ command: () => ['sleep', '30'], timeoutMs: 10_000 });
    const ac = new AbortController();
    setTimeout(() => { ac.abort(); }, 50);
    let caught: unknown;
    try {
      await systemHeicDecoder(heic, ac.signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
  });

  it('rejects an over-cap decoded output before reading it into memory', async () => {
    // Write ~8 KB to the output path; cap at 1 KB → ImageTooLargeError.
    setHeicShimConfigForTests({
      command: (_inputPath, outputPath) => ['sh', '-c', 'head -c 8192 /dev/zero > "$1"', 'sh', outputPath],
      maxOutputBytes: 1024,
    });
    let caught: unknown;
    try {
      await systemHeicDecoder(heic, new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImageTooLargeError);
  });

  it('surfaces a non-zero exit as UnsupportedImageError', async () => {
    setHeicShimConfigForTests({ command: () => ['sh', '-c', 'echo boom 1>&2; exit 1'] });
    let caught: unknown;
    try {
      await systemHeicDecoder(heic, new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).toBe('UnsupportedImageError');
  });
});

describe.if(hasHeif && hasHeifEnc)('systemHeicDecoder (native multi-image HEIC)', () => {
  it('rejects real numbered libheif outputs and removes the decoder scratch directory', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'atelier-heic-fixture-'));
    let decoderDirectory = '';
    try {
      const sharp = (await import('sharp')).default;
      const sources = [join(fixtureDirectory, 'first.png'), join(fixtureDirectory, 'second.png')];
      for (const [index, source] of sources.entries()) {
        await sharp({ create: {
          width: 64, height: 64, channels: 3,
          background: { r: 10 + index * 100, g: 20, b: 30 },
        } }).png().toFile(source);
      }
      const heic = join(fixtureDirectory, 'multiple.heic');
      const encoder = Bun.spawn(['heif-enc', '-o', heic, ...sources], {
        stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
        timeout: 10_000, killSignal: 'SIGKILL',
      });
      const [, code] = await Promise.all([new Response(encoder.stderr).text(), encoder.exited]);
      expect(code).toBe(0);
      setHeicShimConfigForTests({ command: (input, output) => {
        decoderDirectory = dirname(input);
        return ['heif-convert', ...buildHeifConvertArgs(input, output)];
      } });
      let caught: unknown;
      try {
        await systemHeicDecoder(await Bun.file(heic).bytes(), new AbortController().signal);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnsupportedImageError);
      // This specific error proves the real converter emitted numbered PNGs,
      // rather than failing conversion or merely producing no output.
      expect((caught as Error).message).toBe('multiple HEIC images are unsupported');
      expect(decoderDirectory).not.toBe('');
      expect(existsSync(decoderDirectory)).toBe(false);
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe.if(hasHeif && hasSips)('decodeHeicToPng (real binaries)', () => {
  it('decodes a real HEIC into PNG bytes', async () => {
    const src = `${Bun.env.TMPDIR ?? '/tmp'}/heic-src-${crypto.randomUUID()}.png`;
    const heic = `${Bun.env.TMPDIR ?? '/tmp'}/heic-${crypto.randomUUID()}.heic`;
    const sharp = (await import('sharp')).default;
    await sharp({ create: { width: 160, height: 120, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(src);
    await Bun.spawn(['sips', '-s', 'format', 'heic', src, '--out', heic]).exited;
    const input = await Bun.file(heic).bytes();
    const png = await decodeHeicToPng(input, new AbortController().signal);
    expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    await Bun.spawn(['rm', '-f', src, heic]).exited;
  });
});
