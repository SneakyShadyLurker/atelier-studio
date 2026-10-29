import { afterEach, describe, expect, test } from 'bun:test';
import type { QueuedRoll, RollSubmission } from '../store/atelier';
import {
  MAX_ROLL_QUEUE_ENTRIES,
  beginInFlight,
  loadRollQueue,
  persistRollQueue,
  rollQueueStorageKey,
  setRollQueueScope,
  settleInFlight,
  unsettledInFlightCount,
} from './rollQueuePersist';
import { invalidateSessionScope, resetSessionScopeForTests } from './sessionScope';
import { makeSubmissionRequest } from './rollQueueSubmit/request';

afterEach(() => {
  sessionStorage.clear();
  resetSessionScopeForTests();
});

describe('rollQueuePersist', () => {
  test('round-trips prepared historical input without converting it into a fresh generation', () => {
    setRollQueueScope('alice');
    const rolls = [null, 42].map((lockedSeed, index): QueuedRoll => ({
      id: `history-${index}`, text: 'literal {{ai-fill: old text}}', seed: 1, source: 'composer',
      provenance: { templateId: 'template-1', rollSeed: 7, pins: {} },
      submission: {
        request: { modelId: 'video', ratio: '16:9', count: 1, i2vSourceUploadId: 'upload-1', durationFrames: 243 },
        lockedSeed, wantsMotion: false, motionFields: {}, prepared: true,
      },
    }));
    persistRollQueue(rolls);
    expect(loadRollQueue()).toEqual(rolls);
    for (const roll of loadRollQueue()) {
      if (!roll.submission) throw new Error('missing historical settings');
      expect(makeSubmissionRequest(roll.submission, { key: roll.id, text: roll.text, provenance: roll.provenance }).idempotencyKey).toBe(roll.id);
    }
  });
  test('round-trips queue metadata and drops invalid entries on load', () => {
    setRollQueueScope('alice');
    persistRollQueue([
      {
        id: 'composer-1',
        text: 'resolved prompt',
        seed: 42,
        source: 'composer',
        provenance: { templateId: 'template-1', rollSeed: 7, pins: { era: 'future' } },
      },
    ]);
    const key = rollQueueStorageKey('alice');
    const stored = JSON.parse(sessionStorage.getItem(key) ?? '{}') as { rolls?: unknown[] };
    sessionStorage.setItem(key, JSON.stringify({
      rolls: [...(stored.rolls ?? []), { id: 'invalid', text: 123, seed: 1, source: 'composer' }],
    }));

    expect(loadRollQueue()).toEqual([
      {
        id: 'composer-1',
        text: 'resolved prompt',
        seed: 42,
        source: 'composer',
        provenance: { templateId: 'template-1', rollSeed: 7, pins: { era: 'future' } },
      },
    ]);
  });

  test("round-trips a composer roll's press settings", () => {
    const roll: QueuedRoll = {
      id: 'press-1',
      text: 'filled prompt',
      seed: 4,
      source: 'composer',
      submission: {
        request: {
          modelId: 'minimax-h3-i2v',
          ratio: '9:16',
          count: 1,
          refImageIds: ['ref-1'],
          i2vSourceUploadId: 'upload-1',
          extendsTileId: 'tile-1',
          motionPrompt: 'raw motion',
          durationFrames: 243,
        },
        lockedSeed: 77,
        wantsMotion: true,
        motionFields: {
          sourcePrompt: 'source still prompt',
          durationFrames: 243,
          extendContext: { previousMotionPrompt: 'previous', handoffUploadId: 'upload-1' },
        },
      },
    };
    setRollQueueScope('alice');
    persistRollQueue([roll]);
    expect(loadRollQueue()).toEqual([roll]);
  });

  test('a roll saved before press settings existed loads unchanged', () => {
    setRollQueueScope('alice');
    sessionStorage.setItem(
      rollQueueStorageKey('alice'),
      JSON.stringify({ rolls: [{ id: 'old', text: 'old prompt', seed: 1, source: 'composer' }] }),
    );
    expect(loadRollQueue()).toEqual([{ id: 'old', text: 'old prompt', seed: 1, source: 'composer' }]);
  });

  test('invalid press settings are dropped, never the roll', () => {
    const valid: RollSubmission = {
      request: { modelId: 'model-a', ratio: '1:1', count: 2 },
      lockedSeed: null,
      wantsMotion: false,
      motionFields: {},
    };
    const invalid = [
      { ...valid, request: { ...valid.request, ratio: '2:1' } },
      { ...valid, request: { ...valid.request, count: 9 } },
      { ...valid, request: { ...valid.request, modelId: '' } },
      { ...valid, request: { ...valid.request, refImageIds: [1] } },
      { ...valid, request: { ...valid.request, durationFrames: 100 } },
      { ...valid, lockedSeed: -1 },
      { ...valid, lockedSeed: undefined },
      { ...valid, wantsMotion: 'yes' },
      { ...valid, motionFields: { extendContext: { previousMotionPrompt: 'p' } } },
      'settings',
    ];
    setRollQueueScope('alice');
    sessionStorage.setItem(rollQueueStorageKey('alice'), JSON.stringify({
      rolls: [
        { id: 'kept', text: 'kept prompt', seed: 1, source: 'composer', submission: valid },
        ...invalid.map((submission, index) => ({ id: `r${index}`, text: 'prompt', seed: 1, source: 'composer', submission })),
      ],
    }));
    const loaded = loadRollQueue();
    expect(loaded).toHaveLength(invalid.length + 1);
    expect(loaded[0]?.submission).toEqual(valid);
    expect(loaded.slice(1).every((roll) => roll.submission === undefined && roll.text === 'prompt')).toBe(true);
  });

  test('keeps legacy bare-name pins for Object.prototype-named lists as own pins', () => {
    setRollQueueScope('alice');
    sessionStorage.setItem(
      rollQueueStorageKey('alice'),
      '{"rolls":[{"id":"r1","text":"prompt","seed":1,"source":"template","provenance":'
        + '{"templateId":"t1","rollSeed":5,"pins":{"__proto__":"p1","constructor":"c1","toString#0":"s1","era":"future"}}}]}',
    );

    const pins = loadRollQueue()[0]?.provenance?.pins;
    if (!pins) throw new Error('expected provenance pins');
    expect(Object.getPrototypeOf(pins) === Object.prototype).toBe(true);
    expect(Object.hasOwn(pins, '__proto__')).toBe(true);
    expect(Object.entries(pins)).toEqual([
      ['__proto__', 'p1'],
      ['constructor', 'c1'],
      ['toString#0', 's1'],
      ['era', 'future'],
    ]);
  });

  test('keeps queues isolated by cache scope', () => {
    const aliceRoll = { id: 'alice-1', text: 'alice prompt', seed: 1, source: 'composer' as const };
    const bobRoll = { id: 'bob-1', text: 'bob prompt', seed: 2, source: 'composer' as const };
    setRollQueueScope('alice');
    persistRollQueue([aliceRoll]);

    setRollQueueScope('bob');
    expect(loadRollQueue()).toEqual([]);
    persistRollQueue([bobRoll]);

    setRollQueueScope('alice');
    expect(loadRollQueue()).toEqual([aliceRoll]);
    setRollQueueScope('bob');
    expect(loadRollQueue()).toEqual([bobRoll]);
  });

  test('persists optimistically consumed rolls until they settle', () => {
    const consumed = { id: 'consumed-1', text: 'queued prompt', seed: 3, source: 'template' as const };
    setRollQueueScope('alice');
    persistRollQueue([consumed]);
    persistRollQueue([]);
    beginInFlight([consumed]);

    expect(loadRollQueue()).toEqual([consumed]);
    settleInFlight([consumed.id]);
    expect(loadRollQueue()).toEqual([]);
  });

  test('reload keeps consumed rolls ahead of rolls added during submission', () => {
    const first = { id: 'first', text: 'first prompt', seed: 1, source: 'composer' as const };
    const second = { id: 'second', text: 'second prompt', seed: 2, source: 'composer' as const };
    const third = { id: 'third', text: 'third prompt', seed: 3, source: 'composer' as const };
    setRollQueueScope('alice');
    persistRollQueue([first, second]);
    persistRollQueue([]);
    beginInFlight([first, second]);
    persistRollQueue([third]);

    expect(loadRollQueue()).toEqual([first, second, third]);
    settleInFlight([first.id]);
    expect(loadRollQueue()).toEqual([second, third]);
  });

  test('counts in-flight rolls not already visible', () => {
    const a = { id: 'a', text: 'a', seed: 1, source: 'template' as const };
    const b = { id: 'b', text: 'b', seed: 2, source: 'template' as const };
    setRollQueueScope('alice');
    beginInFlight([a, b]);
    expect(unsettledInFlightCount(new Set())).toBe(2);
    expect(unsettledInFlightCount(new Set(['b']))).toBe(1);
    settleInFlight(['a', 'b']);
    expect(unsettledInFlightCount(new Set())).toBe(0);
  });

  test('the storage guard keeps a legitimate queue above the admission cap and bounds corrupt data', () => {
    const make = (count: number): QueuedRoll[] => Array.from({ length: count }, (_, index) => ({
      id: `r${index}`, text: `prompt ${index}`, seed: index, source: 'template' as const,
    }));
    setRollQueueScope('alice');
    beginInFlight(make(MAX_ROLL_QUEUE_ENTRIES));
    persistRollQueue([{ id: 'extra', text: 'extra', seed: 1, source: 'template' }]);
    expect(loadRollQueue()).toHaveLength(MAX_ROLL_QUEUE_ENTRIES + 1);
    expect(loadRollQueue().at(-1)?.id).toBe('extra');

    sessionStorage.setItem(rollQueueStorageKey('alice'), JSON.stringify({ rolls: make(3 * MAX_ROLL_QUEUE_ENTRIES) }));
    expect(loadRollQueue()).toHaveLength(2 * MAX_ROLL_QUEUE_ENTRIES);
  });

  test('retirement freezes the saved queue against late drain and store callbacks', () => {
    const roll = { id: 'a1', text: 'account A prompt', seed: 3, source: 'composer' as const };
    setRollQueueScope('alice');
    persistRollQueue([roll]);
    beginInFlight([roll]);
    const saved = sessionStorage.getItem(rollQueueStorageKey('alice'));
    invalidateSessionScope();
    settleInFlight([roll.id]);
    persistRollQueue([]);
    setRollQueueScope('bob');
    beginInFlight([{ ...roll, id: 'late' }]);
    expect(loadRollQueue()).toEqual([]);
    expect(sessionStorage.getItem(rollQueueStorageKey('alice'))).toBe(saved);
    expect(sessionStorage.getItem(rollQueueStorageKey('bob'))).toBeNull();
    resetSessionScopeForTests(); // The next authenticated page lifetime.
    setRollQueueScope('bob');
    expect(loadRollQueue()).toEqual([]);
    setRollQueueScope('alice');
    expect(loadRollQueue()).toEqual([roll]);
  });
});
