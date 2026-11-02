import sharp from 'sharp';
import { MAX_IMAGE_PIXELS } from './imageSniff';

// libvips operation-cache is disabled process-wide by setupSharpDefaults()
// (thumbGen.ts) at server boot — no module-load side effect here.

// Longest-edge target for vision input to the text enhancer. ~1024px matches
// OpenAI's "high detail" tier and keeps the per-image token cost bounded; the
// enhancer only needs to recognise subject/composition/style, not pixel detail.
const MAX_EDGE = 1024;

export interface DownscaledImage {
  bytes: Uint8Array;
  mime: 'image/jpeg';
}

// Downscale an already-validated upload (sniffed + pixel-capped at upload time)
// to a small JPEG for vision input. `rotate()` bakes in EXIF orientation so the
// model sees the image upright. Never enlarges.
//
// Abort + pixel-limit hygiene mirrors storage/refDownscale.ts: libvips cannot
// interrupt an encode once toUint8Array() is in flight, so the signal is honoured
// up-front (refuse the work if the caller already aborted) rather than mid-pipe.
// `limitInputPixels` is defence in depth — stored uploads are already pixel-
// capped at upload time, but the bound keeps a single decode from ballooning.
export async function downscaleForVision(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<DownscaledImage> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
  const { data } = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toUint8Array();
  return { bytes: data, mime: 'image/jpeg' };
}
