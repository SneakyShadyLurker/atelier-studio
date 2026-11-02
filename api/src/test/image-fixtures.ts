import sharp from 'sharp';

/** Flat mid-gray PNG used to exercise valid low-variance image handling. */
export async function grayCardPng(size = 4): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: size, height: size, channels: 3, background: { r: 108, g: 108, b: 108 } },
  }).png().toBuffer();
  return new Uint8Array(buf);
}

function ascii(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0));
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u16be(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function u24le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

function riff(chunks: readonly number[]): Uint8Array {
  return new Uint8Array([...ascii('RIFF'), ...u32le(chunks.length + 4), ...ascii('WEBP'), ...chunks]);
}

function webpChunk(type: string, payload: readonly number[]): number[] {
  return [...ascii(type), ...u32le(payload.length), ...payload, ...(payload.length % 2 === 1 ? [0] : [])];
}

export function pngBytes(width = 64, height = 64, totalBytes?: number): Uint8Array {
  // Layout: signature + IHDR + tEXt(padding) + IEND. Padding lives inside
  // a tEXt chunk so the file always ends at the canonical IEND footer
  // (length=0 + 'IEND' + 4-byte CRC) — sniffPng requires that tail.
  const minimal = 8 + 25 + 12 + 12; // signature + IHDR(25) + empty tEXt(12) + IEND(12) = 57
  const padLen = totalBytes !== undefined && totalBytes > minimal ? totalBytes - minimal : 0;
  const padding = new Array(padLen).fill(0) as number[];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13),
    ...ascii('IHDR'),
    ...u32be(width),
    ...u32be(height),
    8, 2, 0, 0, 0,
    0, 0, 0, 0,
    ...u32be(padLen),
    ...ascii('tEXt'),
    ...padding,
    0, 0, 0, 0,
    ...u32be(0),
    ...ascii('IEND'),
    0, 0, 0, 0,
  ]);
}

export function progressiveJpegBytes(width = 64, height = 64): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, ...u16be(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xfe, ...u16be(6), ...ascii('test'),
    0xff, 0xc2, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3,
    1, 0x11, 0,
    2, 0x11, 0,
    3, 0x11, 0,
    0xff, 0xd9,
  ]);
}

/**
 * Splices a CIPA MPF APP2 segment ("MPF\0" identifier + stub MP index) right
 * after SOI, turning any JPEG into an MPO-flavored one — the marker layout iOS
 * uses when embedding HDR gain maps in JPEG exports.
 */
export function withMpfSegment(jpeg: Uint8Array): Uint8Array {
  const app2 = new Uint8Array([0xff, 0xe2, ...u16be(14), ...ascii('MPF'), 0, ...(new Array(8).fill(0) as number[])]);
  const out = new Uint8Array(jpeg.byteLength + app2.byteLength);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(app2, 2);
  out.set(jpeg.subarray(2), 2 + app2.byteLength);
  return out;
}

export function mpoJpegBytes(width = 64, height = 64): Uint8Array {
  return withMpfSegment(progressiveJpegBytes(width, height));
}

/**
 * Genuine two-frame MPO container: the primary JPEG carries the MPF APP2
 * segment and a full second JPEG stream follows its EOI, matching the file
 * layout of real iPhone HDR exports. Both frames must be decodable, so they
 * are built with Sharp rather than the hand-rolled progressive stub.
 */
export async function twoFrameMpoBytes(width = 32, height = 32): Promise<Uint8Array> {
  const frame = async (r: number) => new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r, g: 2, b: 3 } } }).jpeg().toBuffer(),
  );
  const primary = withMpfSegment(await frame(1));
  const second = await frame(200);
  const out = new Uint8Array(primary.byteLength + second.byteLength);
  out.set(primary, 0);
  out.set(second, primary.byteLength);
  return out;
}

export function webpVp8xBytes(width = 64, height = 64): Uint8Array {
  const vp8x = webpChunk('VP8X', [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
  const vp8l = webpChunk('VP8L', vp8lPayload(width, height));
  return riff([...vp8x, ...vp8l]);
}

export function webpVp8xOnlyBytes(width = 64, height = 64): Uint8Array {
  const vp8x = webpChunk('VP8X', [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
  return riff(vp8x);
}

export function animatedWebpBytes(width = 64, height = 64): Uint8Array {
  const vp8x = webpChunk('VP8X', [0x02, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
  return riff(vp8x);
}

export function multiImageWebpBytes(width = 64, height = 64): Uint8Array {
  const vp8x = webpChunk('VP8X', [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
  const anmf = webpChunk('ANMF', new Array(16).fill(0) as number[]);
  return riff([...vp8x, ...anmf]);
}

function vp8lPayload(width: number, height: number): number[] {
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  return [
    0x2f,
    widthMinusOne & 0xff,
    ((widthMinusOne >> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6),
    (heightMinusOne >> 2) & 0xff,
    (heightMinusOne >> 10) & 0x0f,
  ];
}
