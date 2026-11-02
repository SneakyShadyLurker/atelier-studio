import { EXT_MIME } from '@atelier/shared';
import type { TileExt, TileMime } from '@atelier/shared';

export const MAX_IMAGE_PIXELS = 24 * 1024 * 1024;

export interface SniffedImage {
  ext: TileExt;
  mime: TileMime;
  width: number;
  height: number;
}

export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  try {
    return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes);
  } catch {
    return null;
  }
}

function image(ext: TileExt, width: number, height: number): SniffedImage | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (width * height > MAX_IMAGE_PIXELS) return null;
  return { ext, mime: EXT_MIME[ext], width, height };
}

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset < 0 || bytes.byteLength < offset + expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) return false;
  }
  return true;
}

function readU16be(bytes: Uint8Array, offset: number): number | null {
  if (bytes.byteLength < offset + 2) return null;
  const a = bytes[offset];
  const b = bytes[offset + 1];
  if (a === undefined || b === undefined) return null;
  return (a << 8) | b;
}

function readU24le(bytes: Uint8Array, offset: number): number | null {
  if (bytes.byteLength < offset + 3) return null;
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  if (a === undefined || b === undefined || c === undefined) return null;
  return a | (b << 8) | (c << 16);
}

function readU32be(bytes: Uint8Array, offset: number): number | null {
  if (bytes.byteLength < offset + 4) return null;
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  const d = bytes[offset + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

function readU32le(bytes: Uint8Array, offset: number): number | null {
  if (bytes.byteLength < offset + 4) return null;
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  const d = bytes[offset + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return a + (b << 8) + (c << 16) + ((d << 24) >>> 0);
}

function sniffPng(bytes: Uint8Array): SniffedImage | null {
  if (!hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  const ihdrLength = readU32be(bytes, 8);
  if (ihdrLength !== 13 || !hasBytes(bytes, 12, [0x49, 0x48, 0x44, 0x52])) return null;
  const width = readU32be(bytes, 16);
  const height = readU32be(bytes, 20);
  if (width === null || height === null || bytes.byteLength < 33) return null;
  // Require an IEND chunk at the tail (length=0 + 'IEND' marker; CRC may
  // be either canonical 0xAE426082 or 0x00000000 for hand-rolled fixtures).
  // Without this guard a header-only PNG with just IHDR sails through,
  // eats quota, and renders broken downstream.
  const tail = bytes.byteLength - 12;
  if (!hasBytes(bytes, tail, [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44])) return null;
  return image('png', width, height);
}

function sniffJpeg(bytes: Uint8Array): SniffedImage | null {
  if (!hasBytes(bytes, 0, [0xff, 0xd8])) return null;
  // Require the EOI marker (FFD9) to land somewhere in the last 16
  // bytes — strict end-anchored covers the common case, but JPEGs
  // occasionally carry trailing metadata after EOI, so allow a small
  // tail slack. Without this guard, a truncated JPEG with a valid SOF
  // header is accepted and corrupts downstream rendering.
  let eoi = false;
  const scanFrom = Math.max(2, bytes.byteLength - 16);
  for (let i = scanFrom; i + 1 < bytes.byteLength; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) { eoi = true; break; }
  }
  if (!eoi) return null;
  let offset = 2;
  while (offset < bytes.byteLength) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    if (marker === undefined) return null;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (marker === 0x01) continue;
    const length = readU16be(bytes, offset);
    if (length === null || length < 2) return null;
    const segmentStart = offset + 2;
    const next = offset + length;
    if (next > bytes.byteLength) return null;
    if (marker === 0xc0 || marker === 0xc2) {
      if (length < 7) return null;
      const height = readU16be(bytes, segmentStart + 1);
      const width = readU16be(bytes, segmentStart + 3);
      if (width === null || height === null) return null;
      return image('jpg', width, height);
    }
    offset = next;
  }
  return null;
}

// MPO detection: a JPEG whose APP2 segment carries the CIPA Multi-Picture
// Format identifier ("MPF\0") is an MPO container — iOS embeds HDR gain maps /
// extra frames this way when exporting to JPEG. It shares the plain-JPEG SOI
// magic, so sniffJpeg accepts it, but the gpt-image upstream rejects the file
// outright ("Unsupported image format: mpo"). Callers that would ship the
// bytes upstream unmodified use this to force a re-encode instead.
export function jpegHasMpf(bytes: Uint8Array): boolean {
  if (!hasBytes(bytes, 0, [0xff, 0xd8])) return false;
  let offset = 2;
  while (offset < bytes.byteLength) {
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    if (marker === undefined) return false;
    offset += 1;
    // SOS/EOI: APPn segments only precede entropy-coded data, so stop walking.
    if (marker === 0xd9 || marker === 0xda) return false;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (marker === 0x01) continue;
    const length = readU16be(bytes, offset);
    if (length === null || length < 2) return false;
    const segmentStart = offset + 2;
    const next = offset + length;
    if (next > bytes.byteLength) return false;
    if (marker === 0xe2 && hasBytes(bytes, segmentStart, [0x4d, 0x50, 0x46, 0x00])) return true;
    offset = next;
  }
  return false;
}

function chunkType(bytes: Uint8Array, offset: number): string | null {
  if (bytes.byteLength < offset + 4) return null;
  const a = bytes[offset];
  const b = bytes[offset + 1];
  const c = bytes[offset + 2];
  const d = bytes[offset + 3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return String.fromCharCode(a, b, c, d);
}

function sniffWebp(bytes: Uint8Array): SniffedImage | null {
  if (!hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) || !hasBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])) return null;
  const riffSize = readU32le(bytes, 4);
  if (riffSize === null || riffSize < 4) return null;
  const riffEnd = Math.min(bytes.byteLength, riffSize + 8);
  let offset = 12;
  let candidate: SniffedImage | null = null;
  while (offset + 8 <= riffEnd) {
    const type = chunkType(bytes, offset);
    const size = readU32le(bytes, offset + 4);
    if (type === null || size === null) return null;
    const payload = offset + 8;
    const next = payload + size + (size % 2);
    if (payload + size > riffEnd || next < payload) return null;
    if (type === 'ANMF') return null;
    if (type === 'VP8X') {
      if (parseVp8x(bytes, payload, size) === null) return null;
    } else if (type === 'VP8 ') {
      candidate ??= parseVp8(bytes, payload, size);
    } else if (type === 'VP8L') {
      candidate ??= parseVp8l(bytes, payload, size);
    }
    offset = next;
  }
  return candidate;
}

function parseVp8x(bytes: Uint8Array, payload: number, size: number): SniffedImage | null {
  if (size < 10 || bytes.byteLength < payload + 10) return null;
  const flags = bytes[payload];
  if (flags === undefined || (flags & 0x02) !== 0) return null;
  const widthMinusOne = readU24le(bytes, payload + 4);
  const heightMinusOne = readU24le(bytes, payload + 7);
  if (widthMinusOne === null || heightMinusOne === null) return null;
  return image('webp', widthMinusOne + 1, heightMinusOne + 1);
}

function parseVp8(bytes: Uint8Array, payload: number, size: number): SniffedImage | null {
  if (size < 10 || bytes.byteLength < payload + 10) return null;
  if (!hasBytes(bytes, payload + 3, [0x9d, 0x01, 0x2a])) return null;
  // VP8 width/height are little-endian; compose inline to avoid the two
  // per-call Uint8Array allocations the readU16be helper required.
  const widthRaw = ((bytes[payload + 7] ?? 0) << 8) | (bytes[payload + 6] ?? 0);
  const heightRaw = ((bytes[payload + 9] ?? 0) << 8) | (bytes[payload + 8] ?? 0);
  return image('webp', widthRaw & 0x3fff, heightRaw & 0x3fff);
}

function parseVp8l(bytes: Uint8Array, payload: number, size: number): SniffedImage | null {
  if (size < 5 || bytes.byteLength < payload + 5 || bytes[payload] !== 0x2f) return null;
  const b1 = bytes[payload + 1];
  const b2 = bytes[payload + 2];
  const b3 = bytes[payload + 3];
  const b4 = bytes[payload + 4];
  if (b1 === undefined || b2 === undefined || b3 === undefined || b4 === undefined) return null;
  const width = 1 + b1 + ((b2 & 0x3f) << 8);
  const height = 1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10);
  return image('webp', width, height);
}
