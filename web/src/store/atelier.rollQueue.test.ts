import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initialAtelierState, useAtelierStore, type QueuedRoll } from './atelier';
import { beginInFlight, loadRollQueue, rollQueueStorageKey, setRollQueueScope, settleInFlight } from '../lib/rollQueuePersist';

const rolls = (count: number, prefix = 'roll'): QueuedRoll[] => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index}`,
  text: `prompt ${index}`,
  seed: index,
  source: 'template' as const,
}));

describe('rollQueue slice', () => {
  beforeEach(() => { useAtelierStore.setState(initialAtelierState, true); });
  afterEach(() => { useAtelierStore.setState(initialAtelierState, true); });

  test('initial rollQueue is empty', () => {
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
  });

  test('stashRoll appends to queue', () => {
    useAtelierStore.getState().stashRoll({ id: 'a', text: 'one', seed: 1, source: 'template' });
    useAtelierStore.getState().stashRoll({ id: 'b', text: 'two', seed: 2, source: 'template' });
    const q = useAtelierStore.getState().draft.rollQueue;
    expect(q.map((r) => r.id)).toEqual(['a', 'b']);
  });

  test('rejects admission beyond the 200-roll cap with an error toast', () => {
    useAtelierStore.getState().hydrateRollQueue(Array.from({ length: 200 }, (_, index) => ({
      id: `roll-${index}`,
      text: `prompt ${index}`,
      seed: index,
      source: 'template' as const,
    })));

    useAtelierStore.getState().stashRoll({ id: 'overflow', text: 'overflow', seed: 201, source: 'template' });

    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(200);
    expect(useAtelierStore.getState().toasts.at(-1)).toMatchObject({
      text: 'Roll queue is limited to 200 prompts.',
      tone: 'error',
    });
  });

  test('admission counts consumed rolls still in flight', () => {
    setRollQueueScope('store-cap');
    try {
      const consumed = rolls(200);
      beginInFlight(consumed);

      expect(useAtelierStore.getState().stashRoll({ id: 'late', text: 'late', seed: 1, source: 'template' })).toBe(false);
      expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
      expect(useAtelierStore.getState().toasts.at(-1)).toMatchObject({ text: 'Roll queue is limited to 200 prompts.' });

      settleInFlight(consumed.map((roll) => roll.id));
      expect(useAtelierStore.getState().stashRoll({ id: 'late', text: 'late', seed: 1, source: 'template' })).toBe(true);
      expect(useAtelierStore.getState().draft.rollQueue.map((roll) => roll.id)).toEqual(['late']);
    } finally {
      sessionStorage.removeItem(rollQueueStorageKey('store-cap'));
      setRollQueueScope('store-cap');
    }
  });

  test('a system requeue bypasses the cap so paid work is never refused', () => {
    useAtelierStore.getState().hydrateRollQueue(rolls(200));
    useAtelierStore.getState().requeueRoll({ id: 'paid', text: 'filled text', seed: 1, source: 'composer' });
    expect(useAtelierStore.getState().draft.rollQueue).toHaveLength(201);
    expect(useAtelierStore.getState().draft.rollQueue.at(-1)).toMatchObject({ id: 'paid', text: 'filled text' });
    expect(useAtelierStore.getState().toasts).toEqual([]);
  });

  test("Clear of a full queue, a stash, then Clear's Undo keeps every row across a reload", () => {
    setRollQueueScope('store-undo');
    try {
      const snapshot = rolls(200);
      useAtelierStore.getState().hydrateRollQueue(snapshot);
      useAtelierStore.getState().clearRollQueue();
      expect(useAtelierStore.getState().stashRoll({ id: 'fresh', text: 'fresh', seed: 1, source: 'template' })).toBe(true);
      useAtelierStore.getState().restoreRollQueue(snapshot);

      const visible = useAtelierStore.getState().draft.rollQueue.map((roll) => roll.id);
      expect(visible).toHaveLength(201);
      expect(loadRollQueue().map((roll) => roll.id)).toEqual(visible);
    } finally {
      sessionStorage.removeItem(rollQueueStorageKey('store-undo'));
      setRollQueueScope('store-undo');
    }
  });

  test('a composer roll keeps its press settings through requeue, restore and reload', () => {
    setRollQueueScope('store-submission');
    try {
      const roll: QueuedRoll = {
        id: 'press-1',
        text: 'filled prompt',
        seed: 1,
        source: 'composer',
        submission: {
          request: { modelId: 'model-b', ratio: '16:9', count: 2 },
          lockedSeed: 9,
          wantsMotion: false,
          motionFields: {},
        },
      };
      useAtelierStore.getState().requeueRoll(roll);
      expect(loadRollQueue()).toEqual([roll]);
      useAtelierStore.getState().removeQueuedRolls([roll.id]);
      useAtelierStore.getState().restoreRollQueue([roll]);
      expect(useAtelierStore.getState().draft.rollQueue).toEqual([roll]);
      const reloaded = loadRollQueue();
      useAtelierStore.setState(initialAtelierState, true);
      useAtelierStore.getState().hydrateRollQueue(reloaded);
      expect(useAtelierStore.getState().draft.rollQueue).toEqual([roll]);
    } finally {
      sessionStorage.removeItem(rollQueueStorageKey('store-submission'));
      setRollQueueScope('store-submission');
    }
  });

  test('hydrates only an empty queue so a raced user stash wins', () => {
    const persisted = [{ id: 'persisted', text: 'persisted prompt', seed: 1, source: 'template' as const }];
    useAtelierStore.getState().hydrateRollQueue(persisted);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual(persisted);

    useAtelierStore.setState(initialAtelierState, true);
    useAtelierStore.getState().stashRoll({ id: 'live', text: 'live prompt', seed: 2, source: 'composer' });
    useAtelierStore.getState().hydrateRollQueue(persisted);
    expect(useAtelierStore.getState().draft.rollQueue.map((roll) => roll.id)).toEqual(['live']);
  });

  test('removeQueuedRoll filters by id', () => {
    useAtelierStore.getState().stashRoll({ id: 'a', text: 'one', seed: 1, source: 'template' });
    useAtelierStore.getState().stashRoll({ id: 'b', text: 'two', seed: 2, source: 'template' });
    useAtelierStore.getState().removeQueuedRoll('a');
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['b']);
  });

  test('removeQueuedRolls drops every given id, leaves the rest in order', () => {
    useAtelierStore.getState().stashRoll({ id: 'a', text: 'one', seed: 1, source: 'template' });
    useAtelierStore.getState().stashRoll({ id: 'b', text: 'two', seed: 2, source: 'template' });
    useAtelierStore.getState().stashRoll({ id: 'c', text: 'three', seed: 3, source: 'template' });
    useAtelierStore.getState().removeQueuedRolls(['a', 'c']);
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['b']);
  });

  test('removeQueuedRolls with an empty id list is a no-op', () => {
    useAtelierStore.getState().stashRoll({ id: 'a', text: 'one', seed: 1, source: 'template' });
    useAtelierStore.getState().removeQueuedRolls([]);
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['a']);
  });

  test('reorderQueuedRolls moves item from→to', () => {
    useAtelierStore.getState().stashRoll({ id: 'a', text: 'one', seed: 1, source: 'template' });
    useAtelierStore.getState().stashRoll({ id: 'b', text: 'two', seed: 2, source: 'template' });
    useAtelierStore.getState().stashRoll({ id: 'c', text: 'three', seed: 3, source: 'template' });
    useAtelierStore.getState().reorderQueuedRolls(0, 2);
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  test('clearRollQueue empties the queue', () => {
    useAtelierStore.getState().stashRoll({ id: 'a', text: 'one', seed: 1, source: 'template' });
    useAtelierStore.getState().clearRollQueue();
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
  });

  test('restoreRollQueue replaces the queue with a snapshot', () => {
    useAtelierStore.getState().stashRoll({ id: 'old', text: 'old', seed: 1, source: 'template' });
    useAtelierStore.getState().restoreRollQueue([
      { id: 'a', text: 'one', seed: 2, source: 'template' },
      { id: 'b', text: 'two', seed: 3, source: 'template' },
    ]);
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['a', 'b', 'old']);
  });

  test('a retired roll is removed and no restore brings it back', () => {
    const a = { id: 'a', text: 'one', seed: 1, source: 'template' as const };
    const b = { id: 'b', text: 'two', seed: 2, source: 'template' as const };
    useAtelierStore.getState().hydrateRollQueue([a, b]);
    useAtelierStore.getState().retireQueuedRolls(['a']);
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['b']);
    useAtelierStore.getState().clearRollQueue();
    useAtelierStore.getState().restoreRollQueue([a, b]);
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['b']);
  });

  test('setPickerTemplate(null) clears the queue', () => {
    useAtelierStore.getState().stashRoll({ id: 'a', text: 'one', seed: 1, source: 'template' });
    useAtelierStore.getState().setPickerTemplate(null);
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
  });

  test('setPickerTemplate to a different id clears the queue', () => {
    useAtelierStore.getState().setPickerTemplate('tpl-one');
    useAtelierStore.getState().stashRoll({ id: 'a', text: 'one', seed: 1, source: 'template' });
    useAtelierStore.getState().setPickerTemplate('tpl-two');
    expect(useAtelierStore.getState().draft.rollQueue).toEqual([]);
  });

  test('setPickerTemplate to the SAME id preserves the queue', () => {
    useAtelierStore.getState().setPickerTemplate('tpl-one');
    useAtelierStore.getState().stashRoll({ id: 'a', text: 'one', seed: 1, source: 'template' });
    useAtelierStore.getState().setPickerTemplate('tpl-one');
    expect(useAtelierStore.getState().draft.rollQueue.map((r) => r.id)).toEqual(['a']);
  });
});

describe('preparing counter', () => {
  beforeEach(() => { useAtelierStore.setState(initialAtelierState, true); });
  afterEach(() => { useAtelierStore.setState(initialAtelierState, true); });

  test('adds and settles, flooring at zero', () => {
    const { addPreparing, settlePreparing } = useAtelierStore.getState();
    addPreparing(3);
    expect(useAtelierStore.getState().preparing).toBe(3);
    settlePreparing(1);
    expect(useAtelierStore.getState().preparing).toBe(2);
    settlePreparing(5);
    expect(useAtelierStore.getState().preparing).toBe(0);
  });

  test('accumulates across concurrent adds', () => {
    const { addPreparing } = useAtelierStore.getState();
    addPreparing(2);
    addPreparing(3);
    expect(useAtelierStore.getState().preparing).toBe(5);
  });
});

describe('ai-fill active counters', () => {
  beforeEach(() => { useAtelierStore.setState(initialAtelierState, true); });
  afterEach(() => { useAtelierStore.setState(initialAtelierState, true); });

  test('increments and decrements each backend independently, flooring at zero', () => {
    const { beginAiFill, endAiFill } = useAtelierStore.getState();
    beginAiFill('kimi');
    beginAiFill('kimi');
    beginAiFill('mimo');
    expect(useAtelierStore.getState().aiFillActive).toEqual({ kimi: 2, mimo: 1, grok: 0, 'gemini-argon': 0, 'deepseek-abliterated': 0, 'glm-abliterated': 0, gpt: 0 });

    endAiFill('kimi');
    endAiFill('mimo');
    endAiFill('mimo');
    expect(useAtelierStore.getState().aiFillActive).toEqual({ kimi: 1, mimo: 0, grok: 0, 'gemini-argon': 0, 'deepseek-abliterated': 0, 'glm-abliterated': 0, gpt: 0 });
  });
});
