import type { RefObject } from 'react';
import { useEffect, useEffectEvent } from 'react';

/** How long the desktop Composer waits, untouched while work runs, before it yields the viewport. */
export const COMPOSER_IDLE_YIELD_MS = 6_000;

/**
 * Fires `onIdle` once the Composer has gone COMPOSER_IDLE_YIELD_MS with no
 * pointer movement over it, no key press inside it and no focus moving into
 * it. Armed only while `enabled` (work is running and the Composer is open);
 * any of those interactions restarts the delay, and disarming clears it.
 * `onIdle` decides whether yielding is allowed at that moment.
 */
export function useComposerIdleYield(
  targetRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onIdle: () => void,
): void {
  const fire = useEffectEvent(onIdle);
  useEffect(() => {
    const target = targetRef.current;
    if (!enabled || !target) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { fire(); restart(); }, COMPOSER_IDLE_YIELD_MS);
    };
    const controller = new AbortController();
    const options = { signal: controller.signal, passive: true } as const;
    for (const name of ['pointermove', 'pointerleave', 'keydown', 'focusin'] as const) {
      target.addEventListener(name, restart, options);
    }
    restart();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, targetRef]);
}
