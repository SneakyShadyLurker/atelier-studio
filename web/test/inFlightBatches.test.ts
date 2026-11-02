import { afterEach, describe, expect, test } from 'bun:test';
import { getBatch, registerBatch, resetInFlightForTests, unregisterBatch } from '../src/hooks/inFlightBatches';

afterEach(() => {
  resetInFlightForTests();
});

describe('inFlightBatches', () => {
  test('registerBatch and getBatch round-trip a controller', () => {
    const controller = new AbortController();

    registerBatch('batch-1', controller);

    expect(getBatch('batch-1')?.controller).toBe(controller);
  });

  test('getBatch returns undefined for an unknown id', () => {
    expect(getBatch('missing')).toBeUndefined();
  });

  test('unregisterBatch is idempotent', () => {
    const controller = new AbortController();
    registerBatch('batch-1', controller);

    unregisterBatch('batch-1');
    unregisterBatch('batch-1');

    expect(getBatch('batch-1')).toBeUndefined();
  });

  test('resetInFlightForTests clears the map', () => {
    registerBatch('batch-1', new AbortController());

    resetInFlightForTests();

    expect(getBatch('batch-1')).toBeUndefined();
  });
});
