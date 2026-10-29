const MP4_BRANDS = new Set(['isom', 'iso2', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'm4v ', 'dash']);

export function sniffVideo(bytes: Uint8Array): 'mp4' | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(4) !== 0x66 || view.getUint8(5) !== 0x74 || view.getUint8(6) !== 0x79 || view.getUint8(7) !== 0x70) {
    return null;
  }
  const brand = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  return MP4_BRANDS.has(brand) ? 'mp4' : null;
}
