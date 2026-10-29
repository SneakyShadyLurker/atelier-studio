import { describe, expect, test } from 'bun:test';
import { jpegHasMpf, sniffImage } from '../storage/imageSniff';
import { animatedWebpBytes, mpoJpegBytes, multiImageWebpBytes, pngBytes, progressiveJpegBytes, webpVp8xBytes, webpVp8xOnlyBytes } from './image-fixtures';

describe('sniffImage', () => {
  test('accepts PNG with ancillary chunks and reads dimensions from IHDR', () => {
    expect(sniffImage(pngBytes(64, 32))).toEqual({
      ext: 'png',
      mime: 'image/png',
      width: 64,
      height: 32,
    });
  });

  test('accepts progressive JPEG by walking to SOF2', () => {
    expect(sniffImage(progressiveJpegBytes(80, 45))).toEqual({
      ext: 'jpg',
      mime: 'image/jpeg',
      width: 80,
      height: 45,
    });
  });

  test('accepts non-animated WebP VP8X and reads canvas dimensions', () => {
    expect(sniffImage(webpVp8xBytes(120, 90))).toEqual({
      ext: 'webp',
      mime: 'image/webp',
      width: 120,
      height: 90,
    });
  });

  test('rejects VP8X-only WebP metadata without a still-image bitstream', () => {
    expect(sniffImage(webpVp8xOnlyBytes())).toBeNull();
  });

  test('rejects animated WebP with VP8X ANIM flag', () => {
    expect(sniffImage(animatedWebpBytes())).toBeNull();
  });

  test('rejects multi-image WebP carrying ANMF chunks', () => {
    expect(sniffImage(multiImageWebpBytes())).toBeNull();
  });

  test('sniffs actual bytes, not the claimed mime', () => {
    expect(sniffImage(progressiveJpegBytes())).toMatchObject({ ext: 'jpg', mime: 'image/jpeg' });
    expect(sniffImage(pngBytes().slice(0, 12))).toBeNull();
  });

  test('rejects truncated headers', () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(sniffImage(progressiveJpegBytes().slice(0, 12))).toBeNull();
    expect(sniffImage(webpVp8xBytes().slice(0, 20))).toBeNull();
  });

  test('rejects dimensions above the 24 MP cap', () => {
    expect(sniffImage(pngBytes(6000, 5000))).toBeNull();
  });

  test('rejects header-only PNG without an IEND chunk', () => {
    // PNG signature + IHDR + 32 bytes padding (no IEND footer).
    const headerOnly = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 64, 0, 0, 0, 64,
      8, 2, 0, 0, 0,
      ...new Array(40).fill(0) as number[],
    ]);
    expect(sniffImage(headerOnly)).toBeNull();
  });

  test('still reads an MPO-flavored JPEG as jpeg (normalizeUpload owns the re-encode)', () => {
    expect(sniffImage(mpoJpegBytes(80, 45))).toMatchObject({ ext: 'jpg', mime: 'image/jpeg' });
  });

  test('rejects truncated JPEG with no EOI marker', () => {
    const valid = progressiveJpegBytes(80, 45);
    // Drop the trailing FF D9 EOI but keep enough length and a far-from-tail
    // padding so the EOI scan cannot find one anywhere near the file end.
    const stripped = valid.slice(0, valid.byteLength - 2);
    const padded = new Uint8Array(stripped.byteLength + 64);
    padded.set(stripped);
    expect(sniffImage(padded)).toBeNull();
  });
});

describe('jpegHasMpf', () => {
  test('flags a JPEG carrying an MPF APP2 segment', () => {
    expect(jpegHasMpf(mpoJpegBytes(80, 45))).toBe(true);
  });

  test('passes a plain progressive JPEG', () => {
    expect(jpegHasMpf(progressiveJpegBytes(80, 45))).toBe(false);
  });

  test('returns false for non-JPEG and truncated inputs', () => {
    expect(jpegHasMpf(pngBytes())).toBe(false);
    expect(jpegHasMpf(mpoJpegBytes(80, 45).slice(0, 8))).toBe(false);
  });
});
