import { describe, expect, test } from 'bun:test';
import {
  VIDEO_CONTEXT_FRAMES,
  VIDEO_DURATION_FRAMES,
  renderedVideoFrames,
  snapVideoFrameGrid,
} from './index';

describe('H3 frame grid', () => {
  test('every selectable duration is already on the 17k+5 grid', () => {
    for (const frames of VIDEO_DURATION_FRAMES) {
      expect(snapVideoFrameGrid(frames)).toBe(frames);
      expect((frames - 5) % 17).toBe(0);
    }
  });

  test('the context head is itself a valid guide clip length', () => {
    // AddGuide crops a guide down to the model's grid, so an off-grid head
    // would be silently truncated and the anchor window would move.
    expect(snapVideoFrameGrid(VIDEO_CONTEXT_FRAMES)).toBe(VIDEO_CONTEXT_FRAMES);
  });

  test('snaps up, never down, and floors at the shortest clip', () => {
    expect(snapVideoFrameGrid(6)).toBe(22);
    expect(snapVideoFrameGrid(22)).toBe(22);
    expect(snapVideoFrameGrid(23)).toBe(39);
    expect(snapVideoFrameGrid(1)).toBe(5);
    expect(snapVideoFrameGrid(0)).toBe(5);
  });

  test('a continuation renders long enough to still deliver the chosen duration', () => {
    for (const frames of VIDEO_DURATION_FRAMES) {
      const rendered = renderedVideoFrames(frames, VIDEO_CONTEXT_FRAMES);
      expect(snapVideoFrameGrid(rendered)).toBe(rendered);
      expect(rendered - VIDEO_CONTEXT_FRAMES).toBeGreaterThanOrEqual(frames);
    }
  });

  test('a first segment renders exactly what was asked for', () => {
    expect(renderedVideoFrames(124, 0)).toBe(124);
    expect(renderedVideoFrames(362, 0)).toBe(362);
  });

  test('the 15 s tier is the one that overshoots the trained range', () => {
    // Documented tradeoff: 384 snaps to 396, ~9% past H3's stated ~124-362.
    expect(renderedVideoFrames(124, VIDEO_CONTEXT_FRAMES)).toBe(158);
    expect(renderedVideoFrames(243, VIDEO_CONTEXT_FRAMES)).toBe(277);
    expect(renderedVideoFrames(362, VIDEO_CONTEXT_FRAMES)).toBe(396);
  });
});
