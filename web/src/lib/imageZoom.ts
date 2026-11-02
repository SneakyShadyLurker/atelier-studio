/**
 * Transform math for the Lightbox 1:1 zoom.
 *
 * The viewer paints the image with `translate3d(x, y, 0) scale(s)` about its
 * own centre, so the layout box never moves and every value here is expressed
 * against that untransformed box. Pure functions: no DOM, no React.
 */

export interface ZoomTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface ZoomGeometry {
  /** Layout size of the image at fit scale, in CSS px. */
  readonly width: number;
  readonly height: number;
  /** Centre of the untransformed layout box, in viewport coordinates. */
  readonly centerX: number;
  readonly centerY: number;
  /** Area the image may be panned across — the viewport. */
  readonly stageWidth: number;
  readonly stageHeight: number;
}

export interface ZoomPoint {
  readonly x: number;
  readonly y: number;
}

export const FIT_TRANSFORM: ZoomTransform = { scale: 1, x: 0, y: 0 };

/** Float slack — a scale this close to fit is fit. */
const FIT_EPSILON = 0.001;
/** Under this ratio the 1:1 step buys no visible detail, so it isn't offered. */
const MIN_WORTHWHILE_SCALE = 1.05;
/** Overscroll resistance; 0.55 is the iOS rubber-band constant. */
const RESISTANCE = 0.55;

export function isFitTransform(transform: ZoomTransform): boolean {
  return transform.scale <= 1 + FIT_EPSILON;
}

/** Scale at which one image pixel covers one CSS pixel. */
export function maxZoomScale(fitWidth: number, naturalWidth: number): number {
  if (fitWidth <= 0 || naturalWidth <= 0) return 1;
  return Math.max(1, naturalWidth / fitWidth);
}

export function isZoomWorthwhile(fitWidth: number, naturalWidth: number): boolean {
  return maxZoomScale(fitWidth, naturalWidth) >= MIN_WORTHWHILE_SCALE;
}

/**
 * Translation range that keeps the scaled image covering the stage. Inverted
 * (`min > max`) when the image is smaller than the stage on that axis.
 */
function panRange(half: number, stage: number, center: number): { min: number; max: number } {
  return { min: stage - center - half, max: half - center };
}

function centeredOffset(stage: number, center: number): number {
  return stage / 2 - center;
}

function clampAxis(value: number, half: number, stage: number, center: number): number {
  const { min, max } = panRange(half, stage, center);
  if (min > max) return centeredOffset(stage, center);
  return Math.min(max, Math.max(min, value));
}

export function clampPan(transform: ZoomTransform, geometry: ZoomGeometry): ZoomTransform {
  return {
    scale: transform.scale,
    x: clampAxis(transform.x, (geometry.width * transform.scale) / 2, geometry.stageWidth, geometry.centerX),
    y: clampAxis(transform.y, (geometry.height * transform.scale) / 2, geometry.stageHeight, geometry.centerY),
  };
}

/** Asymptotic give: the further past the edge, the less the drag moves. */
function resist(overflow: number, dimension: number): number {
  if (dimension <= 0) return 0;
  return (1 - 1 / ((overflow * RESISTANCE) / dimension + 1)) * dimension;
}

function rubberAxis(value: number, half: number, stage: number, center: number): number {
  const { min, max } = panRange(half, stage, center);
  if (min > max) {
    const anchor = centeredOffset(stage, center);
    const delta = value - anchor;
    return anchor + Math.sign(delta) * resist(Math.abs(delta), stage);
  }
  if (value > max) return max + resist(value - max, stage);
  if (value < min) return min - resist(min - value, stage);
  return value;
}

/** Clamp with give — for live drags, which snap back via `clampPan` on release. */
export function rubberBandPan(transform: ZoomTransform, geometry: ZoomGeometry): ZoomTransform {
  return {
    scale: transform.scale,
    x: rubberAxis(transform.x, (geometry.width * transform.scale) / 2, geometry.stageWidth, geometry.centerX),
    y: rubberAxis(transform.y, (geometry.height * transform.scale) / 2, geometry.stageHeight, geometry.centerY),
  };
}

/** Re-scale while pinning the image point currently under `pointer` to it. */
export function zoomAround(
  current: ZoomTransform,
  nextScale: number,
  pointer: ZoomPoint,
  geometry: ZoomGeometry,
): ZoomTransform {
  const offsetX = pointer.x - geometry.centerX;
  const offsetY = pointer.y - geometry.centerY;
  const ratio = nextScale / current.scale;
  return {
    scale: nextScale,
    x: offsetX - ratio * (offsetX - current.x),
    y: offsetY - ratio * (offsetY - current.y),
  };
}

/** Re-scale about the image's own centre — the resting state after a pinch. */
export function rescaleFromCenter(current: ZoomTransform, nextScale: number): ZoomTransform {
  return { scale: nextScale, x: current.x, y: current.y };
}

export function transformCss(transform: ZoomTransform): string {
  return `translate3d(${String(transform.x)}px, ${String(transform.y)}px, 0) scale(${String(transform.scale)})`;
}
