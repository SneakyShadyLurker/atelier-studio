import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { useId, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useIsPhone } from '../../hooks/useIsPhone';
import { useModalChrome } from '../../hooks/useModalChrome';
import { useOutsidePointer } from '../../hooks/useOutsidePointer';
import { I } from '../icons/I';
import styles from './index.module.css';
import btn from '../../styles/buttons.module.css';

interface HelpPanelProps {
  open: boolean;
  /** Applied to the dialog element so the ⓘ button's aria-controls resolves. */
  panelId: string;
  /** The trigger that toggles this panel; excluded from outside-pointerdown dismiss
   * so a click on it can close (rather than close-then-reopen). */
  triggerRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}

export default function HelpPanel({ open, panelId, triggerRef, onClose }: HelpPanelProps) {
  const isPhone = useIsPhone();
  const portalRootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const outsideRefs = triggerRef ? [panelRef, triggerRef] : [panelRef];

  // Toasts render inside the trapped panel (its node is stable across the
  // phone/desktop switch — only the backdrop sibling toggles).
  useModalChrome({ open, onCancel: onClose, portalRef: portalRootRef, toastHostRef: panelRef });
  useFocusTrap(panelRef, { active: open });
  // Phone renders a backdrop that dismisses on click — see the touch rule in
  // useOutsidePointer.
  useOutsidePointer(outsideRefs, onClose, { enabled: open && !isPhone });

  if (!open) return null;

  return createPortal(
    <div ref={portalRootRef}>
      {/* Backdrop is phone-only, matching the sibling overlays (PromptPicker,
          BatchOverflowMenu, MovePopover): desktop popovers are scrim-free and
          dismiss via outside-pointer; the sheet keeps a labeled tap-catcher. */}
      {isPhone && (
        <button className={styles.helpBackdrop} type="button" aria-label="Close help" onClick={onClose} />
      )}
      <div
        ref={panelRef}
        id={panelId}
        className={`${styles.helpPanelLayer} ${isPhone ? styles.helpSheet : styles.helpPopover}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-mobile={isPhone ? 'true' : 'false'}
      >
        <div className={styles.helpHead} data-zone="head">
          <h2 id={titleId}>How the prompt library works</h2>
          <button
            className={btn.icon}
            type="button"
            aria-label="Close help"
            data-tip="Close help"
            data-tip-place="below"
            onClick={onClose}
          >
            <I.close />
          </button>
        </div>
        <div className={styles.helpBody} data-zone="body">
          <p>
            <strong>Templates</strong> are reusable prompts. <code>{'{{var::ethnicity}}'}</code> pulls a value from a
            Variable list; <code>{'{{random::a::b::c}}'}</code> is an inline one-off choice; <code>{'{{pick::…}}'}</code>{' '}
            is the same, seeded; <code>{'{{roll::1d6}}'}</code> and <code>{'{{user}}'}</code> also work. The resolved
            prompt must fit {MAX_PROMPT_CHARS} chars (see the meter in the Template editor).
          </p>
          <p>
            <strong>Variable lists</strong> are the reusable axes (e.g. <em>ethnicity</em>, <em>era</em>). Edit a list
            once — every template using it updates. Tags drive coherence: two options tagged on the same dimension with
            no shared tag can&rsquo;t be rolled or picked together. Leave an option untagged to keep it always compatible.
          </p>
          <p>
            <strong>Dimensions</strong> are coherence axes. Add mutually-exclusive tags (e.g. ancient · medieval ·
            modern · future), then tag your Variable-list options with them. Two options tagged on the same dimension
            that share no tag can never be rolled — or picked — together. Untagged = always compatible.
          </p>
          <p>
            <strong>Composer → Templates picker</strong>: roll each axis within the constraints; click a value to pin
            it; incompatible options disable with the reason. The resolved text fills the prompt box — edit freely
            before Generate.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
