import type { RefObject } from 'react';
import { useEffect, useEffectEvent } from 'react';
import { behindModal } from '../../hooks/useTooltipDismiss';

export interface RootClickTarget {
  readonly ref: RefObject<HTMLElement | null>;
  /** The control is visible and enabled right now. */
  readonly active: boolean;
  readonly activate: () => void;
}

export function elementContainsPoint(element: HTMLElement, x: number, y: number): boolean {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0
    && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

/**
 * While the browser prepares a view transition it suspends hit-testing and
 * delivers a click to the root element, so a press on a control is lost. A
 * click whose target IS the root and whose point falls inside one of these
 * controls activates that control once, unless the control is inert (a modal
 * is open over it). A click with a real target never
 * reaches this path (its target is not the root), so nothing runs twice.
 */
export function useRootClickRescue(targets: readonly RootClickTarget[]): void {
  const onClick = useEffectEvent((event: MouseEvent) => {
    if (event.target !== document.documentElement || event.defaultPrevented) return;
    for (const target of targets) {
      const element = target.ref.current;
      if (!target.active || !element?.isConnected) continue;
      // Behind a modal the Composer is inert, whether a custom overlay swept
      // it with `inert` or a native modal dialog owns the page: a press on a
      // dialog control that happens to sit over Generate is not a press on
      // Generate.
      if (behindModal(element)) continue;
      if (!elementContainsPoint(element, event.clientX, event.clientY)) continue;
      target.activate();
      return;
    }
  });
  useEffect(() => {
    const controller = new AbortController();
    document.addEventListener('click', onClick, { signal: controller.signal });
    return () => { controller.abort(); };
  }, []);
}
