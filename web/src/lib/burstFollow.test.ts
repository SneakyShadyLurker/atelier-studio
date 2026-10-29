import { describe, expect, test } from 'bun:test';
import type { Batch } from '@atelier/shared';
import { resolveActiveBatchId } from './burstFollow';

// Minimal batch factory — only id + status matter for follow resolution.
function batch(id: string, status: Batch['status']): Batch {
  return {
    id,
    prompt: id,
    ratio: '1:1',
    modelId: 'gpt-image-2.5-sunburst',
    modelLabel: 'gpt-image-2.5-sunburst',
    createdAt: 0,
    collectionId: null,
    pinned: false,
    status,
    tiles: [],
  };
}

// Feed order: oldest first, newest LAST (against the composer). A queued burst
// grows downward from the batch currently generating.
function burstFeed(): readonly Batch[] {
  return [
    batch('done-above', 'done'),
    batch('oldest', 'running'),
    batch('mid', 'running'),
    batch('newest', 'running'),
  ];
}

describe('resolveActiveBatchId', () => {
  test('with no follow anchor, returns the explicit selection', () => {
    expect(resolveActiveBatchId(burstFeed(), null, 'mid')).toBe('mid');
  });

  test('with no follow anchor and no explicit selection, falls back to the newest batch (last in feed order)', () => {
    expect(resolveActiveBatchId(burstFeed(), null, null)).toBe('newest');
  });

  test('during a burst both the highlight and the scroll target stay on the anchor', () => {
    const feed = burstFeed();
    // The last-arrived batch of the burst — the sentinel the canvas follows.
    expect(resolveActiveBatchId(feed, 'newest', 'newest')).toBe('newest');
  });

  test('the anchor wins over a stale explicit selection while a burst is followed', () => {
    expect(resolveActiveBatchId(burstFeed(), 'newest', 'done-above')).toBe('newest');
  });

  test('falls back to the explicit selection when the follow anchor left the feed', () => {
    expect(resolveActiveBatchId(burstFeed(), 'gone', 'mid')).toBe('mid');
  });

  test('a settled follow anchor resolves to itself (last generation stays selected)', () => {
    const feed = [batch('a', 'done'), batch('b', 'done')];
    expect(resolveActiveBatchId(feed, 'a', 'a')).toBe('a');
  });
});
