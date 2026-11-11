import { describe, expect, it, afterEach } from 'bun:test';
import sharp from 'sharp';
import { detectKind, targetResize, buildLadder, MAX_INPUT_PIXELS, normalizeUpload, UnsupportedImageError, ImageTooLargeError } from './normalizeUpload';
import { jpegHasMpf, MAX_IMAGE_PIXELS, sniffImage } from './imageSniff';
import { setHeicDecoderForTests } from './heicDecode';
import { twoFrameMpoBytes } from '../test/image-fixtures';

afterEach(() => { setHeicDecoderForTests(null); });

async function makePng(w: number, h: number, alpha = false): Promise<Uint8Array> {
  const channels = alpha ? 4 : 3;
  const background = alpha ? { r: 1, g: 2, b: 3, alpha: 0.5 } : { r: 1, g: 2, b: 3 };
  return new Uint8Array(await sharp({ create: { width: w, height: h, channels, background } }).png().toBuffer());
}

function ftyp(brand: string): Uint8Array {
  const head = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]; // size + 'ftyp'
  const b = brand.split('').map((c) => c.charCodeAt(0));
  return new Uint8Array([...head, ...b, 0, 0, 0, 0]);
}

describe('detectKind', () => {
  it('flags HEVC-brand ftyp as heic', () => {
    for (const brand of ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']) {
      expect(detectKind(ftyp(brand))).toBe('heic');
    }
  });
  it('treats avif ftyp as other (Sharp decodes AVIF)', () => {
    expect(detectKind(ftyp('avif'))).toBe('other');
  });
  it('routes a mif1-major HEIC (heic only in compatible brands) to the shim', () => {
    // size(0x20=32) + 'ftyp' + major 'mif1' + minor + compatible 'mif1','heic'
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
      0x6d, 0x69, 0x66, 0x31, 0x00, 0x00, 0x00, 0x00,
      0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(detectKind(bytes)).toBe('heic');
  });
  it('routes generic mif1/msf1/heif major brands to the shim', () => {
    for (const brand of ['mif1', 'msf1', 'heif']) {
      expect(detectKind(ftyp(brand))).toBe('heic');
    }
  });
  it('keeps a mif1 container whose compatible brands include avif in-process', () => {
    const bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
      0x6d, 0x69, 0x66, 0x31, 0x00, 0x00, 0x00, 0x00,
      0x6d, 0x69, 0x66, 0x31, 0x61, 0x76, 0x69, 0x66, // 'mif1','avif'
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(detectKind(bytes)).toBe('other');
  });
  it('flags svg by sniff', () => {
    expect(detectKind(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="...">'))).toBe('svg');
    expect(detectKind(new TextEncoder().encode('  <svg viewBox="0 0 1 1"></svg>'))).toBe('svg');
  });
  it('treats png bytes as other', () => {
    expect(detectKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('other');
  });
});

describe('targetResize', () => {
  it('returns null (no resize) for an in-cap image', () => {
    expect(targetResize(800, 600)).toBeNull();
  });
  it('scales an over-cap image to fit MAX_IMAGE_PIXELS', () => {
    const r = targetResize(10000, 8000); // 80 MP
    expect(r).not.toBeNull();
    if (r === null) throw new Error('r should not be null');
    expect(r.width * r.height).toBeLessThanOrEqual(MAX_IMAGE_PIXELS);
    expect(r.width).toBeLessThan(10000);
  });
});

describe('buildLadder', () => {
  it('opaque ladder is all jpeg, descending quality', () => {
    const l = buildLadder(false);
    expect(l.every((c) => c.ext === 'jpg')).toBe(true);
    expect(l[0]).toMatchObject({ ext: 'jpg', quality: 90, shrink: 1 });
  });
  it('alpha ladder leads png then lossless webp, with a lossy webp fallback', () => {
    const l = buildLadder(true);
    expect(l[0]).toMatchObject({ ext: 'png', shrink: 1 });
    expect(l[1]).toMatchObject({ ext: 'webp', lossless: true });
    // A lossy WebP step (preserves alpha, always shrinks bytes) must exist so a
    // large transparent image can never fall through to ImageTooLargeError.
    expect(l.some((c) => c.ext === 'webp' && c.lossless !== true && typeof c.quality === 'number')).toBe(true);
  });
});

describe('MAX_INPUT_PIXELS', () => {
  it('is 80 MP', () => { expect(MAX_INPUT_PIXELS).toBe(80 * 1024 * 1024); });
});

describe('normalizeUpload fast path', () => {
  it('passes a valid in-cap PNG through untouched', async () => {
    const buf = await makePng(32, 32);
    const out = await normalizeUpload(buf, new AbortController().signal);
    expect(out.bytes).toBe(buf);
    expect(out.sniffed.mime).toBe('image/png');
  });

  it('re-encodes a two-frame MPO instead of passing it through', async () => {
    // iOS JPEG exports can carry an MPF APP2 segment plus trailing frames
    // (MPO container), which the gpt-image upstream rejects — the fast path
    // must not ship it raw, and Sharp must decode just the primary frame.
    const mpo = await twoFrameMpoBytes(32, 32);
    expect(jpegHasMpf(mpo)).toBe(true);
    const out = await normalizeUpload(mpo, new AbortController().signal);
    expect(out.sniffed).toMatchObject({ mime: 'image/jpeg', width: 32, height: 32 });
    expect(jpegHasMpf(out.bytes)).toBe(false);
    expect(out.bytes.byteLength).toBeLessThan(mpo.byteLength);
  });
});

describe('normalizeUpload Sharp path', () => {
  it('transcodes an AVIF into a sniffable supported artifact (opaque -> jpeg)', async () => {
    const avif = new Uint8Array(await sharp({ create: { width: 100, height: 80, channels: 3, background: { r: 9, g: 9, b: 9 } } }).avif().toBuffer());
    const out = await normalizeUpload(avif, new AbortController().signal);
    expect(sniffImage(out.bytes)).not.toBeNull();
    expect(out.sniffed.mime).toBe('image/jpeg');
  });

  it('downscales an oversized PNG to fit the pixel + byte caps', async () => {
    const big = await makePng(7000, 5000); // 35 MP opaque
    const out = await normalizeUpload(big, new AbortController().signal);
    const sniffed = sniffImage(out.bytes);
    if (sniffed === null) throw new Error('expected sniffable output');
    expect(sniffed.width * sniffed.height).toBeLessThanOrEqual(24 * 1024 * 1024);
    expect(out.bytes.byteLength).toBeLessThanOrEqual(25 * 1024 * 1024);
  });

  it('keeps an oversized alpha image as png', async () => {
    const huge = await makePng(6000, 5000, true); // 30 MP RGBA -> slow path
    const out = await normalizeUpload(huge, new AbortController().signal);
    expect(out.sniffed.mime).toBe('image/png');
  });

  async function captureError(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (error) {
      return error;
    }
    throw new Error('expected the call to reject, but it resolved');
  }

  it('rejects svg', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    const error = await captureError(() => normalizeUpload(svg, new AbortController().signal));
    expect(error).toBeInstanceOf(UnsupportedImageError);
  });

  it('rejects bmp (unsupported by libvips here)', async () => {
    const bmp = new Uint8Array([0x42, 0x4d, 0x3a, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0]);
    const error = await captureError(() => normalizeUpload(bmp, new AbortController().signal));
    expect(error).toBeInstanceOf(UnsupportedImageError);
  });

  it('rejects a decode bomb by header before decoding', async () => {
    const bomb = new Uint8Array(await sharp({ create: { width: 11000, height: 11000, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer());
    const error = await captureError(() => normalizeUpload(bomb, new AbortController().signal));
    expect(error).toBeInstanceOf(ImageTooLargeError);
  });

  it('routes HEIC through the injected decoder', async () => {
    const fakePng = await makePng(64, 64);
    setHeicDecoderForTests(() => Promise.resolve(fakePng));
    const heic = new Uint8Array([0x00,0x00,0x00,0x18,0x66,0x74,0x79,0x70,0x68,0x65,0x69,0x63,0,0,0,0]);
    const out = await normalizeUpload(heic, new AbortController().signal);
    expect(out.sniffed.mime).toBe('image/jpeg');
  });

  it('rejects a HEIC that decodes above the input pixel ceiling (post-decode guard)', async () => {
    // The fake HEIC bypasses the pre-decode header guard (sharp can't parse the
    // stub); the decoded PNG is 90 MP (> 80 MP MAX_INPUT_PIXELS) and must be
    // rejected before the encode ladder runs.
    const huge = await makePng(10000, 9000); // 90 MP
    setHeicDecoderForTests(() => Promise.resolve(huge));
    const heic = new Uint8Array([0x00,0x00,0x00,0x18,0x66,0x74,0x79,0x70,0x68,0x65,0x69,0x63,0,0,0,0]);
    const error = await captureError(() => normalizeUpload(heic, new AbortController().signal));
    expect(error).toBeInstanceOf(ImageTooLargeError);
  });
});

describe('normalizeUpload output bytes', () => {
  // A source embedded at an offset in a larger buffer, as a multipart body
  // slice arrives: the encoder must read exactly the view, nothing around it.
  function asView(bytes: Uint8Array): Uint8Array {
    const backing = new Uint8Array(bytes.byteLength + 64).fill(0xab);
    backing.set(bytes, 32);
    return backing.subarray(32, 32 + bytes.byteLength);
  }
  async function noisyAvif(width: number, height: number, alpha: boolean): Promise<Uint8Array> {
    const channels = alpha ? 4 : 3;
    const raw = new Uint8Array(width * height * channels);
    for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2_654_435_761) >>> 24;
    return new Uint8Array(await sharp(raw, { raw: { width, height, channels } }).avif().toBuffer());
  }
  // The encode as it ran with Buffer copies of the input and output: first
  // ladder step, no resize (the fixtures are far below every cap).
  async function copyingReference(source: Uint8Array, alpha: boolean): Promise<Uint8Array> {
    const [step] = buildLadder(alpha);
    if (!step) throw new Error('empty ladder');
    let pipeline = sharp(Buffer.from(source), { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
    pipeline = step.ext === 'png' ? pipeline.png() : pipeline.jpeg({ quality: step.quality ?? 90 });
    return new Uint8Array(await pipeline.toBuffer());
  }

  it.each([
    ['opaque AVIF to JPEG', false],
    ['alpha AVIF to PNG', true],
  ] as const)('%s output is byte-identical to the copying encode', async (_label, alpha) => {
    const source = asView(await noisyAvif(96, 64, alpha));
    const out = await normalizeUpload(source, new AbortController().signal);
    expect(Array.from(out.bytes)).toEqual(Array.from(await copyingReference(source, alpha)));
  });

  it('a decoded HEIC output is byte-identical to the copying encode', async () => {
    const png = asView(await makePng(40, 30));
    setHeicDecoderForTests(() => Promise.resolve(png));
    const out = await normalizeUpload(asView(ftyp('heic')), new AbortController().signal);
    expect(Array.from(out.bytes)).toEqual(Array.from(await copyingReference(png, false)));
  });
});
