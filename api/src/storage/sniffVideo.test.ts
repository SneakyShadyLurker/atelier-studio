import { describe, expect, test } from 'bun:test';
import { sniffVideo } from './sniffVideo';

function mp4WithMajorBrand(brand: string): Uint8Array {
  if (brand.length !== 4) throw new Error('brand must be four bytes');
  const bytes = new Uint8Array(16);
  bytes.set([0x00, 0x00, 0x00, 0x10], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set([
    brand.charCodeAt(0),
    brand.charCodeAt(1),
    brand.charCodeAt(2),
    brand.charCodeAt(3),
  ], 8);
  return bytes;
}

describe('sniffVideo', () => {
  test('detects mp4-family ftyp major brands', () => {
    expect(sniffVideo(mp4WithMajorBrand('isom'))).toBe('mp4');
    expect(sniffVideo(mp4WithMajorBrand('mp42'))).toBe('mp4');
    expect(sniffVideo(mp4WithMajorBrand('iso5'))).toBe('mp4');
  });

  test('rejects non-video bytes', () => {
    expect(sniffVideo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
  });

  test('rejects truncated ftyp boxes', () => {
    expect(sniffVideo(new Uint8Array([0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f]))).toBeNull();
  });
});
