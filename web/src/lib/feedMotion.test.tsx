import { describe, expect, test } from 'bun:test';
import { act, render } from '@testing-library/react';
import { grewOnlyAtEnd, sameRows, useMotionSnapshot } from './feedMotion';

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const none: ReadonlySet<string> = new Set();

describe('grewOnlyAtEnd', () => {
  test('new rows at the newest end, and rows changing in place, are plain', () => {
    expect(grewOnlyAtEnd(rows('a', 'b'), rows('a', 'b'), none)).toBe(true);
    expect(grewOnlyAtEnd(rows('a', 'b'), rows('a', 'b', 'c'), none)).toBe(true);
    expect(grewOnlyAtEnd([], rows('a'), none)).toBe(true);
  });

  test('a row leaving, moving, or arriving anywhere else reshapes the list', () => {
    expect(grewOnlyAtEnd(rows('a', 'b'), rows('a'), none)).toBe(false);
    expect(grewOnlyAtEnd(rows('a', 'b'), rows('b', 'a'), none)).toBe(false);
    expect(grewOnlyAtEnd(rows('b'), rows('a', 'b'), none)).toBe(false);
    expect(grewOnlyAtEnd(rows('a', 'c'), rows('a', 'b', 'c'), none)).toBe(false);
  });

  // An Undo puts back a row the surface has shown: it fades in through its
  // boundary, which only a Transition activates.
  test('a row coming back at the newest end reshapes the list', () => {
    expect(grewOnlyAtEnd(rows('a'), rows('a', 'b'), new Set(['b']))).toBe(false);
    expect(grewOnlyAtEnd(rows('a'), rows('a', 'b', 'c'), new Set(['c']))).toBe(false);
  });
});

describe('sameRows', () => {
  test('compares ids in order', () => {
    expect(sameRows(rows('a', 'b'), rows('a', 'b'))).toBe(true);
    expect(sameRows(rows('a', 'b'), rows('a'))).toBe(false);
    expect(sameRows(rows('a', 'b'), rows('b', 'a'))).toBe(false);
    expect(sameRows(rows('a'), rows('a', 'b'))).toBe(false);
  });
});

describe('useMotionSnapshot', () => {
  const plain = (shown: readonly { id: string }[], live: readonly { id: string }[]) => grewOnlyAtEnd(shown, live, none);
  function Probe({ live, seenRenders }: { live: readonly { id: string }[]; seenRenders: string[] }) {
    const shown = useMotionSnapshot(live, plain);
    seenRenders.push(shown.map((row) => row.id).join(''));
    return <output>{shown.map((row) => row.id).join('')}</output>;
  }

  test('a plain change is shown in the render that receives it', () => {
    const renders: string[] = [];
    const view = render(<Probe live={rows('a')} seenRenders={renders} />);
    renders.length = 0;
    view.rerender(<Probe live={rows('a', 'b')} seenRenders={renders} />);
    // Never the stale list: the first render already returns the live value.
    expect(renders.every((value) => value === 'ab')).toBe(true);
    expect(view.container.textContent).toBe('ab');
  });

  test('a reshape keeps the shown rows for the urgent render and lands in a Transition', async () => {
    const renders: string[] = [];
    const view = render(<Probe live={rows('a', 'b')} seenRenders={renders} />);
    renders.length = 0;
    await act(async () => {
      view.rerender(<Probe live={rows('a')} seenRenders={renders} />);
      await Promise.resolve();
    });
    expect(renders[0]).toBe('ab');
    expect(view.container.textContent).toBe('a');
  });

  // React holds a Transition while a view transition runs. A reshape that
  // arrives after plain changes must start from the rows on screen.
  test('a reshape starts from the last plain change, not from an older snapshot', async () => {
    const renders: string[] = [];
    const view = render(<Probe live={rows('a')} seenRenders={renders} />);
    view.rerender(<Probe live={rows('a', 'b')} seenRenders={renders} />);
    renders.length = 0;
    await act(async () => {
      view.rerender(<Probe live={rows('b')} seenRenders={renders} />);
      await Promise.resolve();
    });
    expect(renders[0]).toBe('ab');
    expect(view.container.textContent).toBe('b');
  });
});
