import type { Batch } from '@atelier/shared';
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
import { I } from '../icons/I';
import { sequenceActionAvailability } from '../../lib/videoSequences';
import anchors from '../../styles/anchors.module.css';
import styles from './index.module.css';

export type BatchOverflowAction =
  | 'reroll' | 'reopen' | 'copy' | 'saveTemplate' | 'pin' | 'move'
  | 'playMaster' | 'downloadMaster' | 'extendSequence' | 'discardSequenceTail' | 'cancelStory';

interface BatchOverflowMenuProps {
  batch: Batch;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  promptsEnabled: boolean;
  readOnlyActions: boolean;
  i2vAvailable?: boolean;
  onSelect: (action: BatchOverflowAction) => void;
  onClose: () => void;
}

type GroupKey = 'generate' | 'sequence' | 'prompt' | 'organize';

interface MenuItem {
  action: BatchOverflowAction;
  label: string;
  icon: ReactNode;
  group: GroupKey;
  show: boolean;
  disabled: boolean;
  chevron?: boolean;
  danger?: boolean;
}

const GROUP_ORDER: readonly { key: GroupKey; label: string }[] = [
  { key: 'generate', label: 'Generate' },
  { key: 'sequence', label: 'Sequence' },
  { key: 'prompt', label: 'Prompt' },
  { key: 'organize', label: 'Organize' },
];

export default function BatchOverflowMenu({
  batch, anchorRef, open, promptsEnabled, readOnlyActions, i2vAvailable = false, onSelect, onClose,
}: BatchOverflowMenuProps) {
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

  const hasTemplate = batch.provenance != null && batch.provenance.templateId !== null;
  const sequenceActions = sequenceActionAvailability(batch, i2vAvailable);

  const items: readonly MenuItem[] = [
    { action: 'reroll', label: 'Re-roll', icon: <I.reroll />, group: 'generate', show: true, disabled: readOnlyActions },
    // The picker only exists behind the prompt-library gate, like Save below.
    { action: 'reopen', label: 'Reopen in picker', icon: <I.sparkle />, group: 'generate', show: hasTemplate && promptsEnabled, disabled: readOnlyActions },
    { action: 'playMaster', label: 'Play master', icon: <I.play />, group: 'sequence', show: sequenceActions.playMaster, disabled: false },
    { action: 'downloadMaster', label: 'Download master', icon: <I.download />, group: 'sequence', show: sequenceActions.downloadMaster, disabled: false },
    { action: 'extendSequence', label: 'Extend', icon: <I.extend />, group: 'sequence', show: sequenceActions.extend, disabled: readOnlyActions },
    { action: 'discardSequenceTail', label: 'Discard tail', icon: <I.trash />, group: 'sequence', show: sequenceActions.discardTail, disabled: readOnlyActions, danger: true },
    { action: 'cancelStory', label: 'Cancel story', icon: <I.close />, group: 'sequence', show: batch.story?.status === 'rendering', disabled: readOnlyActions, danger: true },
    { action: 'copy', label: 'Copy prompt', icon: <I.copy />, group: 'prompt', show: true, disabled: false },
    { action: 'saveTemplate', label: 'Save to templates', icon: <I.library />, group: 'prompt', show: promptsEnabled, disabled: readOnlyActions },
    { action: 'pin', label: 'Pin batch', icon: <I.star />, group: 'organize', show: !batch.pinned, disabled: readOnlyActions },
    { action: 'move', label: 'Move to collection', icon: <I.folderPlus />, group: 'organize', show: true, disabled: readOnlyActions, chevron: true },
  ];

  const groups = GROUP_ORDER
    .map((group) => ({ ...group, items: items.filter((item) => item.group === group.key && item.show) }))
    .filter((group) => group.items.length > 0);

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
      aria-label="Batch actions"
      data-mobile={isPhone ? 'true' : 'false'}
      data-anchor-place={isPhone ? undefined : 'below-end'}
      {...popoverProps}
      onKeyDown={onMenuKeyDown}
    >
      <div className={styles.content} data-overlay-scroll="true">
      {groups.map((group, groupIndex) => (
        <div key={group.key} role="none">
          <div className={styles.groupLabel}>{group.label}</div>
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
