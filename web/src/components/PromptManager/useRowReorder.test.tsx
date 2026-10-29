import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRowReorder } from './useRowReorder';

const ROW_HEIGHT = 40;

// happy-dom returns a zero-rect for every element, which would collapse the
// midpoint test in computeTargetIndex. Stub getBoundingClientRect with a
// laid-out vertical stack of 40px rows so the geometry math is exercised.
function withStubbedRects(getY: (el: HTMLElement) => number | undefined) {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this instanceof HTMLElement) {
      const top = getY(this);
      if (typeof top === 'number') {
        return {
          top, left: 0, right: 0, bottom: top + ROW_HEIGHT,
          width: 0, height: ROW_HEIGHT, x: 0, y: top,
          toJSON: () => ({}),
        };
      }
    }
    return original.call(this);
  };
  return () => { Element.prototype.getBoundingClientRect = original; };
}

afterEach(cleanup);

function Harness({ onReorder, keys = ['k0', 'k1', 'k2'] }: { onReorder: (from: number, to: number) => void; keys?: readonly string[] }) {
  const r = useRowReorder(keys, onReorder);
  return (
    <ul>
      <li data-testid="dragging">{r.draggingKey ?? 'none'}</li>
      {keys.map((k, i) => (
        <li key={k} ref={r.registerRow(k)} data-testid={`row-${i}`}>
          <button type="button" data-testid={`grip-${i}`} {...r.gripHandlers(k)}>grip</button>
          <input data-testid={`inp-${i}`} onKeyDown={(e) => { r.keyboardHandlers(k)?.onKeyDown(e); }} />
        </li>
      ))}
    </ul>
  );
}

describe('useRowReorder – pointer drag to absolute position', () => {
  let restore: (() => void) | null = null;
  beforeEach(() => {
    // Lay out rows at y=0, 40, 80, 120, 160 …
    restore = withStubbedRects((el) => {
      const m = el.getAttribute('data-testid')?.match(/^row-(\d+)$/);
      return m?.[1] ? Number(m[1]) * ROW_HEIGHT : undefined;
    });
  });
  afterEach(() => { restore?.(); restore = null; });

  test('drag from row 0 down past the midpoint of row 3 commits 0 → 3', () => {
    const onReorder = mock();
    const { getByTestId } = render(<Harness onReorder={onReorder} keys={['k0', 'k1', 'k2', 'k3', 'k4']} />);
    const grip = getByTestId('grip-0');
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 10 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 30 });   // cross threshold
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 145 });     // bottom half of row 3 (120..160), midpoint 140
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(0, 3);
  });

  test('drag from row 4 up past the midpoint of row 1 commits 4 → 1', () => {
    const onReorder = mock();
    const { getByTestId } = render(<Harness onReorder={onReorder} keys={['k0', 'k1', 'k2', 'k3', 'k4']} />);
    const grip = getByTestId('grip-4');
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 170 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 140 });  // cross threshold
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 50 });      // top half of row 1 (40..80), midpoint 60
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(4, 1);
  });

  test('drop within the dragged row’s own slot is a no-op', () => {
    const onReorder = mock();
    const { getByTestId } = render(<Harness onReorder={onReorder} keys={['k0', 'k1', 'k2']} />);
    const grip = getByTestId('grip-1');
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 50 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 70 });   // cross threshold
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 55 });      // top half of row 1 → targetIndex 1 → dest === from
    expect(onReorder).not.toHaveBeenCalled();
  });

  test('drop past the last row clamps to the last index', () => {
    const onReorder = mock();
    const { getByTestId } = render(<Harness onReorder={onReorder} keys={['k0', 'k1', 'k2']} />);
    const grip = getByTestId('grip-0');
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 10 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 30 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 9999 });   // beyond every row → targetIndex 3 → dest 2
    expect(onReorder).toHaveBeenCalledWith(0, 2);
  });

  test('movement under threshold does not reorder', () => {
    const onReorder = mock();
    const { getByTestId } = render(<Harness onReorder={onReorder} />);
    const grip = getByTestId('grip-1');
    fireEvent.pointerDown(grip, { button: 0, pointerId: 2, clientY: 100 });
    fireEvent.pointerMove(grip, { pointerId: 2, clientY: 103 });
    fireEvent.pointerUp(grip, { pointerId: 2, clientY: 103 });
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe('useRowReorder – keyboard ±1', () => {
  test('Alt+ArrowUp moves -1', () => {
    const onReorder = mock();
    const { getByTestId } = render(<Harness onReorder={onReorder} />);
    fireEvent.keyDown(getByTestId('inp-1'), { key: 'ArrowUp', altKey: true });
    expect(onReorder).toHaveBeenCalledWith(1, 0);
  });

  test('Alt+ArrowUp at the top edge is clamped (no call)', () => {
    const onReorder = mock();
    const { getByTestId } = render(<Harness onReorder={onReorder} />);
    fireEvent.keyDown(getByTestId('inp-0'), { key: 'ArrowUp', altKey: true });
    expect(onReorder).not.toHaveBeenCalled();
  });

  test('Alt+ArrowDown moves +1', () => {
    const onReorder = mock();
    const { getByTestId } = render(<Harness onReorder={onReorder} />);
    fireEvent.keyDown(getByTestId('inp-1'), { key: 'ArrowDown', altKey: true });
    expect(onReorder).toHaveBeenCalledWith(1, 2);
  });
});

describe('useRowReorder – draggingKey and pointer lifecycle', () => {
  test('draggingKey is null initially, set after threshold crossed, cleared on pointerUp', () => {
    const onReorder = mock();
    const { getByTestId } = render(<Harness onReorder={onReorder} />);
    const grip = getByTestId('grip-0');

    expect(getByTestId('dragging').textContent).toBe('none');

    act(() => {
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientY: 0 }));
    });
    expect(getByTestId('dragging').textContent).toBe('none');

    act(() => {
      grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 20 }));
    });
    expect(getByTestId('dragging').textContent).toBe('k0');

    act(() => {
      grip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientY: 20 }));
    });
    expect(getByTestId('dragging').textContent).toBe('none');
  });

  test('pointerCancel resets draggingKey to null and leaves onReorder uncalled', () => {
    const onReorder = mock();
    const { getByTestId } = render(<Harness onReorder={onReorder} />);
    const grip = getByTestId('grip-1');

    act(() => {
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 2, clientY: 0 }));
      grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 2, clientY: 20 }));
    });
    expect(getByTestId('dragging').textContent).toBe('k1');

    act(() => {
      fireEvent.pointerCancel(grip);
    });
    expect(getByTestId('dragging').textContent).toBe('none');
    expect(onReorder).not.toHaveBeenCalled();
  });

  test('pointerMove under threshold never sets draggingKey and pointerUp does not call onReorder', () => {
    const onReorder = mock();
    const { getByTestId } = render(<Harness onReorder={onReorder} />);
    const grip = getByTestId('grip-2');

    act(() => {
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 3, clientY: 100 }));
      grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 3, clientY: 103 }));
    });
    expect(getByTestId('dragging').textContent).toBe('none');

    act(() => {
      grip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3, clientY: 103 }));
    });
    expect(getByTestId('dragging').textContent).toBe('none');
    expect(onReorder).not.toHaveBeenCalled();
  });

  test('pointerDown requests pointer capture so the drag survives leaving the grip', () => {
    const onReorder = mock();
    const { getByTestId } = render(<Harness onReorder={onReorder} />);
    const grip = getByTestId('grip-0') as HTMLElement & { setPointerCapture: ReturnType<typeof mock> };
    const captured: number[] = [];
    grip.setPointerCapture = mock((id: number) => { captured.push(id); });
    fireEvent.pointerDown(grip, { button: 0, pointerId: 7, clientY: 0 });
    expect(captured).toEqual([7]);
  });
});
