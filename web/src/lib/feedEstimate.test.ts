import { describe, expect, test } from 'bun:test';
import type { Batch } from '@atelier/shared';
import { estimateBatchHeight, feedColumns, readFeedChrome, type FeedGeometry } from './feedEstimate';

const tiles = (count: number): Batch['tiles'] => Array.from({ length: count }, (_, index) => ({ id: `t${String(index)}`, seed: index, status: 'loading' as const }));
const chrome = { appHeaderHeight: 56, composerTop: 156, touch: false } as const;
const desktop: FeedGeometry = { containerWidth: 1000, viewportWidth: 1400, viewportHeight: 900, phone: false, ...chrome };
const phone: FeedGeometry = { containerWidth: 360, viewportWidth: 390, viewportHeight: 844, phone: true, ...chrome };
const unknown: FeedGeometry = { containerWidth: null, viewportWidth: 1400, viewportHeight: 900, phone: false, ...chrome };

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
    expect(estimate).toBe(66 + 24 + 4 * tileWidth + 3 * 10 + 20);
  });

  test('on a phone a failed tile is a compact card, not an image footprint', () => {
    const failed = { id: 'f', seed: 1, status: 'failed' as const, error: 'interrupted' as const, completedAt: 1 };
    const mixed = { ratio: '9:16' as const, tiles: [failed, failed, ...tiles(2)] };
    const allLoading = { ratio: '9:16' as const, tiles: tiles(4) };
    const mixedEstimate = estimateBatchHeight(mixed, phone);
    const tileWidth = 360 - 24;
    // Below 768px the shell caps at 70dvh (tokens.css).
    const tileHeight = Math.min(tileWidth * (2048 / 1152), 844 * 0.70);
    expect(mixedEstimate).toBe(66 + 24 + 2 * 140 + 2 * tileHeight + 3 * 10 + 20);
    expect(mixedEstimate).toBeLessThan(estimateBatchHeight(allLoading, phone));
    // Desktop failed tiles keep the image footprint.
    expect(estimateBatchHeight(mixed, desktop)).toBe(estimateBatchHeight(allLoading, desktop));
  });

  test('a two-column phone sums grid rows, not tiles, and a row is as tall as its tallest card', () => {
    // 600px feed on a 640px phone viewport: --tile-min clamps to 220px, two tracks fit.
    const widePhone: FeedGeometry = { containerWidth: 600, viewportWidth: 640, viewportHeight: 900, phone: true, ...chrome };
    expect(feedColumns(widePhone)).toBe(2);
    const columnWidth = (600 - 24 - 10) / 2;
    expect(estimateBatchHeight({ ratio: '1:1', tiles: tiles(4) }, widePhone)).toBe(66 + 24 + 2 * columnWidth + 10 + 20);
    const failed = { id: 'f', seed: 1, status: 'failed' as const, error: 'interrupted' as const, completedAt: 1 };
    // A failed card beside an image keeps the image row; a row of two cards is short.
    expect(estimateBatchHeight({ ratio: '1:1', tiles: [failed, ...tiles(3)] }, widePhone)).toBe(66 + 24 + 2 * columnWidth + 10 + 20);
    expect(estimateBatchHeight({ ratio: '1:1', tiles: [failed, failed, ...tiles(2)] }, widePhone)).toBe(66 + 24 + 140 + columnWidth + 10 + 20);
  });

  test('tall ratios are taller than wide ones at the same width', () => {
    expect(estimateBatchHeight({ ratio: '9:16', tiles: tiles(4) }, desktop))
      .toBeGreaterThan(estimateBatchHeight({ ratio: '16:9', tiles: tiles(4) }, desktop));
  });

  test('a lone tile spans two tracks at four columns and is capped like the shell', () => {
    // Batch/index.module.css: min(72dvh, max(200px, 100dvh - header - 14 - composer top - 136)).
    const lone = estimateBatchHeight({ ratio: '9:16', tiles: tiles(1) }, desktop);
    const columnWidth = (1000 - 32 - 3 * 14) / 4;
    const uncapped = (columnWidth * 2 + 14) * (2048 / 1152);
    const roomCap = 900 - 56 - 14 - 156 - 136;
    expect(uncapped).toBeGreaterThan(roomCap);
    expect(roomCap).toBeLessThan(900 * 0.72);
    expect(lone).toBe(36 + 32 + roomCap + 28);
  });

  test('a lone tile shrinks with an expanded composer and keeps the 200px floor', () => {
    const expanded = estimateBatchHeight({ ratio: '9:16', tiles: tiles(1) }, { ...desktop, composerTop: 320 });
    expect(expanded).toBe(36 + 32 + (900 - 56 - 14 - 320 - 136) + 28);
    const short = estimateBatchHeight({ ratio: '9:16', tiles: tiles(1) }, { ...desktop, viewportHeight: 577, composerTop: 320 });
    expect(short).toBe(36 + 32 + 200 + 28);
    // Without a published composer top the CSS fallback (156px) applies.
    expect(estimateBatchHeight({ ratio: '9:16', tiles: tiles(1) }, { ...desktop, composerTop: null }))
      .toBe(estimateBatchHeight({ ratio: '9:16', tiles: tiles(1) }, desktop));
  });

  test('the room cap applies to a lone tile at four columns only', () => {
    // Two tiles at four columns keep the 72dvh shell cap: a 9:16 column is shorter than both caps here.
    const columnWidth = (1000 - 32 - 3 * 14) / 4;
    expect(estimateBatchHeight({ ratio: '9:16', tiles: tiles(2) }, { ...desktop, composerTop: 600 }))
      .toBe(36 + 32 + Math.min(columnWidth * (2048 / 1152), 900 * 0.72) + 28);
  });

  test('without geometry the flat fallback estimate applies', () => {
    expect(estimateBatchHeight({ ratio: '1:1', tiles: tiles(4) }, unknown)).toBe(36 + 32 + 300 + 28);
    expect(estimateBatchHeight(undefined, unknown)).toBe(36 + 32 + 300 + 28);
  });

  test('feed chrome reads the custom properties the CSS cap reads', () => {
    const root = document.documentElement;
    root.style.setProperty('--app-header-h', '56px');
    root.style.setProperty('--composer-top', '212px');
    expect(readFeedChrome(root)).toMatchObject({ appHeaderHeight: 56, composerTop: 212 });
    root.style.removeProperty('--composer-top');
    expect(readFeedChrome(root)).toMatchObject({ appHeaderHeight: 56, composerTop: null });
    root.style.removeProperty('--app-header-h');
  });

  test('the oldest row has no sheet margin above it', () => {
    const batch = { ratio: '1:1' as const, tiles: tiles(4) };
    expect(estimateBatchHeight(batch, desktop) - estimateBatchHeight(batch, desktop, true)).toBe(28);
    expect(estimateBatchHeight(batch, phone) - estimateBatchHeight(batch, phone, true)).toBe(20);
  });

  test('the header wraps its controls below the prompt when the reserve does not fit', () => {
    const batch = { ratio: '1:1' as const, tiles: tiles(4) };
    const grid = (width: number) => (width - 32 - 3 * 14) / 4;
    // 968px header: prompt and controls share one 28px row.
    expect(estimateBatchHeight(batch, desktop)).toBe(28 + 8 + 32 + grid(1000) + 28);
    // Touch floors: one 44px row while it fits, the prompt line plus that row once it wraps.
    expect(estimateBatchHeight(batch, { ...desktop, touch: true })).toBe(44 + 8 + 32 + grid(1000) + 28);
    const narrow = { ...desktop, containerWidth: 704, viewportWidth: 1024 };
    const columns = (704 - 32 - 14) / 2;
    expect(estimateBatchHeight(batch, narrow)).toBe(28 + 8 + 32 + 2 * columns + 14 + 28);
    expect(estimateBatchHeight(batch, { ...narrow, touch: true })).toBe(30 + 44 + 8 + 32 + 2 * columns + 14 + 28);
    // Phones always wrap.
    expect(estimateBatchHeight(batch, { ...phone, touch: true }) - estimateBatchHeight(batch, phone)).toBe(16);
  });
});
