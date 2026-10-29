import sharp from 'sharp';
import type { TileMime } from '@atelier/shared';
import { MAX_IMAGE_PIXELS } from './imageSniff';

// Gemini's inline payload ceiling is ~20 MB total across all parts. Base64
// expansion is 4/3, so a 1.2 MB raw target lands at ~1.6 MB encoded — 10 refs
// reach ~16 MB wire, leaving ~4 MB for the prompt + JSON envelope. Anything
// already under the threshold passes through untouched.
const TARGET_BYTES = 1_200_000;

// Ordered fallback ladder: real photos succeed on attempt 0; high-entropy
// inputs (noise, fine textures) iterate down. Last entry is the final answer
// even if still above target — caller can decide to surface a 400.
const ATTEMPTS: readonly { dim: number; quality: number }[] = [
  { dim: 2048, quality: 85 },
  { dim: 1600, quality: 75 },
  { dim: 1280, quality: 65 },
];

export class RefDownscaleError extends Error {
  constructor(public override readonly cause: unknown) {
    super('reference image downscale failed');
    this.name = 'RefDownscaleError';
  }
}

export interface RefImagePayload {
  bytes: Uint8Array;
  mime: TileMime;
}

export async function downscaleRefForGemini(
  input: RefImagePayload,
  signal?: AbortSignal,
): Promise<RefImagePayload> {
  // Sharp's libvips thread cannot be interrupted once toUint8Array() is in
  // flight; the next-best behaviour is to refuse the next attempt in the
  // fallback ladder once the caller's signal aborts. The first encode
  // already running runs to completion, but the rest of the ladder bails.
  if (signal?.aborted) throw signal.reason;
  if (input.bytes.byteLength <= TARGET_BYTES) return input;
  let best: Uint8Array | null = null;
  try {
    for (const { dim, quality } of ATTEMPTS) {
      // Only abort point that can fire: sharp's builder calls below are
      // synchronous and lazy, so the signal can't transition between them.
      // Honoring abort here refuses the next ladder attempt; the encode in
      // flight runs to completion (libvips is uninterruptible).
      if (signal?.aborted) throw signal.reason;
      const pipeline = sharp(input.bytes, { limitInputPixels: MAX_IMAGE_PIXELS });
      // EXIF orientation must bake in before resize; otherwise tall phone
      // photos arrive sideways after sharp drops the EXIF block on encode.
      pipeline.rotate();
      pipeline.resize(dim, dim, { fit: 'inside', withoutEnlargement: true });
      pipeline.jpeg({ quality });
      const { data } = await pipeline.toUint8Array();
      best = data;
      if (best.byteLength <= TARGET_BYTES) break;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new RefDownscaleError(error);
  }
  if (!best) throw new RefDownscaleError(new Error('no attempts ran'));
  return { bytes: best, mime: 'image/jpeg' };
}
