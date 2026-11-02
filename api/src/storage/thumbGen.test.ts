import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { MAX_IMAGE_PIXELS } from './imageSniff';
import { generateThumb, setupSharpDefaults, ThumbDecodeError } from './thumbGen';
import { detectKind, normalizeUpload, UnsupportedImageError } from './normalizeUpload';

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

async function caughtError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  return null;
}

async function pngFixture(width: number, height: number): Promise<Uint8Array> {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 48, g: 96, b: 160 },
    },
  }).png().toBuffer();
  return new Uint8Array(buffer);
}

async function oversizedPixelPng(): Promise<Uint8Array> {
  const buffer = await sharp({
    create: {
      width: MAX_IMAGE_PIXELS + 1,
      height: 1,
      channels: 3,
      background: { r: 48, g: 96, b: 160 },
    },
  }).png().toBuffer();
  return new Uint8Array(buffer);
}

describe('generateThumb', () => {
  test('process defaults block the native SVG loader when padding bypasses prefix sniffing', async () => {
    const paddedSvg = new TextEncoder().encode(`${' '.repeat(512)}<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>`);
    expect(detectKind(paddedSvg)).toBe('other');
    // The trusted fixture really reaches the SVG loader when it is enabled;
    // rejection after setup therefore proves native blocking, not bad input.
    sharp.unblock({ operation: ['VipsForeignLoadSvg'] });
    try {
      expect((await sharp(paddedSvg).metadata()).format).toBe('svg');
    } finally {
      setupSharpDefaults();
    }
    expect(await caughtError(sharp(paddedSvg).metadata())).toBeInstanceOf(Error);
    expect(await caughtError(normalizeUpload(paddedSvg, new AbortController().signal))).toBeInstanceOf(UnsupportedImageError);
    expect(await caughtError(generateThumb(paddedSvg))).toBeInstanceOf(ThumbDecodeError);
  });

  for (const format of ['jpeg', 'webp'] as const) {
    test(`native SVG blocking preserves ${format} decoding and thumbnail generation`, async () => {
      setupSharpDefaults();
      const png = await pngFixture(64, 32);
      const source = await sharp(png).toFormat(format).toBuffer();
      expect((await sharp(source).metadata()).format).toBe(format);
      const thumb = await generateThumb(source);
      expect((await sharp(thumb).metadata()).format).toBe('webp');
      expect((await sharp(thumb).metadata()).width).toBe(64);
    });
  }

  test('emits WebP bytes no wider than 1536px', async () => {
    const out = await generateThumb(await pngFixture(2400, 1600));
    const metadata = await sharp(out).metadata();
    expect(isWebp(out)).toBe(true);
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBeLessThanOrEqual(1536);
  });

  test('does not enlarge smaller source images', async () => {
    const out = await generateThumb(await pngFixture(320, 320));
    const metadata = await sharp(out).metadata();
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(320);
  });

  test('wraps undecodable input in ThumbDecodeError', async () => {
    let caught: unknown;
    try {
      await generateThumb(new Uint8Array([1, 2, 3, 4]));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ThumbDecodeError);
  });

  test('wraps images whose decoded pixel count exceeds the upload cap', async () => {
    let caught: unknown;
    try {
      await generateThumb(await oversizedPixelPng());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ThumbDecodeError);
  });

  test('throws signal.reason synchronously when signal is already aborted', async () => {
    const ac = new AbortController();
    const reason = new DOMException('pre-aborted', 'AbortError');
    ac.abort(reason);
    let caught: unknown;
    try {
      await generateThumb(await pngFixture(320, 320), ac.signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });
});
