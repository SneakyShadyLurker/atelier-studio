// Canonical runtime type guards for narrowing `unknown` at trust boundaries
// (SSE frame payloads, first-party JSON responses, persisted cache blobs).
// Single source so the API client, SSE relays, and lib helpers don't each
// re-declare subtly different copies.

import { isMediaExt, MEDIA_EXT_MIME, TILE_ERROR_CATEGORIES } from '@atelier/shared';
import type { TileErrorCategory } from '@atelier/shared';

export function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// Wire membership guards derived from the shared const-arrays so a new
// tile-error category or media format can never drift out of sync.
const tileErrorCategories: ReadonlySet<string> = new Set(TILE_ERROR_CATEGORIES);

export function isTileErrorCategory(value: unknown): value is TileErrorCategory {
  return typeof value === 'string' && tileErrorCategories.has(value);
}

export function isMediaPair(ext: unknown, mime: unknown): boolean {
  return typeof ext === 'string'
    && isMediaExt(ext)
    && typeof mime === 'string'
    && MEDIA_EXT_MIME[ext] === mime;
}
