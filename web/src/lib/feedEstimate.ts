import type { Batch } from '@atelier/shared';
import { getRatioDefinition } from './ratios';

/*
 * Row-height estimates for the Canvas feed's unmeasured batches. TanStack
 * Virtual lays out every row it has not measured at `estimateSize`, and the
 * reader pays the estimate's error: the scrollbar drifts as rows measure, a
 * sidebar jump lands short and reconciles over frames, and a page prepended
 * inside the viewport pushes the reader by the difference. A flat
 * "300px per tile row of four" was hundreds of pixels off on a phone (one
 * column, square tiles the full width) and for tall ratios on the desktop, so
 * the estimate reads the geometry the grid actually lays out with
 * (Batch/index.module.css): the column count from the container width, the
 * tile width from the columns and gaps, the tile height from the batch ratio,
 * capped like the shell caps it.
 */

export interface FeedGeometry {
  /** The `feed` container's content width (the scroller minus its padding), or null before the first measurement. */
  readonly containerWidth: number | null;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly phone: boolean;
}

/** Header, the sheet's padding top and bottom, and the prompt's margin. */
const BATCH_CHROME_PX = 96;
const BATCH_PADDING_PX = 16;
const BATCH_PADDING_PHONE_PX = 12;
const BATCH_GAP_PX = 28;
const BATCH_GAP_PHONE_PX = 20;
const GRID_GAP_PX = 14;
/** `--tile-min: clamp(220px, 18vw, 320px)`. */
const TILE_MIN_PX = { min: 220, vw: 0.18, max: 320 } as const;
/** `--tile-cap: 72dvh`. */
const TILE_CAP_VH = 0.72;
/** Without geometry: the flat estimate the feed used before. */
const FALLBACK_TILE_HEIGHT_PX = 300;
const FALLBACK_COLUMNS = 4;
/**
 * Below 768px a failed tile gives up the image footprint and is as tall as
 * its content (FailedTile/index.module.css): icon and title, a sentence, one
 * row of 44px actions.
 */
const FAILED_CARD_PHONE_PX = 140;

export function feedColumns(geometry: FeedGeometry): number {
  const width = geometry.containerWidth;
  if (width === null) return FALLBACK_COLUMNS;
  if (width < 480) return 1;
  if (width >= 920) return 4;
  const tileMin = Math.min(TILE_MIN_PX.max, Math.max(TILE_MIN_PX.min, geometry.viewportWidth * TILE_MIN_PX.vw));
  const gridWidth = width - 2 * (geometry.phone ? BATCH_PADDING_PHONE_PX : BATCH_PADDING_PX);
  return Math.max(1, Math.floor((gridWidth + GRID_GAP_PX) / (tileMin + GRID_GAP_PX)));
}

export function estimateBatchHeight(batch: Pick<Batch, 'ratio' | 'tiles'> | undefined, geometry: FeedGeometry): number {
  // (status per tile matters on phones only, see below)
  const padding = geometry.phone ? BATCH_PADDING_PHONE_PX : BATCH_PADDING_PX;
  const gap = geometry.phone ? BATCH_GAP_PHONE_PX : BATCH_GAP_PX;
  const tiles = Math.max(1, batch?.tiles.length ?? 1);
  const columns = feedColumns(geometry);
  const rows = Math.ceil(tiles / columns);
  let tileHeight = FALLBACK_TILE_HEIGHT_PX;
  if (geometry.containerWidth !== null && batch) {
    const gridWidth = geometry.containerWidth - 2 * padding;
    const columnWidth = (gridWidth - (columns - 1) * GRID_GAP_PX) / columns;
    // A lone tile spans two tracks at four columns (Batch/index.module.css).
    const tileWidth = tiles === 1 && columns === 4 ? columnWidth * 2 + GRID_GAP_PX : columnWidth;
    const ratio = getRatioDefinition(batch.ratio);
    tileHeight = Math.min(tileWidth * (ratio.h / ratio.w), geometry.viewportHeight * TILE_CAP_VH);
  }
  // Each grid row is as tall as its tallest card. On a phone a failed tile is
  // a compact card, so a row of failed tiles (one column: every tile) is short.
  const cardHeights = batch && geometry.containerWidth !== null && batch.tiles.length > 0
    ? batch.tiles.map((tile) => (geometry.phone && tile.status === 'failed' ? FAILED_CARD_PHONE_PX : tileHeight))
    : null;
  let gridHeight = rows * tileHeight;
  if (cardHeights) {
    gridHeight = 0;
    for (let start = 0; start < cardHeights.length; start += columns) {
      gridHeight += Math.max(...cardHeights.slice(start, start + columns));
    }
  }
  return BATCH_CHROME_PX + 2 * padding + gridHeight + (rows - 1) * GRID_GAP_PX + gap;
}
