import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { useVerticalDragReorder } from './useVerticalDragReorder';

const ROW_HEIGHT = 40;

function withStubbedRects(getY: (el: HTMLElement) => number | undefined) {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this instanceof HTMLElement) {
      const top = getY(this);
      if (typeof top === 'number') {
        return {
          top, left: 0, right: 200, bottom: top + ROW_HEIGHT,
          width: 200, height: ROW_HEIGHT, x: 0, y: top,
          toJSON: () => ({}),
        };
      }
    }
    return original.call(this);
  };
  return () => { Element.prototype.getBoundingClientRect = original; };
}

afterEach(cleanup);

function stubAnimationFrames() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  const request = spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  const cancel = spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { callbacks.delete(id); });
  return {
    callbacks,
    advance: () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      act(() => { for (const callback of pending) callback(0); });
    },
    restore: () => { request.mockRestore(); cancel.mockRestore(); },
  };
}

function HookHarness({
  onReorder,
  dropIndicator = false,
  allowKeyboard = false,
  ids = ['k0', 'k1', 'k2'],
}: {
  onReorder: (nextIds: string[]) => void;
  dropIndicator?: boolean;
  allowKeyboard?: boolean;
  ids?: readonly string[];
}) {
  const rows = useRef(new Map<string, HTMLElement | null>());
  const reorder = useVerticalDragReorder({
    ids,
    onReorder,
    getRowElement: (id) => rows.current.get(id) ?? null,
    dropIndicator,
    allowKeyboard,
  });
  return (
    <ul data-testid="list" data-indicator={reorder.dropIndicatorTop ?? 'none'} data-dragging={reorder.isDragging ? 'true' : 'false'}>
      {ids.map((id) => (
        <li
          key={id}
          ref={(node) => { rows.current.set(id, node); }}
          data-testid={`row-${id}`}
          {...(reorder.keyboardHandlers(id) ?? {})}
        >
          <button type="button" data-testid={`grip-${id}`} {...reorder.pointerHandlers(id)}>grip</button>
          <button type="button" data-testid={`select-${id}`} data-suppress={reorder.suppressClick(id) ? 'true' : 'false'}>select</button>
        </li>
      ))}
    </ul>
  );
}

describe('useVerticalDragReorder', () => {
  let restore: (() => void) | null = null;
  beforeEach(() => {
    restore = withStubbedRects((el) => {
      if (el.dataset.testid === 'list') return 0;
      const match = el.dataset.testid?.match(/^row-k(\d+)$/);
      return match?.[1] ? Number(match[1]) * ROW_HEIGHT : undefined;
    });
  });
  afterEach(() => { restore?.(); restore = null; });

  test('commits reordered ids from pointer drop position', () => {
    const onReorder = mock();
    const { getByTestId } = render(<HookHarness onReorder={onReorder} ids={['k0', 'k1', 'k2', 'k3']} />);
    const grip = getByTestId('grip-k0');

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 10 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 30 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 145 });

    expect(onReorder).toHaveBeenCalledWith(['k1', 'k2', 'k3', 'k0'], 'k0');
  });

  test('reports a drop indicator when enabled and drag crosses threshold', () => {
    const { getByTestId } = render(<HookHarness onReorder={mock()} dropIndicator />);
    const grip = getByTestId('grip-k0');

    act(() => {
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientY: 10 }));
      grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientY: 45 }));
    });

    expect(getByTestId('list').dataset.indicator).not.toBe('none');
    expect(getByTestId('list').dataset.dragging).toBe('true');
    expect(getByTestId('select-k0').dataset.suppress).toBe('true');
  });

  test('clears click suppression when an active pointer drag is cancelled', () => {
    const { getByTestId } = render(<HookHarness onReorder={mock()} />);
    const grip = getByTestId('grip-k0');

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 10 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 45 });
    expect(getByTestId('select-k0').dataset.suppress).toBe('true');

    fireEvent.pointerCancel(grip, { pointerId: 1, clientY: 45 });

    expect(getByTestId('select-k0').dataset.suppress).toBe('false');
  });

  test('scrolls a scrollable parent while the pointer is held at its bottom edge', () => {
    const frames = stubAnimationFrames();
    const ids = Array.from({ length: 20 }, (_, index) => `k${index}`);
    const onReorder = mock();
    const { getByTestId, unmount } = render(<HookHarness onReorder={onReorder} ids={ids} dropIndicator />);
    try {
      const list = getByTestId('list');
      list.style.overflowY = 'auto';
      Object.defineProperties(list, {
        clientHeight: { configurable: true, value: 200 },
        scrollHeight: { configurable: true, value: 800 },
        scrollTop: { configurable: true, writable: true, value: 0 },
      });
      restore?.();
      restore = withStubbedRects((el) => {
        if (el === list) return 0;
        const match = el.dataset.testid?.match(/^row-k(\d+)$/);
        return match?.[1] ? Number(match[1]) * ROW_HEIGHT - list.scrollTop : undefined;
      });
      const grip = getByTestId('grip-k0');
      fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 10 });
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: 190 });

      for (let i = 0; i < 20; i++) frames.advance();

      expect(list.scrollTop).toBe(120);
      expect(list.dataset.indicator).toBe('319');
      act(() => {
        list.scrollTop = 200;
        list.dispatchEvent(new Event('scroll'));
      });
      expect(list.dataset.indicator).toBe('399');
      fireEvent.pointerUp(grip, { pointerId: 1, clientY: 190 });
      expect(onReorder).toHaveBeenCalledWith([...ids.slice(1, 10), 'k0', ...ids.slice(10)], 'k0');
      expect(frames.callbacks.size).toBe(0);
    } finally {
      unmount();
      frames.restore();
    }
  });

  test('leaves a non-scrolling parent untouched at the same bottom-edge pointer position', () => {
    const frames = stubAnimationFrames();
    const { getByTestId, unmount } = render(<HookHarness onReorder={mock()} />);
    try {
      const list = getByTestId('list');
      list.style.overflowY = 'auto';
      Object.defineProperties(list, {
        clientHeight: { configurable: true, value: 200 },
        scrollHeight: { configurable: true, value: 200 },
        scrollTop: { configurable: true, writable: true, value: 0 },
      });
      const grip = getByTestId('grip-k0');
      fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 10 });
      fireEvent.pointerMove(grip, { pointerId: 1, clientY: 190 });

      for (let i = 0; i < 20; i++) frames.advance();

      expect(list.scrollTop).toBe(0);
      expect(frames.callbacks.size).toBe(0);
      fireEvent.pointerCancel(grip, { pointerId: 1, clientY: 190 });
    } finally {
      unmount();
      frames.restore();
    }
  });

  test('Alt+ArrowDown reorders when keyboard support is enabled', () => {
    const onReorder = mock();
    const { getByTestId } = render(<HookHarness onReorder={onReorder} allowKeyboard />);

    fireEvent.keyDown(getByTestId('row-k1'), { key: 'ArrowDown', altKey: true });

    expect(onReorder).toHaveBeenCalledWith(['k0', 'k2', 'k1'], 'k1');
  });

  test('Alt+ArrowUp reorders when keyboard support is enabled', () => {
    const onReorder = mock();
    const { getByTestId } = render(<HookHarness onReorder={onReorder} allowKeyboard />);

    fireEvent.keyDown(getByTestId('row-k1'), { key: 'ArrowUp', altKey: true });

    expect(onReorder).toHaveBeenCalledWith(['k1', 'k0', 'k2'], 'k1');
  });
});
