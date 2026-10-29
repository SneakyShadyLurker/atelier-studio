import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { downscaleForVision } from './downscaleForVision';

async function pngOf(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();
  return new Uint8Array(buf);
}

describe('downscaleForVision', () => {
  test('shrinks a large image to <=1024px longest edge and returns JPEG', async () => {
    const input = await pngOf(3000, 1500);
    const out = await downscaleForVision(input);
    expect(out.mime).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(out.bytes)).metadata();
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(1024);
    expect(meta.format).toBe('jpeg');
  });

  test('does not enlarge a small image', async () => {
    const input = await pngOf(256, 128);
    const out = await downscaleForVision(input);
    const meta = await sharp(Buffer.from(out.bytes)).metadata();
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(128);
  });

  test('refuses work when the signal is already aborted', async () => {
    const input = await pngOf(256, 128);
    const ac = new AbortController();
    ac.abort(new DOMException('gone', 'AbortError'));
    let threw = false;
    try {
      await downscaleForVision(input, ac.signal);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
