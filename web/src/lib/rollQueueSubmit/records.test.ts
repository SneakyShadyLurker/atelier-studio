import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { QueuedRoll } from '../../store/atelier';
import { loadRollQueue, persistRollQueue, setRollQueueScope } from '../rollQueuePersist';
import { resetSessionScopeForTests } from '../sessionScope';
import {
  carryFill,
  invalidateRecords,
  isTerminal,
  markAccepted,
  markDropped,
  markRefused,
  markRetired,
  markSingleFillOnly,
  markSubmitting,
  pruneSettled,
  restoreRecords,
  takeRecords,
  type RollRecords,
} from './records';
import type { FireItem, PassItem } from './types';

const roll = (id: string, text: string): QueuedRoll => ({ id, text, seed: 1, source: 'template' });
const fromRoll = (source: QueuedRoll): PassItem => ({
  item: { key: source.id, text: source.text, provenance: source.provenance },
  sourceRoll: source,
});
const headItem: FireItem = { key: 'press-1', text: 'composer prompt', provenance: undefined };
const saved = () => loadRollQueue().map((queued) => [queued.id, queued.text]);

function takeOne(records: RollRecords, source: QueuedRoll) {
  const [record] = takeRecords(records, [fromRoll(source)]);
  if (!record) throw new Error('take returned no record');
  return record;
}

beforeEach(() => {
  setRollQueueScope('records-test');
  persistRollQueue([]);
});

afterEach(() => {
  sessionStorage.clear();
  resetSessionScopeForTests();
});

describe('roll records', () => {
  test('taking a queued roll saves it in flight; the composer head is never saved', () => {
    const records: RollRecords = new Map();
    const taken = takeRecords(records, [fromRoll(roll('a', 'first')), { item: headItem, sourceRoll: null }]);
    expect(taken.map((record) => [record.key, record.phase])).toEqual([['a', 'taken'], ['press-1', 'taken']]);
    expect(saved()).toEqual([['a', 'first']]);
  });

  test('a carried fill is saved as the source roll with the filled text before any answer', () => {
    const records: RollRecords = new Map();
    const source = { ...roll('a', 'a {{ai-fill: x}}'), provenance: { templateId: 't', rollSeed: 3, pins: {} } };
    const record = takeOne(records, source);
    carryFill(record, { key: 'a', text: 'a FILLED', provenance: source.provenance });
    expect(record.item.text).toBe('a FILLED');
    expect(loadRollQueue()).toEqual([{ ...source, text: 'a FILLED' }]);
  });

  test('accepted work is terminal: it leaves persistence and never restores', () => {
    const records: RollRecords = new Map();
    const record = takeOne(records, roll('a', 'first'));
    markSubmitting(record, Promise.resolve());
    expect(markAccepted(record, 'batch-a')).toBe(true);
    expect(record).toMatchObject({ phase: 'accepted', acceptedBatchId: 'batch-a' });
    expect(saved()).toEqual([]);
    expect(restoreRecords([record])).toEqual([]);
    expect(markRefused(record, { kind: 'failed' })).toBe(false);
    expect(record.phase).toBe('accepted');
  });

  test('a backpressured roll restores with its carried text and leaves persistence', () => {
    const records: RollRecords = new Map();
    const record = takeOne(records, roll('a', 'a {{ai-fill: x}}'));
    carryFill(record, { key: 'a', text: 'a FILLED', provenance: undefined });
    markRefused(record, { kind: 'backpressure', retryAfterMs: 800 });
    expect(restoreRecords([record])).toEqual([{ ...roll('a', 'a FILLED') }]);
    expect(record.phase).toBe('restored');
    expect(saved()).toEqual([]);
  });

  test('a genuine failure is restored and flagged, and the flag survives a re-take', () => {
    const records: RollRecords = new Map();
    const record = takeOne(records, roll('a', 'first'));
    markSingleFillOnly(records, 'a');
    markRefused(record, { kind: 'failed' });
    expect(restoreRecords([record]).map((queued) => queued.id)).toEqual(['a']);
    const retaken = takeOne(records, roll('a', 'first'));
    expect(retaken).toMatchObject({ phase: 'taken', failedThisDrain: true, singleFillOnly: true });
  });

  test('an over-length or aborted roll is dropped: settled, never restored', () => {
    const records: RollRecords = new Map();
    const over = takeOne(records, roll('a', 'long'));
    const aborted = takeOne(records, roll('b', 'cancelled'));
    markDropped(over, { kind: 'overLength' });
    markDropped(aborted, { kind: 'aborted' });
    expect(saved()).toEqual([]);
    expect(restoreRecords([over, aborted])).toEqual([]);
  });

  test('epoch invalidation settles persistence without restoring anything', () => {
    const records: RollRecords = new Map();
    takeRecords(records, [fromRoll(roll('a', 'first')), fromRoll(roll('b', 'second'))]);
    expect(saved()).toEqual([['a', 'first'], ['b', 'second']]);
    invalidateRecords(records.values());
    expect(saved()).toEqual([]);
    expect(restoreRecords([...records.values()])).toEqual([]);
  });

  test('a roll restored at Stop and accepted late is retired, never restored again', () => {
    const records: RollRecords = new Map();
    const record = takeOne(records, roll('a', 'first'));
    markSubmitting(record, new Promise<never>(() => undefined));
    expect(restoreRecords([record]).map((queued) => queued.id)).toEqual(['a']);
    expect(markAccepted(record, 'batch-a')).toBe(true);
    expect(saved()).toEqual([]);
    expect(markRetired(record)).toBe('a');
    expect(record.phase).toBe('retired');
    expect(restoreRecords([record])).toEqual([]);
  });

  test("a composer roll's press settings ride its saved copy and its restore", () => {
    const records: RollRecords = new Map();
    const source: QueuedRoll = {
      id: 'press-1',
      text: 'b {{ai-fill: x}}',
      seed: 1,
      source: 'composer',
      submission: {
        request: { modelId: 'model-b', ratio: '16:9', count: 2, refImageIds: ['ref-1'] },
        lockedSeed: 42,
        wantsMotion: false,
        motionFields: {},
      },
    };
    const record = takeOne(records, source);
    if (source.submission === undefined) throw new Error('expected saved press settings');
    carryFill(record, { key: 'press-1', text: 'b FILLED', provenance: undefined, submission: source.submission });
    expect(loadRollQueue()).toEqual([{ ...source, text: 'b FILLED' }]);
    markRefused(record, { kind: 'backpressure', retryAfterMs: 800 });
    expect(restoreRecords([record])).toEqual([{ ...source, text: 'b FILLED' }]);
  });

  test('terminal records are pruned to their keys; restorable ones stay', () => {
    const records: RollRecords = new Map();
    const accepted = takeOne(records, roll('a', 'first'));
    const refused = takeOne(records, roll('b', 'second'));
    markAccepted(accepted, 'batch-a');
    markRefused(refused, { kind: 'backpressure', retryAfterMs: 800 });
    const settledKeys = new Set<string>();
    pruneSettled(records, settledKeys);
    expect([...records.keys()]).toEqual(['b']);
    expect([...settledKeys]).toEqual(['a']);
    expect(isTerminal(accepted)).toBe(true);
    expect(isTerminal(refused)).toBe(false);
  });
});
