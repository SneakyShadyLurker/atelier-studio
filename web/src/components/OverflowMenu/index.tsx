import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { focusableInside, useFocusTrap } from '../../hooks/useFocusTrap';
import { useIsPhone } from '../../hooks/useIsPhone';
import { useModalChrome } from '../../hooks/useModalChrome';
import { useAnchoredPopover } from '../../hooks/useNativeAnchor';
import { useOutsidePointer } from '../../hooks/useOutsidePointer';
import { useExitTransition } from '../../hooks/useExitTransition';
import { focusRovingItem, runWhenReachable } from '../../lib/focus';
import anchors from '../../styles/anchors.module.css';
import styles from './index.module.css';

export interface OverflowMenuItem<TAction extends string> {
  readonly action: TAction;
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  /** The row opens a follow-up surface (e.g. Move). */
  readonly chevron?: boolean;
}

export interface OverflowMenuGroup<TAction extends string> {
  readonly key: string;
  /** Omitted for a single unlabelled group. */
  readonly label?: string;
  readonly items: readonly OverflowMenuItem<TAction>[];
}

interface OverflowMenuProps<TAction extends string> {
  /** Accessible name of the menu, e.g. "Batch actions". */
  readonly label: string;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly open: boolean;
  /** Non-empty groups, in display order. */
  readonly groups: readonly OverflowMenuGroup<TAction>[];
  readonly onSelect: (action: TAction) => void;
  readonly onClose: () => void;
}

/**
 * The More (⋯) action menu: an anchored `role=menu` popover on desktop, a
 * sheet with a backdrop on phone, grouped rows and roving Arrow/Home/End.
 * Owners supply the items; the grammar lives here once.
 */
export default function OverflowMenu<TAction extends string>({
  label, anchorRef, open, groups, onSelect, onClose,
}: OverflowMenuProps<TAction>) {
  const isPhone = useIsPhone();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const portalRootRef = useRef<HTMLDivElement | null>(null);
  // Dismissals (Esc, outside pointer, backdrop) play the shared exit; item
  // selection stays parent-driven and instant.
  const { closing, requestClose } = useExitTransition(onClose, open);

  // Toasts render inside the trapped panel; the phone/desktop branches below
  // replace that node, so both follow the key.
  useModalChrome({ open, onCancel: requestClose, portalRef: portalRootRef, toastHostRef: panelRef, containerKey: isPhone });
  useFocusTrap(panelRef, { active: open, returnFocusTo: anchorRef, containerKey: isPhone });
  // Phone renders a backdrop that dismisses on click — see the touch rule in
  // useOutsidePointer.
  useOutsidePointer([panelRef, anchorRef], requestClose, { enabled: open && !isPhone });

  // Desktop popover: a top-layer popover whose implicit anchor is the
  // trigger; CSS places it below, right edges aligned
  // (styles/anchors.module.css). Toasts raised meanwhile render inside it, so
  // the top layer covers nothing they need. The phone sheet is unanchored.
  const popoverProps = useAnchoredPopover(panelRef, anchorRef, {
    active: open && !isPhone,
    containerKey: isPhone,
    onNativeClose: requestClose,
  });

  useEffect(() => {
    if (!open) return;
    const target = focusableInside(panelRef.current)[0] ?? null;
    runWhenReachable(() => { target?.focus(); }, target);
  }, [open]);

  // Roving Arrow/Home/End navigation so the role="menu" honors the ARIA menu
  // keyboard contract (Tab still cycles via the focus trap; Esc closes).
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    focusRovingItem(event, panelRef.current, '[role="menuitem"]');
  };

  if (!open) return null;

  const panel = (
    <div
      ref={panelRef}
      className={`${styles.panel} ${isPhone ? styles.sheet : `${styles.popover} ${anchors.panel}`}`}
      data-closing={closing ? 'true' : undefined}
      role="menu"
      aria-label={label}
      data-mobile={isPhone ? 'true' : 'false'}
      data-anchor-place={isPhone ? undefined : 'below-end'}
      {...popoverProps}
      onKeyDown={onMenuKeyDown}
    >
      <div className={styles.content} data-overlay-scroll="true">
      {groups.map((group, groupIndex) => (
        <div key={group.key} role="none">
          {group.label !== undefined && <div className={styles.groupLabel}>{group.label}</div>}
          {group.items.map((item) => (
            <button
              key={item.action}
              type="button"
              role="menuitem"
              tabIndex={0}
              className={styles.row}
              data-danger={item.danger ? 'true' : undefined}
              disabled={item.disabled}
              onClick={() => {
                // A dismissed menu keeps focus on its row through the exit
                // fade; Escape then Enter must not fire the action.
                if (closing) return;
                onSelect(item.action);
              }}
            >
              <span className={styles.icon} aria-hidden="true">{item.icon}</span>
              <span className={styles.name}>{item.label}</span>
              {item.chevron ? <span className={styles.chevron} aria-hidden="true">›</span> : null}
            </button>
          ))}
          {groupIndex < groups.length - 1 ? <div className={styles.divider} /> : null}
        </div>
      ))}
      </div>
    </div>
  );

  return createPortal(
    <div ref={portalRootRef} className={styles.portalRoot}>
      {isPhone ? (
        <>
          <button className={styles.backdrop} type="button" aria-label="Close menu" data-closing={closing ? 'true' : undefined} onClick={requestClose} />
          {panel}
        </>
      ) : panel}
    </div>,
    document.body,
  );
}
