import { describe, expect, test } from 'bun:test';
import { useAtelierStore } from './atelier';

describe('QueuedRoll brainstorm source', () => {
  test('stashes a roll with source "brainstorm"', () => {
    useAtelierStore.getState().clearRollQueue();
    useAtelierStore.getState().stashRoll({
      id: 'r1',
      text: 'a full-body woman...',
      seed: 7,
      source: 'brainstorm',
    });
    const queue = useAtelierStore.getState().draft.rollQueue;
    expect(queue.at(-1)).toMatchObject({ id: 'r1', source: 'brainstorm' });
  });
});
