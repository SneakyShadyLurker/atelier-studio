import { deflateSync } from 'node:zlib';
import { abortableDelay } from '../lifecycle/abort';
import type { Provider, ProviderRequest, ProviderResult } from './types';

export interface MockProviderConfig {
  readonly slowDelayMs: number;
  readonly tileDelays: string | undefined;
}

export function createMockProvider({ slowDelayMs, tileDelays }: MockProviderConfig): Provider {
  const slowTileDelays = parseTileDelays(tileDelays);
  return {
    id: 'mock',
    backend: 'local',
    async *generate(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderResult> {
      const delayMs = req.modelId === 'mock-slow'
        ? slowTileDelays?.[req.tileIndex] ?? slowDelayMs
        : 25;
      await abortableDelay(delayMs, signal);
      if (req.modelId === 'mock-fail') {
        yield {
          status: 'failed',
          error: 'CUDA OOM at /home/secret/path/model.safetensors, request id 0xDEADBEEF',
          seed: req.seed,
          index: 0,
        };
        return;
      }
      // mock-gif intentionally claims an unsupported ext so the orchestrator
      // can exercise its allowlist coercion. The bytes don't matter for that
      // path because the orchestrator never writes them — `isAllowedArtifact`
      // returns false and emits `failed: 'unsupported format'` first.
      const ext = req.modelId === 'mock-gif' ? 'gif' : 'png';
      const mime = req.modelId === 'mock-gif' ? 'image/gif' : 'image/png';
      const bytes =
        ext === 'png'
          ? buildPng(seedColor(req.modelId, req.tileIndex, req.seed))
          : new Uint8Array(0);
      yield { status: 'ready', bytes, ext, mime, seed: req.seed, index: 0 };
    },
  };
}

function parseTileDelays(value: string | undefined): readonly number[] | null {
  if (value === undefined || value.trim() === '') return null;
  const rawDelays = value.split(',').map((raw) => raw.trim());
  if (rawDelays.some((raw) => raw === '')) return null;
  const delays = rawDelays.map((raw) => Number(raw));
  if (delays.some((delayMs) => !Number.isInteger(delayMs) || delayMs < 0)) return null;
  return delays;
}

// ─── PNG generation ────────────────────────────────────────────────────
// 32×32 solid-color RGB PNG. Real PNG bytes (signature + IHDR + IDAT +
// IEND) so the frontend can render `<img src="/api/img/:tileId">` without
// choking. Color is derived from (modelId, tileIndex, seed) so a batch's
// tiles are visually distinguishable in the lightbox.

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_SIZE = 32;

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    const idx = (crc ^ b) & 0xff;
    crc = ((CRC_TABLE[idx] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const buf = new Uint8Array(8 + data.length + 4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
  buf.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) crcInput[i] = type.charCodeAt(i);
  crcInput.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcInput), false);
  return buf;
}

function buildPng([r, g, b]: readonly [number, number, number]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, PNG_SIZE, false); // width
  ihdrView.setUint32(4, PNG_SIZE, false); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // ihdr[10..12] = 0 (compression, filter, interlace)

  // Per-row: 1 filter byte (0 = None) + width × 3 RGB bytes.
  const rowLen = 1 + PNG_SIZE * 3;
  const raw = new Uint8Array(rowLen * PNG_SIZE);
  for (let y = 0; y < PNG_SIZE; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < PNG_SIZE; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 2 + x * 3] = g;
      raw[off + 3 + x * 3] = b;
    }
  }
  const idat = new Uint8Array(deflateSync(raw));

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function seedColor(modelId: string, tileIndex: number, seed: number): readonly [number, number, number] {
  let h = 2166136261;
  for (const ch of modelId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  h = Math.imul(h ^ tileIndex, 16777619);
  h = Math.imul(h ^ seed, 16777619);
  const r = (h >>> 16) & 0xff;
  const g = (h >>> 8) & 0xff;
  const b = h & 0xff;
  return [r, g, b];
}
