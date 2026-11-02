import { describe, expect, test } from 'bun:test';
import type { TileProgress } from '../store/atelier';
import { describeEta, formatEta, isFinishing, remainingMs, stepDurationMs } from './stepEta';

function entry(overrides: Partial<TileProgress> = {}): TileProgress {
  return {
    progress: 0.5,
    step: 12,
    totalSteps: 25,
    pass: 1,
    passCount: 1,
    msPerUnit: 20_000,
    lastDelta: 0.04,
    observations: 3,
    lastAt: 1_000,
    ...overrides,
  };
}

describe('remainingMs', () => {
  test('is null until three observations', () => {
    expect(remainingMs(entry({ observations: 2 }), 1_000)).toBeNull();
    expect(remainingMs(entry({ observations: 3 }), 1_000)).toBe(10_000);
  });

  test('is null without a rate', () => {
    expect(remainingMs(entry({ msPerUnit: null }), 1_000)).toBeNull();
  });

  test('is null when finishing', () => {
    expect(remainingMs(entry({ step: 25, progress: 1 }), 1_000)).toBeNull();
  });

  test('counts down between events and floors at one second', () => {
    expect(remainingMs(entry(), 4_000)).toBe(7_000);
    expect(remainingMs(entry(), 60_000)).toBe(1_000);
  });

  test('a refine pass end is not finishing until the last pass', () => {
    expect(isFinishing(entry({ step: 25, passCount: 2 }))).toBe(false);
    expect(isFinishing(entry({ step: 8, totalSteps: 8, pass: 2, passCount: 2 }))).toBe(true);
    expect(isFinishing({ progress: 1, msPerUnit: null, lastDelta: null, observations: 1, lastAt: 0 })).toBe(false);
  });
});

describe('formatEta', () => {
  test('uses seconds under a minute and m:ss above', () => {
    expect(formatEta(9_000)).toBe('~9s');
    expect(formatEta(59_400)).toBe('~59s');
    expect(formatEta(65_000)).toBe('~1:05');
    expect(formatEta(200)).toBe('~1s');
  });

  test('describes the remaining time in words', () => {
    expect(describeEta(9_000)).toBe('about 9 seconds left');
    expect(describeEta(1_000)).toBe('about 1 second left');
    expect(describeEta(65_000)).toBe('about 1 minute 5 seconds left');
    expect(describeEta(120_000)).toBe('about 2 minutes left');
  });
});

describe('stepDurationMs', () => {
  test('derives the step cadence from the rate and clamps it', () => {
    expect(stepDurationMs(entry())).toBe(800);
    expect(stepDurationMs(entry({ lastDelta: 0.001 }))).toBe(120);
    expect(stepDurationMs(entry({ lastDelta: 0.5 }))).toBe(1_500);
    expect(stepDurationMs(entry({ msPerUnit: null }))).toBeNull();
  });
});
