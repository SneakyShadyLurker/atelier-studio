import { useId, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useExitTransition } from '../../hooks/useExitTransition';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useIsPhone } from '../../hooks/useIsPhone';
import { useModalChrome, useModalToastHost } from '../../hooks/useModalChrome';
import { useAnchoredPopover } from '../../hooks/useNativeAnchor';
import { useNestedDialogEscape } from '../../hooks/useNestedDialogEscape';
import { useOutsidePointer } from '../../hooks/useOutsidePointer';
import { useTextModelGate } from '../../hooks/useTextModelGate';
import anchors from '../../styles/anchors.module.css';
import btn from '../../styles/buttons.module.css';
import styles from './index.module.css';

export interface TextModelNoteProps {
  readonly open: boolean;
  /** The AI action's verb, e.g. "Enhance": the note reads "<Action> needs a text model." */
  readonly action: string;
  /** The pressed control (or the More button that survives its menu). */
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  /**
   * The host's actual nesting (docs/web-conventions.md Escape routing):
   * 'top-level' for page hosts (Composer, Prompt Library editors) runs
   * `useModalChrome`; 'nested' for hosts inside a `useModalChrome` overlay
   * (PromptPicker, BrainstormPhase, a DialogShell) runs
   * `useNestedDialogEscape`, so one Escape closes only the note.
   */
  readonly escape: 'top-level' | 'nested';
  /**
   * Host-aware: closes the host's own overlay through its exit, then switches
   * to Text models (`lib/textModelsNav.ts goToTextModels`).
   */
  readonly navigateToTextModels: () => void;
}

/** Marks the note's portal so a nested host's outside-pointer treats it as inside. */
export const TEXT_MODEL_NOTE_ATTR = 'data-text-model-note';

/**
 * The anchored note an AI action opens when no text model is configured at
 * all (`useTextModelGate` 'none'): a single-purpose popover (phone: sheet),
 * like MovePopover. Admins get a way to Text models; everyone else is told to
 * ask their admin, which is also the reading while the admin probe is still
 * unsettled (it upgrades in place when the probe answers 'yes').
 */
export default function TextModelNote({ open, action, anchorRef, onClose, escape, navigateToTextModels }: TextModelNoteProps) {
  const isPhone = useIsPhone();
  const { admin } = useTextModelGate();
  const titleId = useId();
  const portalRootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Every dismissal (Escape, outside pointer, backdrop) plays the shared exit
  // before the host unmounts the note.
  const { closing, requestClose } = useExitTransition(onClose, open);
  const topLevel = escape === 'top-level';

  // Toasts render inside the trapped panel; the phone/desktop branches below
  // replace that node, so both follow the key.
  const bindModalChrome = useModalChrome({
    open: open && topLevel,
    onCancel: requestClose,
    portalRef: portalRootRef,
    toastHostRef: panelRef,
    containerKey: isPhone,
  });
  const bindNestedHost = useModalToastHost({ active: open && !topLevel, toastHostRef: panelRef, containerKey: isPhone });
  useNestedDialogEscape(open && !topLevel, requestClose);
  const bindToastHost = topLevel ? bindModalChrome : bindNestedHost;
  useFocusTrap(panelRef, { active: open, returnFocusTo: anchorRef, containerKey: isPhone });
  // Phone renders a backdrop that dismisses on click — see the touch rule in
  // useOutsidePointer.
  useOutsidePointer([panelRef, anchorRef], requestClose, { enabled: open && !isPhone });

  // Desktop: a manual top-layer popover anchored under the pressed control.
  // The phone sheet is unanchored.
  const popoverProps = useAnchoredPopover(panelRef, anchorRef, {
    active: open && !isPhone,
    containerKey: isPhone,
    onNativeClose: requestClose,
  });

  if (!open) return null;

  // Choosing the action closes at once (instant selection, like
  // OverflowMenu): the host owns the exit of whatever it closes next.
  const setUp = () => {
    if (closing) return;
    onClose();
    navigateToTextModels();
  };

  const panel = (
    <div
      ref={bindToastHost}
      className={`${styles.panel} ${isPhone ? styles.sheet : `${styles.popover} ${anchors.panel}`}`}
      data-closing={closing ? 'true' : undefined}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-mobile={isPhone ? 'true' : 'false'}
      data-anchor-place={isPhone ? undefined : 'below-start'}
      {...popoverProps}
    >
      <p id={titleId} className={styles.sentence}>{action} needs a text model.</p>
      {admin === 'yes' ? (
        <button className={`${btn.secondary} ${styles.action}`} type="button" onClick={setUp}>
          Set up text models
        </button>
      ) : (
        <>
          <p className={styles.sentence}>Ask your admin to connect a text model.</p>
          {/* Every state keeps a control inside the modal note, so the focus
              trap holds Tab here instead of leaking into a nested host. */}
          <button className={`${btn.secondary} ${styles.action}`} type="button" onClick={requestClose}>
            Close
          </button>
        </>
      )}
    </div>
  );

  return createPortal(
    <div ref={portalRootRef} className={styles.portalRoot} {...{ [TEXT_MODEL_NOTE_ATTR]: 'true' }}>
      {isPhone ? (
        <>
          <button className={styles.backdrop} type="button" aria-label="Close note" data-closing={closing ? 'true' : undefined} onClick={requestClose} />
          {panel}
        </>
      ) : panel}
    </div>,
    document.body,
  );
}
