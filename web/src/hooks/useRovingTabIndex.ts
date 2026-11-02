import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { runWhenReachable } from '../lib/focus';

function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}

const INTERACTIVE_SELECTOR = 'button,a[href],input,select,textarea,[role="button"],[contenteditable="true"]';

function interactiveControl(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target.isContentEditable) return target;
  return target.closest(INTERACTIVE_SELECTOR);
}

export function useRovingTabIndex<T extends HTMLElement>(
  count: number,
  active: number,
  options: { readonly orientation?: 'vertical' | 'horizontal' | 'both' } = {},
): {
  rowRefs: RefObject<(T | null)[]>;
  setRowRef: (index: number) => (node: T | null) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  focusAt: (index: number) => void;
} {
  const rowRefs = useRef<(T | null)[]>([]);
  const currentRef = useRef(clampIndex(active, count));
  const orientation = options.orientation ?? 'vertical';

  const syncTabIndex = useCallback(() => {
    rowRefs.current = rowRefs.current.slice(0, count);
    rowRefs.current.forEach((row, index) => {
      if (row) row.tabIndex = index === currentRef.current ? 0 : -1;
    });
  }, [count]);

  useEffect(() => {
    currentRef.current = clampIndex(active, count);
    syncTabIndex();
  }, [active, count, syncTabIndex]);

  const focusAt = (index: number) => {
    if (count <= 0) return;
    currentRef.current = (index + count) % count;
    syncTabIndex();
    // Defer the actual focus() so callers that just triggered a re-render
    // (optimistic mutation, inline-input commit) land on the post-commit
    // element at the requested index. The .current reads through fresh refs
    // by the time this fires.
    const target = rowRefs.current[currentRef.current];
    runWhenReachable(() => { target?.focus(); }, target);
  };

  const setRowRef = (index: number) => (node: T | null) => {
    rowRefs.current[index] = node;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const control = interactiveControl(event.target);
    if (control && !rowRefs.current.includes(control as T)) return;
    if (count <= 0) return;
    const nextKeys = orientation === 'vertical' ? ['ArrowDown'] : orientation === 'horizontal' ? ['ArrowRight'] : ['ArrowDown', 'ArrowRight'];
    const prevKeys = orientation === 'vertical' ? ['ArrowUp'] : orientation === 'horizontal' ? ['ArrowLeft'] : ['ArrowUp', 'ArrowLeft'];
    if (nextKeys.includes(event.key)) {
      event.preventDefault();
      focusAt(currentRef.current + 1);
    } else if (prevKeys.includes(event.key)) {
      event.preventDefault();
      focusAt(currentRef.current - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusAt(count - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      rowRefs.current[currentRef.current]?.click();
    }
  };

  return { rowRefs, setRowRef, onKeyDown, focusAt };
}
