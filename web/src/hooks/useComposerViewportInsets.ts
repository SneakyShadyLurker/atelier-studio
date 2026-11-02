import { useEffect } from 'react';
import type { RefObject } from 'react';

export function useComposerViewportInsets(wrapRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const wrapEl = wrapRef.current;
    if (!vv || !wrapEl) return;
    // Mirror the keyboard inset onto :root as well as the composer wrap so the
    // ChipSelect bottom-sheet — which portals to <body> and is NOT a descendant
    // of the wrap — can sit above the soft keyboard instead of rendering behind
    // it (where the user never sees the menu they just opened).
    const root = document.documentElement;
    const update = () => {
      const offset = window.innerHeight - vv.height - vv.offsetTop;
      const value = `${Math.max(0, offset)}px`;
      wrapEl.style.setProperty('--keyboard-inset', value);
      root.style.setProperty('--keyboard-inset', value);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--keyboard-inset');
    };
  }, [wrapRef]);

  useEffect(() => {
    const wrapEl = wrapRef.current;
    if (!wrapEl) return;
    const vv = window.visualViewport;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      const rect = wrapEl.getBoundingClientRect();
      // getBoundingClientRect is in LAYOUT viewport coordinates; vv.height is
      // the VISUAL viewport. Mixing the two without vv.offsetTop under-reports
      // the composer's height by however far the soft keyboard has scrolled the
      // visual viewport — and a negative result clamps the canvas's reserve to
      // zero, dropping the whole gap the feed needs to clear the composer.
      const visualBottom = vv ? vv.height + vv.offsetTop : window.innerHeight;
      const fromBottom = Math.max(0, visualBottom - rect.top);
      root.style.setProperty('--composer-top', `${fromBottom}px`);
    };
    const scheduleUpdate = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrapEl);
    window.addEventListener('resize', scheduleUpdate);
    vv?.addEventListener('resize', scheduleUpdate);
    vv?.addEventListener('scroll', scheduleUpdate);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      vv?.removeEventListener('resize', scheduleUpdate);
      vv?.removeEventListener('scroll', scheduleUpdate);
      root.style.removeProperty('--composer-top');
    };
  }, [wrapRef]);
}
