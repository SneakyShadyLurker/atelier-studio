import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { MAX_IMAGE_PIXELS } from './imageSniff';
import { downscaleRefForGemini, RefDownscaleError } from './refDownscale';

async function largeNoisyImage(side: number): Promise<Uint8Array> {
  // Random pixel noise so JPEG/PNG can't compress its way back under the
  // threshold — solid colors collapse to a few KB regardless of resolution.
  const raw = new Uint8Array(side * side * 3);
  const chunk = 65536;
  for (let offset = 0; offset < raw.length; offset += chunk) {
    crypto.getRandomValues(raw.subarray(offset, Math.min(offset + chunk, raw.length)));
  }
  const buf = await sharp(raw, { raw: { width: side, height: side, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
  return new Uint8Array(buf);
}

async function oversizedPixelImage(): Promise<Uint8Array> {
  const width = MAX_IMAGE_PIXELS + 1;
  const buf = await sharp({
    create: {
      width,
      height: 1,
      channels: 3,
      background: { r: 16, g: 32, b: 64 },
    },
  }).png().toBuffer();
  const padded = new Uint8Array(1_200_001);
  padded.set(buf);
  return padded;
}

describe('downscaleRefForGemini', () => {
  test('passes through inputs already under the threshold', async () => {
    const small = new Uint8Array(1024).fill(0xab);
    const out = await downscaleRefForGemini({ bytes: small, mime: 'image/png' });
    expect(out.bytes).toBe(small);
    expect(out.mime).toBe('image/png');
  });

  test('downscales oversized inputs to JPEG under the threshold', async () => {
    const big = await largeNoisyImage(2400);
    expect(big.byteLength).toBeGreaterThan(1_200_000);
    const out = await downscaleRefForGemini({ bytes: big, mime: 'image/jpeg' });
    expect(out.mime).toBe('image/jpeg');
    expect(out.bytes.byteLength).toBeLessThanOrEqual(1_200_000);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBeLessThanOrEqual(2048);
    expect(meta.height).toBeLessThanOrEqual(2048);
  });

  test('rejects undecodable input with a typed error', async () => {
    // Pad past the threshold so the passthrough branch doesn't short-circuit.
    const fat = new Uint8Array(2_000_000);
    fat.set([0xde, 0xad, 0xbe, 0xef]);
    let caught: unknown;
    try {
      await downscaleRefForGemini({ bytes: fat, mime: 'image/png' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('RefDownscaleError');
  });

  test('rejects images whose decoded pixel count exceeds the upload cap', async () => {
    let caught: unknown;
    try {
      await downscaleRefForGemini({ bytes: await oversizedPixelImage(), mime: 'image/png' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RefDownscaleError);
  });

  test('throws signal.reason synchronously when signal is already aborted', async () => {
    const ac = new AbortController();
    const reason = new DOMException('pre-aborted', 'AbortError');
    ac.abort(reason);
    // Pre-aborted input must short-circuit even on the passthrough branch.
    const small = new Uint8Array(1024).fill(0xab);
    let caught: unknown;
    try {
      await downscaleRefForGemini({ bytes: small, mime: 'image/png' }, ac.signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });
});
