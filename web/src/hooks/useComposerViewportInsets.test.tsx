import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { useComposerViewportInsets } from './useComposerViewportInsets';

/*
 * The hook mixes two coordinate spaces on purpose and has to get the mix right:
 * `getBoundingClientRect()` is LAYOUT-viewport relative, `visualViewport.height`
 * is the VISUAL viewport. With a soft keyboard up, iOS shrinks the visual
 * viewport AND scrolls it (`offsetTop > 0`); dropping `offsetTop` under-reports
 * the composer's height by exactly that scroll, and the `Math.max(0, …)` floor
 * then silently clamps the canvas's bottom reserve to nothing — the feed loses
 * the whole gap that keeps the newest batch clear of the composer.
 */

interface FakeViewport {
  height: number;
  offsetTop: number;
  addEventListener: () => void;
  removeEventListener: () => void;
}

const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
const originalInnerHeight = window.innerHeight;

function installViewport(height: number, offsetTop: number): void {
  const fake: FakeViewport = {
    height,
    offsetTop,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true, writable: true });
}

/** Mounts the hook against a wrap whose top edge sits at `rectTop`. */
function renderWithWrapAt(rectTop: number): void {
  function Harness() {
    const wrapRef = useRef<HTMLDivElement | null>(null);
    useComposerViewportInsets(wrapRef);
    return (
      <div
        ref={(node) => {
          if (!node) return;
          node.getBoundingClientRect = () => ({
            top: rectTop, bottom: rectTop, left: 0, right: 0, width: 0, height: 0, x: 0, y: rectTop,
            toJSON: () => ({}),
          });
          wrapRef.current = node;
        }}
      />
    );
  }
  render(<Harness />);
}

function composerTop(): string {
  return document.documentElement.style.getPropertyValue('--composer-top');
}

afterEach(() => {
  cleanup();
  if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport);
  Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true, writable: true });
  document.documentElement.style.removeProperty('--composer-top');
  document.documentElement.style.removeProperty('--keyboard-inset');
});

describe('useComposerViewportInsets publishes --composer-top', () => {
  test('phone, keyboard up AND the visual viewport scrolled: reports the composer height', () => {
    // 844pt layout viewport; keyboard up and iOS has scrolled the visual
    // viewport 100pt to reveal the focused field, so vv = {height: 508,
    // offsetTop: 100} and `--keyboard-inset` = 844 - 508 - 100 = 236. The 150pt
    // composer is `fixed; bottom: var(--keyboard-inset)`, so its layout-relative
    // top is 844 - 236 - 150 = 458 — and it occupies the bottom 150pt of the
    // visual viewport, which is what --composer-top must report.
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true, writable: true });
    installViewport(508, 100);

    renderWithWrapAt(458);

    // Dropping offsetTop yields 508 - 458 = 50px: two thirds of the reserve gone.
    expect(composerTop()).toBe('150px');
  });

  test('keyboard up but the visual viewport unscrolled: both readings agree', () => {
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true, writable: true });
    installViewport(508, 0);

    renderWithWrapAt(358);

    expect(composerTop()).toBe('150px');
  });

  test('no keyboard: unchanged from the plain visual-viewport reading', () => {
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true, writable: true });
    installViewport(900, 0);

    // Desktop composer is `absolute; bottom: 24px`, so a 150pt card sits at 726.
    renderWithWrapAt(726);

    expect(composerTop()).toBe('174px');
  });

  test('never publishes a negative reserve', () => {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });
    installViewport(800, 0);

    renderWithWrapAt(1200);

    expect(composerTop()).toBe('0px');
  });
});
