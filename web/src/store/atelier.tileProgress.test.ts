import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { initialAtelierState, useAtelierStore } from './atelier';

const steps = (step: number) => ({ step, totalSteps: 10, pass: 1, passCount: 1 });

describe('tile progress rate', () => {
  beforeEach(() => { useAtelierStore.setState(initialAtelierState, true); });
  afterEach(() => { useAtelierStore.setState(initialAtelierState, true); });

  test('the first event records progress without a rate', () => {
    useAtelierStore.getState().setTileProgress('t', { progress: 0.1, ...steps(1) }, 1_000);
    expect(useAtelierStore.getState().tileProgress.t).toEqual({
      progress: 0.1, ...steps(1), msPerUnit: null, lastDelta: null, observations: 1, lastAt: 1_000,
    });
  });

  test('consecutive events build an EMA of milliseconds per unit of progress', () => {
    const { setTileProgress } = useAtelierStore.getState();
    setTileProgress('t', { progress: 0.1, ...steps(1) }, 1_000);
    setTileProgress('t', { progress: 0.2, ...steps(2) }, 2_000); // sample 10 000 ms/unit
    expect(useAtelierStore.getState().tileProgress.t?.msPerUnit).toBeCloseTo(10_000);
    setTileProgress('t', { progress: 0.3, ...steps(3) }, 4_000); // sample 20 000 ms/unit
    const entry = useAtelierStore.getState().tileProgress.t;
    expect(entry?.msPerUnit).toBeCloseTo(0.3 * 20_000 + 0.7 * 10_000);
    expect(entry?.lastDelta).toBeCloseTo(0.1);
    expect(entry?.observations).toBe(3);
    expect(entry?.lastAt).toBe(4_000);
  });

  test('an identical event is a no-op', () => {
    const { setTileProgress } = useAtelierStore.getState();
    setTileProgress('t', { progress: 0.1, ...steps(1) }, 1_000);
    const before = useAtelierStore.getState().tileProgress;
    setTileProgress('t', { progress: 0.1, ...steps(1) }, 5_000);
    expect(useAtelierStore.getState().tileProgress).toBe(before);
  });

  test('clear and clear-all remove entries', () => {
    const { setTileProgress, clearTileProgress, clearAllTileProgress } = useAtelierStore.getState();
    setTileProgress('a', { progress: 0.1 }, 1_000);
    setTileProgress('b', { progress: 0.2 }, 1_000);
    clearTileProgress('a');
    expect(Object.keys(useAtelierStore.getState().tileProgress)).toEqual(['b']);
    clearAllTileProgress();
    expect(useAtelierStore.getState().tileProgress).toEqual({});
  });
});
