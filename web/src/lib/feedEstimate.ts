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
 * capped like the shell caps it. A lone tile at four columns is also capped
 * by the room above the composer, which reads the scope title height and the
 * composer's live top (`FeedChrome`), the same custom properties the CSS cap
 * reads.
 */

/** The custom properties the lone-tile cap reads (Batch/index.module.css). */
export interface FeedChrome {
  /** `--app-header-h`. */
  readonly appHeaderHeight: number;
  /** `--composer-top`, or null while the composer has not published it (the CSS falls back to 156px). */
  readonly composerTop: number | null;
  /** The touch gate matches: header controls take the 44px floor. */
  readonly touch: boolean;
}

export interface FeedGeometry extends FeedChrome {
  /** The `feed` container's content width (the scroller minus its padding), or null before the first measurement. */
  readonly containerWidth: number | null;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly phone: boolean;
}

/*
 * The batch header (Batch/index.module.css), as rendered (measured in
 * e2e/feed.spec "row estimates"): the prompt line and the controls (meta and
 * actions) share one row whose height is the controls' (28px, 44px under the
 * touch gate) while the header fits the prompt's reserve,
 * `max(240px, 50%)`, beside them; otherwise, and always on a phone, the
 * controls wrap to a second row below a 30px prompt line. The controls are
 * about 298px wide (378px with touch floors) with a typical model label.
 */
const HEADER_ROW_PX = 28;
const HEADER_ROW_TOUCH_PX = 44;
const HEADER_PROMPT_LINE_PX = 30;
const HEADER_CONTROLS_PX = 298;
const HEADER_CONTROLS_TOUCH_PX = 378;
const HEADER_GAP_PX = 14;
const HEADER_PROMPT_RESERVE_PX = 240;
/** The header's gap to the grid. */
const HEADER_TO_GRID_PX = 8;
const BATCH_PADDING_PX = 16;
const BATCH_PADDING_PHONE_PX = 12;
const BATCH_GAP_PX = 28;
const BATCH_GAP_PHONE_PX = 20;
/** `--grid-gap`: 14px, 10px below 768px (tokens.css). */
const GRID_GAP_PX = 14;
const GRID_GAP_PHONE_PX = 10;
/** `--tile-min: clamp(220px, 18vw, 320px)`. */
const TILE_MIN_PX = { min: 220, vw: 0.18, max: 320 } as const;
/** `--tile-cap: 72dvh`, 70dvh below 768px (tokens.css). */
const TILE_CAP_VH = 0.72;
const TILE_CAP_PHONE_VH = 0.70;
/** The lone-tile cap's fixed chrome: the title bar's 14px margin, then canvas padding, gaps, sheet padding and batch header (136px). */
const LONE_TILE_TITLE_MARGIN_PX = 14;
const LONE_TILE_CHROME_PX = 136;
const LONE_TILE_FLOOR_PX = 200;
const COMPOSER_TOP_FALLBACK_PX = 156;
const APP_HEADER_FALLBACK_PX = 56;

function headerHeight(geometry: FeedGeometry, headerWidth: number | null): number {
  const row = geometry.touch ? HEADER_ROW_TOUCH_PX : HEADER_ROW_PX;
  const controls = (geometry.touch ? HEADER_CONTROLS_TOUCH_PX : HEADER_CONTROLS_PX) + HEADER_GAP_PX;
  const fits = !geometry.phone && headerWidth !== null && headerWidth >= Math.max(HEADER_PROMPT_RESERVE_PX + controls, 2 * controls);
  return fits || headerWidth === null && !geometry.phone ? row : HEADER_PROMPT_LINE_PX + row;
}

/** The project's touch gate (touch floors use the same query in CSS). */
const TOUCH_GATE = '(hover: none), (any-pointer: coarse)';

function pxProperty(style: CSSStyleDeclaration, name: string): number | null {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : null;
}

/**
 * Reads the lone-tile cap's inputs from the root's custom properties. Callers
 * refresh it when the scroller rect or the composer reserve changes, not per
 * estimate.
 */
export function readFeedChrome(root: HTMLElement = document.documentElement): FeedChrome {
  const style = getComputedStyle(root);
  return {
    appHeaderHeight: pxProperty(style, '--app-header-h') ?? APP_HEADER_FALLBACK_PX,
    composerTop: pxProperty(style, '--composer-top'),
    touch: typeof matchMedia === 'function' && matchMedia(TOUCH_GATE).matches,
  };
}

function tileCap(geometry: FeedGeometry, loneAtFour: boolean): number {
  const shellCap = geometry.viewportHeight * (geometry.phone ? TILE_CAP_PHONE_VH : TILE_CAP_VH);
  if (!loneAtFour) return shellCap;
  const room = geometry.viewportHeight - geometry.appHeaderHeight - LONE_TILE_TITLE_MARGIN_PX
    - (geometry.composerTop ?? COMPOSER_TOP_FALLBACK_PX) - LONE_TILE_CHROME_PX;
  return Math.min(shellCap, Math.max(LONE_TILE_FLOOR_PX, room));
}
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
  const gridGap = geometry.phone ? GRID_GAP_PHONE_PX : GRID_GAP_PX;
  return Math.max(1, Math.floor((gridWidth + gridGap) / (tileMin + gridGap)));
}

/** `first`: the oldest row, whose sheet has no top margin (`data-first`). */
export function estimateBatchHeight(batch: Pick<Batch, 'ratio' | 'tiles'> | undefined, geometry: FeedGeometry, first = false): number {
  // (status per tile matters on phones only, see below)
  const padding = geometry.phone ? BATCH_PADDING_PHONE_PX : BATCH_PADDING_PX;
  const gap = geometry.phone ? BATCH_GAP_PHONE_PX : BATCH_GAP_PX;
  const gridGap = geometry.phone ? GRID_GAP_PHONE_PX : GRID_GAP_PX;
  const gridWidth = geometry.containerWidth === null ? null : geometry.containerWidth - 2 * padding;
  const tiles = Math.max(1, batch?.tiles.length ?? 1);
  const columns = feedColumns(geometry);
  const rows = Math.ceil(tiles / columns);
  let tileHeight = FALLBACK_TILE_HEIGHT_PX;
  if (gridWidth !== null && batch) {
    const columnWidth = (gridWidth - (columns - 1) * gridGap) / columns;
    // A lone tile spans two tracks at four columns (Batch/index.module.css).
    const loneAtFour = tiles === 1 && columns === 4;
    const tileWidth = loneAtFour ? columnWidth * 2 + gridGap : columnWidth;
    const ratio = getRatioDefinition(batch.ratio);
    tileHeight = Math.min(tileWidth * (ratio.h / ratio.w), tileCap(geometry, loneAtFour));
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
  return headerHeight(geometry, gridWidth) + HEADER_TO_GRID_PX + 2 * padding + gridHeight + (rows - 1) * gridGap + (first ? 0 : gap);
}

/**
 * The `feed` container's content width: the scroller's client width (which
 * already excludes a classic scrollbar's gutter and is the full width under
 * overlay scrollbars) minus its inline padding. Null before layout.
 */
export function readFeedContainerWidth(scroller: HTMLElement): number | null {
  if (scroller.clientWidth <= 0) return null;
  const style = getComputedStyle(scroller);
  return Math.max(0, scroller.clientWidth - Number.parseFloat(style.paddingLeft || '0') - Number.parseFloat(style.paddingRight || '0'));
}

/** The geometry the Canvas estimates with, from the measured container width, the form factor and the chrome. */
export function feedGeometry(containerWidth: number | null, phone: boolean, chrome: FeedChrome): FeedGeometry {
  return {
    containerWidth,
    viewportWidth: typeof window === 'undefined' ? 0 : window.innerWidth,
    viewportHeight: typeof window === 'undefined' ? 0 : window.innerHeight,
    phone,
    ...chrome,
  };
}
