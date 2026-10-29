import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { behindModal } from '../../hooks/useTooltipDismiss';
import styles from './index.module.css';

const OPEN_DELAY_MS = 400;
// Long enough to cross from the prompt onto the card (or back), short enough
// that leaving both reads as immediate.
const LEAVE_GRACE_MS = 200;

// 'pointer': opened by dwelling, the card follows the cursor. 'element':
// opened by focus or a tap, the card sits against the prompt itself.
type TipMode = 'pointer' | 'element';

function clearTimer(ref: { current: number | null }): void {
  if (ref.current === null) return;
  window.clearTimeout(ref.current);
  ref.current = null;
}

// The batch header prompt truncates to one line. On desktop, dwelling on a
// truncated prompt reveals the full text in a card that tracks the cursor.
// Isolated into a memo'd leaf keyed on the (post-creation-immutable) prompt
// string so the hover state + portal never re-render on the SSE tile hot path
// that churns the parent BatchView's `batch` ref.
//
// The card is portalled to <body>, out of the feed's clip, and stays in the
// page's z-index layer under the global toast stack, so it can never cover an
// Undo. CSS anchors it by this instance's own name, declared only on the
// active source: a zero-size stand-in carrying the pointer's client
// coordinates (pointer mode, written imperatively so a mousemove never
// renders) or the prompt (element mode). CSS (index.module.css .promptTip)
// flips and clamps the card. Everything here is interaction: truncation, the
// dwell, the travel grace onto the card, Escape and dismissal.
function BatchPromptImpl({ prompt, className }: { prompt: string; className?: string }) {
  const tipId = useId();
  // Per instance, so repeated headers cannot cross-bind.
  const anchor = { '--prompt-anchor': `--prompt-${tipId.replace(/[^\w-]/g, '')}` } as CSSProperties;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const graceRef = useRef<number | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const touchPointerRef = useRef(false);
  const overPromptRef = useRef(false);
  const overCardRef = useRef(false);
  // Escape closed a card the pointer still rests on: no dwell or takeover
  // reopens it until the pointer has left (or a fresh focus re-arms it).
  const dismissedRef = useRef(false);
  const [mode, setMode] = useState<TipMode | null>(null);
  const [truncated, setTruncated] = useState(false);
  const open = mode !== null;

  const close = useCallback(() => {
    clearTimer(timerRef);
    clearTimer(graceRef);
    setMode(null);
  }, []);

  const isTruncated = useCallback(() => {
    const text = textRef.current;
    return Boolean(text && (text.scrollWidth > text.clientWidth || text.scrollHeight > text.clientHeight));
  }, []);

  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return;
    const measure = () => {
      const next = isTruncated();
      setTruncated(next);
      if (!next) close();
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => { window.removeEventListener('resize', measure); };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => { observer.disconnect(); };
  }, [close, isTruncated, prompt]);

  // The pointer's client coordinates, not a placement: the card's own
  // position, flip and edge clearance are resolved by CSS against this point.
  const followPointer = useCallback(() => {
    const cursor = cursorRef.current;
    if (!cursor) return;
    const { x, y } = pointerRef.current;
    cursor.style.left = `${String(x)}px`;
    cursor.style.top = `${String(y)}px`;
  }, []);

  // Leaving the prompt or the card closes a pointer card only once the
  // pointer is over neither, so it can travel between the two.
  const leaveSoon = () => {
    clearTimer(graceRef);
    graceRef.current = window.setTimeout(() => {
      graceRef.current = null;
      if (overPromptRef.current || overCardRef.current) return;
      dismissedRef.current = false;
      setMode((current) => (current === 'pointer' ? null : current));
    }, LEAVE_GRACE_MS);
  };

  const handleEnter = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    overPromptRef.current = true;
    clearTimer(graceRef);
    // Desktop pointer only: a touch tap shouldn't summon a cursor tooltip,
    // and the no-hover layout line-clamps rather than ellipsis-truncates.
    if (!window.matchMedia('(hover: hover)').matches) return;
    if (dismissedRef.current || !isTruncated()) return;
    pointerRef.current = { x: event.clientX, y: event.clientY };
    clearTimer(timerRef);
    // Already showing (focus opened it, or the pointer came back from the
    // card): hand it to the pointer at once.
    if (open) {
      setMode('pointer');
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setMode('pointer');
    }, OPEN_DELAY_MS);
  };

  const handleMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    // React portals bubble through this owner: reading the card must not
    // move its pointer anchor away from the reader.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    // Returning from a portal child need not re-fire React's mouseenter on
    // this logical parent. Actual movement over the prompt reclaims it.
    overPromptRef.current = true;
    clearTimer(graceRef);
    pointerRef.current = { x: event.clientX, y: event.clientY };
    if (mode === 'pointer') followPointer();
  };

  const handleLeave = () => {
    overPromptRef.current = false;
    clearTimer(timerRef);
    if (mode === 'pointer') leaveSoon();
    else dismissedRef.current = false;
  };

  const openAnchored = () => {
    if (!truncated) return;
    // The pointer keeps a card it already owns.
    setMode((current) => current ?? 'element');
  };

  // Pointer mode: seed the stand-in before the card is shown, and dismiss if
  // the page scrolls or resizes out from under the cursor, since the point it
  // was opened at no longer means anything. The card's own scroll (a long
  // prompt read in place) is not that. Element mode needs neither: the
  // anchored card follows the prompt through scroll and resize on its own.
  useLayoutEffect(() => {
    if (mode !== 'pointer') return;
    followPointer();
    const dismiss = (event: Event) => {
      const card = cardRef.current;
      if (card && event.target instanceof Node && card.contains(event.target)) return;
      close();
    };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [close, followPointer, mode]);

  // Element mode: a prompt scrolled wholly out of its clip (still mounted and
  // focused) has its card hidden by CSS (anchors-visible), and a hidden card
  // must not keep owning Escape. Close it; focus stays, and a fresh focus
  // opens it again. Interaction liveness, not placement: only whether the
  // prompt intersects is read, and only while the card is open.
  useEffect(() => {
    const source = anchorRef.current;
    if (mode !== 'element' || !source || typeof IntersectionObserver === 'undefined') return;
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (!active) return;
      const latest = entries[entries.length - 1];
      if (!latest || latest.isIntersecting) return;
      clearTimer(timerRef);
      setMode((current) => (current === 'element' ? null : current));
    });
    observer.observe(source);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [mode]);

  // Escape closes the card wherever focus is (a dwell never moves it): window
  // capture, ahead of every overlay and the global keyboard registry, and
  // after the shared data-tip lifecycle, which App mounts first. Either one
  // consumes the key, and the other sees it defaultPrevented. A card whose
  // prompt a modal opened since has made unreachable leaves the key to it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const source = anchorRef.current;
      if (source && behindModal(source)) return;
      // Keyboard intent takes priority over an older card under a resting
      // pointer. Its own listener will consume this Escape.
      const focused = document.activeElement;
      const description = focused instanceof HTMLElement && focused !== source
        ? focused.getAttribute('aria-describedby') : null;
      if (description && document.getElementById(description)?.getAttribute('role') === 'tooltip') return;
      event.preventDefault();
      event.stopPropagation();
      // Coming back onto the prompt later is new intent; resting on it is not.
      if (overPromptRef.current) dismissedRef.current = true;
      close();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => { window.removeEventListener('keydown', onKeyDown, true); };
  }, [close, open]);

  // A card removed under the pointer never reports pointerleave.
  useLayoutEffect(() => {
    if (!open) overCardRef.current = false;
  }, [open]);

  // Clear pending timers if we unmount mid-dwell (virtualizer recycle).
  useLayoutEffect(() => () => {
    clearTimer(timerRef);
    clearTimer(graceRef);
  }, []);

  return (
    <div
      ref={anchorRef}
      className={className ? `${styles.prompt} ${className}` : styles.prompt}
      style={mode === 'element' ? anchor : undefined}
      tabIndex={truncated ? 0 : undefined}
      aria-describedby={open ? tipId : undefined}
      onMouseEnter={handleEnter}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      onPointerDown={(event) => {
        if (event.pointerType === 'touch') touchPointerRef.current = true;
      }}
      onFocus={() => {
        if (touchPointerRef.current) return;
        dismissedRef.current = false;
        openAnchored();
      }}
      onBlur={() => {
        touchPointerRef.current = false;
        setMode((current) => (current === 'element' ? null : current));
      }}
      onClick={() => {
        if (window.matchMedia('(hover: hover)').matches) return;
        touchPointerRef.current = false;
        if (truncated) setMode((current) => (current === null ? 'element' : null));
      }}
    >
      <span ref={textRef} className={styles.promptText}>{prompt}</span>
      {open && createPortal(
        <>
          {mode === 'pointer' ? <div ref={cursorRef} className={styles.promptCursor} style={anchor} aria-hidden="true" /> : null}
          <div
            ref={cardRef}
            id={tipId}
            className={styles.promptTip}
            style={anchor}
            data-anchor={mode}
            data-anchored="name"
            role="tooltip"
            onPointerEnter={() => {
              overPromptRef.current = false;
              overCardRef.current = true;
              clearTimer(timerRef);
              clearTimer(graceRef);
            }}
            onPointerLeave={() => {
              overCardRef.current = false;
              if (mode === 'pointer') leaveSoon();
            }}
          >
            {prompt}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

export default memo(BatchPromptImpl);
