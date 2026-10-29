import { describe, expect, test } from 'bun:test';
import type { ZoomGeometry, ZoomTransform } from './imageZoom';
import {
  FIT_TRANSFORM,
  clampPan,
  isFitTransform,
  isZoomWorthwhile,
  maxZoomScale,
  rescaleFromCenter,
  rubberBandPan,
  transformCss,
  zoomAround,
} from './imageZoom';

// A 1000x600 image fitted inside a 1200x800 viewport, centred.
const GEOMETRY: ZoomGeometry = {
  width: 1000,
  height: 600,
  centerX: 600,
  centerY: 400,
  stageWidth: 1200,
  stageHeight: 800,
};

describe('maxZoomScale', () => {
  test('is the ratio of natural pixels to fitted pixels', () => {
    expect(maxZoomScale(1000, 2048)).toBeCloseTo(2.048);
  });

  test('never goes below fit for images smaller than their frame', () => {
    expect(maxZoomScale(1000, 512)).toBe(1);
  });

  test('is inert for unmeasured images', () => {
    expect(maxZoomScale(0, 2048)).toBe(1);
    expect(maxZoomScale(1000, 0)).toBe(1);
  });
});

describe('isZoomWorthwhile', () => {
  test('offers 1:1 when there is real detail to recover', () => {
    expect(isZoomWorthwhile(1000, 2048)).toBe(true);
  });

  test('declines when the gain would be invisible', () => {
    expect(isZoomWorthwhile(1000, 1020)).toBe(false);
    expect(isZoomWorthwhile(1000, 1000)).toBe(false);
    expect(isZoomWorthwhile(1000, 800)).toBe(false);
  });
});

describe('zoomAround', () => {
  test('pins the image point under the pointer', () => {
    const pointer = { x: 900, y: 250 };
    const next = zoomAround(FIT_TRANSFORM, 2, pointer, GEOMETRY);
    // The point that was under the pointer must still be under it: its offset
    // from the centre scales by `s`, then the translation puts it back.
    const beforeX = (pointer.x - GEOMETRY.centerX - FIT_TRANSFORM.x) / FIT_TRANSFORM.scale;
    const afterX = GEOMETRY.centerX + next.x + next.scale * beforeX;
    expect(afterX).toBeCloseTo(pointer.x);

    const beforeY = (pointer.y - GEOMETRY.centerY - FIT_TRANSFORM.y) / FIT_TRANSFORM.scale;
    const afterY = GEOMETRY.centerY + next.y + next.scale * beforeY;
    expect(afterY).toBeCloseTo(pointer.y);
  });

  test('zooming about the centre leaves the translation alone', () => {
    const next = zoomAround(FIT_TRANSFORM, 3, { x: GEOMETRY.centerX, y: GEOMETRY.centerY }, GEOMETRY);
    expect(next).toEqual({ scale: 3, x: 0, y: 0 });
  });

  test('composes with an existing transform', () => {
    const current: ZoomTransform = { scale: 2, x: -120, y: 40 };
    const pointer = { x: 300, y: 700 };
    const next = zoomAround(current, 4, pointer, GEOMETRY);
    const before = (pointer.x - GEOMETRY.centerX - current.x) / current.scale;
    expect(GEOMETRY.centerX + next.x + next.scale * before).toBeCloseTo(pointer.x);
  });
});

describe('clampPan', () => {
  test('keeps the scaled image covering the stage', () => {
    // At 2x the image is 2000x1200 against a 1200x800 stage: 400px of slack
    // horizontally, 200px vertically.
    expect(clampPan({ scale: 2, x: 10_000, y: 0 }, GEOMETRY).x).toBe(400);
    expect(clampPan({ scale: 2, x: -10_000, y: 0 }, GEOMETRY).x).toBe(-400);
    expect(clampPan({ scale: 2, x: 0, y: 10_000 }, GEOMETRY).y).toBe(200);
    expect(clampPan({ scale: 2, x: 0, y: -10_000 }, GEOMETRY).y).toBe(-200);
  });

  test('leaves in-range translations untouched', () => {
    expect(clampPan({ scale: 2, x: 120, y: -75 }, GEOMETRY)).toEqual({ scale: 2, x: 120, y: -75 });
  });

  test('recentres an axis the image is too small to fill', () => {
    // At 1x the 1000px-wide image cannot cover the 1200px stage.
    expect(clampPan({ scale: 1, x: 300, y: 0 }, GEOMETRY).x).toBe(0);
  });

  test('preserves scale', () => {
    expect(clampPan({ scale: 2.5, x: 9999, y: 9999 }, GEOMETRY).scale).toBe(2.5);
  });
});

describe('rubberBandPan', () => {
  test('passes in-range translations through unchanged', () => {
    expect(rubberBandPan({ scale: 2, x: 120, y: -75 }, GEOMETRY)).toEqual({ scale: 2, x: 120, y: -75 });
  });

  test('gives past the edge, but always less than the raw drag', () => {
    const dragged = rubberBandPan({ scale: 2, x: 600, y: 0 }, GEOMETRY);
    expect(dragged.x).toBeGreaterThan(400);
    expect(dragged.x).toBeLessThan(600);
  });

  test('resists symmetrically', () => {
    const positive = rubberBandPan({ scale: 2, x: 600, y: 0 }, GEOMETRY);
    const negative = rubberBandPan({ scale: 2, x: -600, y: 0 }, GEOMETRY);
    expect(negative.x).toBeCloseTo(-positive.x);
  });

  test('resistance grows with distance', () => {
    const near = rubberBandPan({ scale: 2, x: 500, y: 0 }, GEOMETRY).x - 400;
    const far = rubberBandPan({ scale: 2, x: 900, y: 0 }, GEOMETRY).x - 400;
    expect(far).toBeGreaterThan(near);
    expect(far - near).toBeLessThan(400);
  });

  test('gives around the centred position on an under-filled axis', () => {
    const dragged = rubberBandPan({ scale: 1, x: 200, y: 0 }, GEOMETRY);
    expect(dragged.x).toBeGreaterThan(0);
    expect(dragged.x).toBeLessThan(200);
  });
});

describe('rescaleFromCenter', () => {
  test('changes only the scale', () => {
    expect(rescaleFromCenter({ scale: 2.6, x: 40, y: -10 }, 2)).toEqual({ scale: 2, x: 40, y: -10 });
  });
});

describe('isFitTransform', () => {
  test('treats float noise around 1 as fit', () => {
    expect(isFitTransform(FIT_TRANSFORM)).toBe(true);
    expect(isFitTransform({ scale: 1.0001, x: 0, y: 0 })).toBe(true);
    expect(isFitTransform({ scale: 1.05, x: 0, y: 0 })).toBe(false);
  });
});

describe('transformCss', () => {
  test('emits a compositor-friendly transform', () => {
    expect(transformCss({ scale: 2, x: -12.5, y: 8 })).toBe('translate3d(-12.5px, 8px, 0) scale(2)');
  });
});
