import type { RefObject } from 'react';
import { useEffect } from 'react';

interface OutsidePointerOptions {
  event?: 'pointerdown' | 'mousedown';
  enabled?: boolean;
}

/**
 * Shared outside-pointer dismissal for popovers and nested floating surfaces.
 * Include every surface that should count as inside for the current layer; for
 * stacked surfaces, parents should also include child portal refs so a child
 * interaction does not dismiss the parent.
 *
 * TOUCH RULE — a surface that renders its own full-screen backdrop (every
 * popover's phone/sheet form does) MUST pass `enabled: false` in that mode and
 * let the backdrop's CLICK dismiss it. This fires on `pointerdown`, which on a
 * tap precedes `click`: dismissing here unmounts the backdrop mid-tap, and the
 * click then lands on whatever is underneath. Chromium retargets that click to
 * the removed node's nearest surviving ancestor and it usually dies quietly;
 * WebKit dispatches it on the element now under the finger, so the tap bleeds
 * into the layer below — dismissing a parent sheet, collapsing the composer, or
 * opening a tile. The backdrop already covers every outside pixel, so nothing
 * is lost by turning this off wherever one exists.
 */
export function useOutsidePointer(
  refs: readonly RefObject<Element | null>[],
  onOutside: () => void,
  options: OutsidePointerOptions = {},
): void {
  const eventName = options.event ?? 'pointerdown';
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    const onPointer = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      onOutside();
    };
    document.addEventListener(eventName, onPointer);
    return () => { document.removeEventListener(eventName, onPointer); };
  }, [enabled, eventName, onOutside, refs]);
}
