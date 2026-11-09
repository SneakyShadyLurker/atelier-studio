import { describe, expect, test } from 'bun:test';
import type { Batch } from '@atelier/shared';
import { estimateBatchHeight, feedColumns, type FeedGeometry } from './feedEstimate';

const tiles = (count: number): Batch['tiles'] => Array.from({ length: count }, (_, index) => ({ id: `t${String(index)}`, seed: index, status: 'loading' as const }));
const desktop: FeedGeometry = { containerWidth: 1000, viewportWidth: 1400, viewportHeight: 900, phone: false };
const phone: FeedGeometry = { containerWidth: 360, viewportWidth: 390, viewportHeight: 844, phone: true };
const unknown: FeedGeometry = { containerWidth: null, viewportWidth: 1400, viewportHeight: 900, phone: false };

describe('feed row estimates', () => {
  test('columns follow the grid breakpoints', () => {
    expect(feedColumns(phone)).toBe(1);
    expect(feedColumns(desktop)).toBe(4);
    // Between 480 and 920 the grid auto-fills with --tile-min (18vw clamped to 220..320).
    expect(feedColumns({ ...desktop, containerWidth: 700, viewportWidth: 1000 })).toBe(2);
    expect(feedColumns(unknown)).toBe(4);
  });

  test('a square four-tile batch on a phone is four full-width rows, not one row of four', () => {
    const batch = { ratio: '1:1' as const, tiles: tiles(4) };
    const estimate = estimateBatchHeight(batch, phone);
    const tileWidth = 360 - 24;
    expect(estimate).toBe(96 + 24 + 4 * tileWidth + 3 * 14 + 20);
  });

  test('on a phone a failed tile is a compact card, not an image footprint', () => {
    const failed = { id: 'f', seed: 1, status: 'failed' as const, error: 'interrupted' as const, completedAt: 1 };
    const mixed = { ratio: '9:16' as const, tiles: [failed, failed, ...tiles(2)] };
    const allLoading = { ratio: '9:16' as const, tiles: tiles(4) };
    const mixedEstimate = estimateBatchHeight(mixed, phone);
    const tileWidth = 360 - 24;
    const tileHeight = Math.min(tileWidth * (2048 / 1152), 844 * 0.72);
    expect(mixedEstimate).toBe(96 + 24 + 2 * 140 + 2 * tileHeight + 3 * 14 + 20);
    expect(mixedEstimate).toBeLessThan(estimateBatchHeight(allLoading, phone));
    // Desktop failed tiles keep the image footprint.
    expect(estimateBatchHeight(mixed, desktop)).toBe(estimateBatchHeight(allLoading, desktop));
  });

  test('a two-column phone sums grid rows, not tiles, and a row is as tall as its tallest card', () => {
    // 600px feed on a 640px phone viewport: --tile-min clamps to 220px, two tracks fit.
    const widePhone: FeedGeometry = { containerWidth: 600, viewportWidth: 640, viewportHeight: 900, phone: true };
    expect(feedColumns(widePhone)).toBe(2);
    const columnWidth = (600 - 24 - 14) / 2;
    expect(estimateBatchHeight({ ratio: '1:1', tiles: tiles(4) }, widePhone)).toBe(96 + 24 + 2 * columnWidth + 14 + 20);
    const failed = { id: 'f', seed: 1, status: 'failed' as const, error: 'interrupted' as const, completedAt: 1 };
    // A failed card beside an image keeps the image row; a row of two cards is short.
    expect(estimateBatchHeight({ ratio: '1:1', tiles: [failed, ...tiles(3)] }, widePhone)).toBe(96 + 24 + 2 * columnWidth + 14 + 20);
    expect(estimateBatchHeight({ ratio: '1:1', tiles: [failed, failed, ...tiles(2)] }, widePhone)).toBe(96 + 24 + 140 + columnWidth + 14 + 20);
  });

  test('tall ratios are taller than wide ones at the same width', () => {
    expect(estimateBatchHeight({ ratio: '9:16', tiles: tiles(4) }, desktop))
      .toBeGreaterThan(estimateBatchHeight({ ratio: '16:9', tiles: tiles(4) }, desktop));
  });

  test('a lone tile spans two tracks at four columns and is capped like the shell', () => {
    const lone = estimateBatchHeight({ ratio: '9:16', tiles: tiles(1) }, desktop);
    const columnWidth = (1000 - 32 - 3 * 14) / 4;
    const uncapped = (columnWidth * 2 + 14) * (2048 / 1152);
    expect(uncapped).toBeGreaterThan(900 * 0.72);
    expect(lone).toBe(96 + 32 + 900 * 0.72 + 28);
  });

  test('without geometry the flat fallback estimate applies', () => {
    expect(estimateBatchHeight({ ratio: '1:1', tiles: tiles(4) }, unknown)).toBe(96 + 32 + 300 + 28);
    expect(estimateBatchHeight(undefined, unknown)).toBe(96 + 32 + 300 + 28);
  });
});
