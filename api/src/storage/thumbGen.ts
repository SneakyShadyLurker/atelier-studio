import sharp from 'sharp';
import { MAX_IMAGE_PIXELS } from './imageSniff';

// libvips' file/operation cache is hit-rate-dependent and tile IDs are UUIDs
// (no repeated decodes), so the cache only retains RSS. Disable it. The
// concurrency setting bounds libvips' internal thread fan-out per encode —
// the thumb runtime already caps in-flight encodes at MAX_CONCURRENT_THUMB_GEN,
// so each encode running on >1 thread just oversubscribes the single event
// loop sharing the libuv pool. 2 keeps webp encode reasonably fast without
// starving the rest of the server.
// Coupling: sharp's async encodes draw from the SAME libuv pool as fs
// (writeAtomic fsync) + crypto. Worst case MAX_CONCURRENT_THUMB_GEN(4) x
// concurrency(2) = 8 pool threads on webp; default pool is 4, so a /thumb
// herd would starve unrelated fs/crypto. infra/docker/docker-compose.yml
// pins UV_THREADPOOL_SIZE=16 for headroom — keep the two in sync.
// Invoked from server boot exactly once. The previous module-load side
// effect ordering was fragile against test-only imports; an explicit setup
// hook keeps the call site auditable.
export function setupSharpDefaults(): void {
  // SVG is unsupported throughout Atelier. Block the native loader before
  // metadata parsing, including inputs whose prefix sniff misses padded XML.
  sharp.block({ operation: ['VipsForeignLoadSvg'] });
  sharp.cache(false);
  sharp.concurrency(2);
}

const THUMB_WIDTH = 1536;
const WEBP_QUALITY = 85;
const NEUTRAL_POSTER_WIDTH = 320;
const NEUTRAL_POSTER_HEIGHT = 180;

export class ThumbDecodeError extends Error {
  constructor(public override readonly cause: unknown) {
    super('thumb generation failed');
    this.name = 'ThumbDecodeError';
  }
}

export async function generateThumb(
  srcBytes: Uint8Array,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  // Sharp's builder calls are synchronous and lazy, so the signal can't
  // transition between them; the one meaningful abort point is here, before
  // any work is queued. Once `.toUint8Array()` is in flight libvips owns the
  // worker thread and runs to completion (no per-call abort hook).
  if (signal?.aborted) throw signal.reason;
  try {
    const pipeline = sharp(srcBytes, { limitInputPixels: MAX_IMAGE_PIXELS });
    pipeline.resize(THUMB_WIDTH, null, { withoutEnlargement: true, fit: 'inside' });
    pipeline.webp({ quality: WEBP_QUALITY, effort: 4 });
    const { data } = await pipeline.toUint8Array();
    return data;
  } catch (error) {
    throw new ThumbDecodeError(error);
  }
}

let neutralPosterPromise: Promise<Uint8Array> | null = null;

export function neutralPosterWebp(): Promise<Uint8Array> {
  neutralPosterPromise ??= sharp({
    create: {
      width: NEUTRAL_POSTER_WIDTH,
      height: NEUTRAL_POSTER_HEIGHT,
      channels: 3,
      background: { r: 33, g: 36, b: 42 },
    },
  })
    .webp({ quality: 80, effort: 4 })
    .toUint8Array()
    .then(({ data }) => data);
  return neutralPosterPromise;
}
