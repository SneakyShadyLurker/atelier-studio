import type { Tile, TileErrorCategory, TileExt, TileMime } from '@atelier/shared';

function svgDataUrl(seed: number, label: string): string {
  const hue = seed % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="hsl(${hue} 42% 72%)"/><stop offset="100%" stop-color="hsl(${(hue + 72) % 360} 36% 42%)"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="44"/></filter><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" seed="${seed}"/><feColorMatrix values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.08 0"/></filter></defs><rect width="1024" height="1024" fill="url(%23g)"/><g filter="url(%23b)" opacity="0.72"><ellipse cx="285" cy="310" rx="330" ry="190" fill="hsl(${(hue + 140) % 360} 55% 64%)"/><ellipse cx="715" cy="625" rx="365" ry="250" fill="hsl(${(hue + 250) % 360} 42% 58%)"/><ellipse cx="520" cy="485" rx="210" ry="390" fill="hsl(${(hue + 40) % 360} 50% 74%)"/></g><rect width="1024" height="1024" filter="url(%23n)"/><text x="48" y="962" font-family="Helvetica Neue, Arial" font-size="44" fill="rgba(255,255,255,0.74)">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function doneTile(id: string, seed: number, label: string, ext: TileExt = 'png'): Tile {
  const mime: TileMime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return {
    id,
    status: 'done',
    seed,
    url: svgDataUrl(seed, label),
    ext,
    mime,
    completedAt: Date.now() - 120_000,
  };
}

export function loadingTile(id: string, seed: number): Tile {
  return {
    id,
    status: 'loading',
    seed,
  };
}

export function failedTile(id: string, seed: number, error: TileErrorCategory): Tile {
  return {
    id,
    status: 'failed',
    seed,
    error,
    completedAt: Date.now() - 30_000,
  };
}
