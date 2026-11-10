import { memo, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useExitTransition } from '../../hooks/useExitTransition';
import { useOutsidePointer } from '../../hooks/useOutsidePointer';
import { behindModal } from '../../hooks/useTooltipDismiss';
import { runWhenReachable } from '../../lib/focus';
import { batchSuccessor, focusSuccessor } from '../../lib/focusSuccessor';
import styles from './index.module.css';

interface BatchPromptProps {
  prompt: string;
  className?: string;
  /**
   * The full-prompt card is open (the batch More menu's "Show full prompt").
   * An owner without that menu (the Archive tile) leaves it closed.
   */
  open?: boolean;
  /** The card asks to close: Escape, a press outside it, its prompt scrolled out of view. */
  onClose?: () => void;
  /** Whether the one-line prompt is cut off (only then does the menu offer the card). */
  onTruncatedChange?: (truncated: boolean) => void;
  /** Where focus returns when the card closes: the More button that opened it. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

// The batch header prompt truncates to one line (two on a phone). Nothing
// about the prompt itself opens the full text: no hover, focus or tap. The
// batch More menu offers "Show full prompt" while the prompt is truncated,
// which this leaf measures and reports up. Isolated into a memo'd leaf keyed
// on the (post-creation-immutable) prompt string so the card never
// re-renders on the SSE tile hot path that churns the parent BatchView's
// `batch` ref.
//
// The card is a non-modal dialog named "Full prompt", portalled to <body>,
// out of the feed's clip, and kept in the page's z-index layer under the
// global toast stack, so it can never cover an Undo. CSS anchors it to the
// prompt by this instance's own name, declared only while the card is shown
// (index.module.css .promptTip). It takes focus on open and closes on Escape,
// on a press outside it, when its prompt scrolls out of view and when the
// row unmounts. Closing returns focus to the More button, or along the feed's
// focus-successor chain when that is gone. Every close plays the overlay
// fade: the card composes surface.fade and stays mounted, closed for
// assistive tech, through useExitTransition's beat.
function BatchPromptImpl({ prompt, className, open = false, onClose, onTruncatedChange, returnFocusRef }: BatchPromptProps) {
  const tipId = useId();
  // Per instance, so repeated headers cannot cross-bind.
  const anchor = { '--prompt-anchor': `--prompt-${tipId.replace(/[^\w-]/g, '')}` } as CSSProperties;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // The row's successor, recorded at open: the More button leaves with the
  // row, and so does this prompt.
  const successorRef = useRef<HTMLElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  const visible = open && truncated;
  // Kept through the exit, so the card and its anchor stay put while it fades.
  const [shown, setShown] = useState(false);
  if (visible && !shown) setShown(true);
  const { closing, requestClose, cancelClose } = useExitTransition(() => { setShown(false); });
  useLayoutEffect(() => {
    if (visible) cancelClose();
    else if (shown) requestClose();
  }, [cancelClose, requestClose, shown, visible]);

  const reportTruncated = useEffectEvent((next: boolean) => {
    setTruncated(next);
    onTruncatedChange?.(next);
    // The prompt fits again (a resize, a rotation): the card has nothing to
    // show, so the owner closes it. Left open, it would come back by itself,
    // and take focus, the next time the prompt truncated.
    if (!next && open) onClose?.();
  });
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return;
    const measure = () => {
      reportTruncated(text.scrollWidth > text.clientWidth || text.scrollHeight > text.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => { window.removeEventListener('resize', measure); };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => { observer.disconnect(); };
  }, [prompt]);

  const requestCardClose = useEffectEvent(() => { onClose?.(); });

  // Focus moves into the card on open; the row's successor is recorded now,
  // while the row is still there to read.
  useEffect(() => {
    if (!visible) return undefined;
    const source = anchorRef.current;
    successorRef.current = source ? batchSuccessor(source) : null;
    const card = cardRef.current;
    // Read at close, not now: the More button can remount while the card is open.
    const readReturnTarget = () => returnFocusRef?.current ?? null;
    runWhenReachable(() => { card?.focus({ preventScroll: true }); }, card);
    return () => {
      // Hand focus on only when the card held it (an outside press already
      // moved it where the reader pressed) or it fell to <body>.
      const active = document.activeElement;
      if (active !== null && active !== document.body && !card?.contains(active)) return;
      const back = readReturnTarget();
      const successor = successorRef.current;
      queueMicrotask(() => {
        const current = document.activeElement;
        if (current !== null && current !== document.body && !card?.contains(current)) return;
        if (back?.isConnected) runWhenReachable(() => { back.focus({ preventScroll: true }); }, back);
        else focusSuccessor(successor);
      });
    };
  }, [returnFocusRef, visible]);

  // Escape closes the card wherever focus is: window capture, ahead of every
  // overlay and the global keyboard registry. A card whose prompt a modal
  // opened since has made unreachable leaves the key to it.
  useEffect(() => {
    if (!visible) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const source = anchorRef.current;
      if (source && behindModal(source)) return;
      event.preventDefault();
      event.stopPropagation();
      requestCardClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => { window.removeEventListener('keydown', onKeyDown, true); };
  }, [visible]);

  // A press anywhere outside the card closes it (light dismiss). The card has
  // no backdrop, so the shared hook's pointerdown is the right moment.
  useOutsidePointer([cardRef], () => { onClose?.(); }, { enabled: visible });

  // A prompt scrolled wholly out of its clip has its card hidden by CSS
  // (anchors-visible), and a hidden card must not keep owning focus and
  // Escape: close it. Interaction liveness, not placement: only whether the
  // prompt intersects is read, and only while the card is open.
  useEffect(() => {
    const source = anchorRef.current;
    if (!visible || !source || typeof IntersectionObserver === 'undefined') return undefined;
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (!active) return;
      const latest = entries[entries.length - 1];
      if (!latest || latest.isIntersecting) return;
      requestCardClose();
    });
    observer.observe(source);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [visible]);

  return (
    <div
      ref={anchorRef}
      className={className ? `${styles.prompt} ${className}` : styles.prompt}
      style={shown ? anchor : undefined}
    >
      <span ref={textRef} className={styles.promptText}>{prompt}</span>
      {shown && createPortal(
        <div
          ref={cardRef}
          id={tipId}
          className={styles.promptTip}
          style={anchor}
          data-anchored="name"
          data-closing={closing ? 'true' : undefined}
          role="dialog"
          aria-modal="false"
          aria-label="Full prompt"
          aria-hidden={visible ? undefined : 'true'}
          inert={!visible || undefined}
          tabIndex={-1}
        >
          {prompt}
        </div>,
        document.body,
      )}
    </div>
  );
}

export default memo(BatchPromptImpl);
