import { afterEach, describe, expect, test } from 'bun:test';
import { announceBatchSettled, batchSettledMessage, prepareQueueLiveRegion, resetAnnouncedBatchesForTests } from './queueLiveAnnouncer';

const region = () => document.querySelector('[data-atelier-queue-live]')?.textContent;

afterEach(() => { resetAnnouncedBatchesForTests(); });

describe('announceBatchSettled', () => {
  test('speaks once per batch, whichever reporter is first', async () => {
    announceBatchSettled('b1', 2, 0);
    expect(region()).toBe('2 images ready');
    // The batch row reports the same batch after the stream did.
    announceBatchSettled('b1', 1, 1);
    expect(region()).toBe('2 images ready');
    await Promise.resolve();
    announceBatchSettled('b2', 0, 1);
    expect(region()).toBe('1 image failed to generate');
  });

  test('a batch with no settled tiles is not announced', async () => {
    await Promise.resolve();
    announceBatchSettled('b3', 0, 0);
    announceBatchSettled('b3', 1, 0);
    expect(region()).toBe('1 image ready');
  });
});

describe('announcer delivery', () => {
  test('batches settling in the same update are announced together, not overwritten', async () => {
    announceBatchSettled('c1', 0, 1);
    announceBatchSettled('c2', 2, 0);
    expect(region()).toBe('1 image failed to generate. 2 images ready');
    // A later update starts a fresh message.
    await Promise.resolve();
    announceBatchSettled('c3', 1, 0);
    expect(region()).toBe('1 image ready');
  });

  test('the live region exists, empty, before the first announcement', () => {
    document.querySelector('[data-atelier-queue-live]')?.remove();
    prepareQueueLiveRegion();
    const prepared = document.querySelector('[data-atelier-queue-live]');
    expect(prepared?.getAttribute('aria-live')).toBe('polite');
    expect(prepared?.textContent).toBe('');
  });
});

describe('batchSettledMessage', () => {
  test('words success, partial and total failure', () => {
    expect(batchSettledMessage(4, 0)).toBe('4 images ready');
    expect(batchSettledMessage(3, 1)).toBe('3 of 4 images ready, 1 failed');
    expect(batchSettledMessage(0, 2)).toBe('2 images failed to generate');
  });
});
