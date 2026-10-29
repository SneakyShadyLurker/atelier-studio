import sharp, { type Metadata } from 'sharp';
import { jpegHasMpf, MAX_IMAGE_PIXELS, sniffImage } from './imageSniff';
import type { SniffedImage } from './imageSniff';
import type { TileExt, TileMime } from '@atelier/shared';
import { MAX_UPLOAD_FILE_BYTES } from '@atelier/shared';
import { decodeHeicToPng } from './heicDecode';

// libvips operation-cache is disabled process-wide by setupSharpDefaults()
// (thumbGen.ts) at server boot — the single owner of process-global Sharp
// config. No module-load side effect here.

// Per-slot decode ceiling. Worst-case decode buffer ≈ MAX_INPUT_PIXELS × 4 bytes
// (RGBA): at 80 MP that's ~320 MB per concurrent upload slot (~1.3 GB across the
// 4-slot pool). Larger inputs are rejected before a full raster is materialized
// (header guard for honest dims; post-decode guard + bounded heif-convert output
// for HEIC). Covers ≤64 MP phone cameras with margin.
export const MAX_INPUT_PIXELS = 80 * 1024 * 1024;

export class UnsupportedImageError extends Error {
  constructor(message = 'unsupported image') { super(message); this.name = 'UnsupportedImageError'; }
}
export class ImageTooLargeError extends Error {
  constructor(message = 'image too large') { super(message); this.name = 'ImageTooLargeError'; }
}

export type SourceKind = 'heic' | 'svg' | 'other';

// Brands that require HEVC decode, which Sharp's prebuilt libvips can't do → HEIC shim.
const HEVC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']);
// AVIF (AV1) — Sharp decodes these in-process; keep them off the shim.
const AVIF_BRANDS = new Set(['avif', 'avis']);
// Generic HEIF/ISO-BMFF brands with no codec hint. Many non-Apple HEICs and
// HEIF sequences carry `mif1`/`msf1`/`heif` as the MAJOR brand and put `heic`
// only in compatible brands. heif-convert decodes both HEVC and AV1, so route
// these to the shim — Sharp can't do HEVC. (AVIF is caught above and stays
// in-process.)
const GENERIC_HEIF_BRANDS = new Set(['mif1', 'msf1', 'heif']);

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const c = bytes[offset + i];
    if (c === undefined) return out;
    out += String.fromCharCode(c);
  }
  return out;
}

function ftypBrands(bytes: Uint8Array): Set<string> {
  // ftyp box: [size:4][ 'ftyp':4 ][ major:4 ][ minor:4 ][ compatible brands... ].
  const boxSize = (((bytes[0] ?? 0) << 24) >>> 0) + ((bytes[1] ?? 0) << 16) + ((bytes[2] ?? 0) << 8) + (bytes[3] ?? 0);
  const end = Math.min(bytes.byteLength, boxSize > 8 ? boxSize : bytes.byteLength);
  const brands = new Set<string>();
  brands.add(asciiAt(bytes, 8, 4)); // major brand
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    brands.add(asciiAt(bytes, offset, 4)); // compatible brands
  }
  return brands;
}

export function detectKind(bytes: Uint8Array): SourceKind {
  if (asciiAt(bytes, 4, 4) === 'ftyp') {
    const brands = ftypBrands(bytes);
    for (const brand of brands) if (HEVC_BRANDS.has(brand)) return 'heic';
    for (const brand of brands) if (AVIF_BRANDS.has(brand)) return 'other';
    for (const brand of brands) if (GENERIC_HEIF_BRANDS.has(brand)) return 'heic';
    return 'other';
  }
  const head = asciiAt(bytes, 0, Math.min(bytes.byteLength, 256)).toLowerCase();
  if (head.includes('<svg')) return 'svg';
  return 'other';
}

export interface ResizeTarget { width: number; height: number; }

export function targetResize(width: number, height: number): ResizeTarget | null {
  const pixels = width * height;
  if (pixels <= MAX_IMAGE_PIXELS) return null;
  const scale = Math.sqrt(MAX_IMAGE_PIXELS / pixels);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export interface LadderStep {
  ext: TileExt;
  mime: TileMime;
  quality?: number;
  lossless?: boolean;
  shrink: number;
}

export function buildLadder(hasAlpha: boolean): LadderStep[] {
  if (hasAlpha) {
    // PNG/lossless-WebP first (best fidelity), then LOSSY WebP — which still
    // preserves alpha — so a large/noisy transparent image always fits the
    // 25 MB cap instead of hard-failing with ImageTooLargeError.
    return [
      { ext: 'png', mime: 'image/png', shrink: 1 },
      { ext: 'webp', mime: 'image/webp', lossless: true, shrink: 1 },
      { ext: 'webp', mime: 'image/webp', quality: 90, shrink: 1 },
      { ext: 'webp', mime: 'image/webp', quality: 80, shrink: 0.8 },
    ];
  }
  return [
    { ext: 'jpg', mime: 'image/jpeg', quality: 90, shrink: 1 },
    { ext: 'jpg', mime: 'image/jpeg', quality: 80, shrink: 1 },
    { ext: 'jpg', mime: 'image/jpeg', quality: 70, shrink: 0.85 },
  ];
}

export interface NormalizeResult {
  bytes: Uint8Array;
  sniffed: SniffedImage;
}

export async function normalizeUpload(input: Uint8Array, signal: AbortSignal): Promise<NormalizeResult> {
  const fast = sniffImage(input);
  // An MPO container (JPEG with an MPF APP2 segment) sniffs as plain JPEG but
  // is rejected by the gpt-image upstream, so it must not pass through raw —
  // the Sharp ladder below decodes only the primary frame, stripping the MPF
  // payload and trailing frames.
  const isMpo = fast?.ext === 'jpg' && jpegHasMpf(input);
  if (fast && !isMpo && input.byteLength <= MAX_UPLOAD_FILE_BYTES) return { bytes: input, sniffed: fast };

  const kind = detectKind(input);
  if (kind === 'svg') throw new UnsupportedImageError('svg is not supported');

  // Decode-bomb guard via header dims (sharp reads HEIC dims without decoding pixels).
  // For HEIC, a metadata failure just means the stub is too short to parse dims — still
  // route through the decoder; the post-decode metadata check will catch oversized inputs.
  let headerW = 0;
  let headerH = 0;
  try {
    const headerMeta = await sharp(Buffer.from(input)).metadata();
    headerW = headerMeta.width;
    headerH = headerMeta.height;
  } catch {
    if (kind !== 'heic') throw new UnsupportedImageError('unreadable image');
  }
  if (headerW > 0 && headerH > 0 && headerW * headerH > MAX_INPUT_PIXELS) throw new ImageTooLargeError();

  signal.throwIfAborted();

  const decoded = kind === 'heic' ? Buffer.from(await decodeHeicToPng(input, signal)) : Buffer.from(input);

  let meta: Metadata;
  try {
    meta = await sharp(decoded, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (error) {
    if (error instanceof Error && /pixel|limit/i.test(error.message)) throw new ImageTooLargeError();
    throw new UnsupportedImageError('decode failed');
  }
  if (meta.format === 'svg') throw new UnsupportedImageError('svg is not supported');

  const baseW = meta.width;
  const baseH = meta.height;
  // Post-decode decode-bomb guard. The pre-decode header guard can be skipped
  // when sharp can't parse the source header (notably a HEIC whose container
  // sharp won't read but heif-convert decodes anyway); the decoded raster's
  // true dimensions are checked here before the encode ladder runs.
  if (baseW * baseH > MAX_INPUT_PIXELS) throw new ImageTooLargeError();
  const resize = targetResize(baseW, baseH);
  const hasAlpha = meta.hasAlpha;

  for (const step of buildLadder(hasAlpha)) {
    signal.throwIfAborted();
    let pipeline = sharp(decoded, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
    if (resize) {
      pipeline = pipeline.resize({
        width: Math.max(1, Math.floor(resize.width * step.shrink)),
        height: Math.max(1, Math.floor(resize.height * step.shrink)),
        fit: 'inside',
        withoutEnlargement: true,
      });
    } else if (step.shrink !== 1) {
      pipeline = pipeline.resize({ width: Math.max(1, Math.floor(baseW * step.shrink)), fit: 'inside', withoutEnlargement: true });
    }
    if (step.ext === 'jpg') pipeline = pipeline.jpeg({ quality: step.quality ?? 90 });
    else if (step.ext === 'png') pipeline = pipeline.png();
    else pipeline = pipeline.webp(step.lossless ? { lossless: true } : { quality: step.quality ?? 80 });

    let out: Uint8Array;
    try {
      out = new Uint8Array(await pipeline.toBuffer());
    } catch (error) {
      if (error instanceof Error && /pixel|limit/i.test(error.message)) throw new ImageTooLargeError();
      throw new UnsupportedImageError('encode failed');
    }
    if (out.byteLength > MAX_UPLOAD_FILE_BYTES) continue;
    const sniffed = sniffImage(out);
    if (sniffed) return { bytes: out, sniffed };
  }
  throw new ImageTooLargeError();
}
