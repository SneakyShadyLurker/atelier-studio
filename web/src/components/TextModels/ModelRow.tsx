import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AdminModel, TextModelStatus, TextModelUsage } from '@atelier/shared';
import { TEXT_REASONING_EFFORT_LABELS, TEXT_TASK_LABELS } from '@atelier/shared';
import { focusableInside, useFocusTrap } from '../../hooks/useFocusTrap';
import { useIsPhone } from '../../hooks/useIsPhone';
import { useModalChrome } from '../../hooks/useModalChrome';
import { useAnchoredPopover } from '../../hooks/useNativeAnchor';
import { useOutsidePointer } from '../../hooks/useOutsidePointer';
import { useExitTransition } from '../../hooks/useExitTransition';
import { focusRovingItem, runWhenReachable } from '../../lib/focus';
import { I } from '../icons/I';
import anchors from '../../styles/anchors.module.css';
import menu from '../BatchOverflowMenu/index.module.css';
import styles from './index.module.css';

export type ModelAction = 'edit' | 'test' | 'remove';

/** "A", "A and B", "A, B, and C". */
function joinWords(parts: readonly string[]): string {
  if (parts.length <= 2) return parts.join(' and ');
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1) ?? ''}`;
}

/** Body of the remove confirmation, from the usage the server reported. */
export function removeModelCopy(usage: TextModelUsage, imageLabel: (id: string) => string): string {
  const parts: string[] = [];
  if (usage.isDefault) parts.push('the default model');
  if (usage.tasks.length > 0) parts.push(`assigned to ${joinWords(usage.tasks.map((task) => TEXT_TASK_LABELS[task]))}`);
  if (usage.writers.length > 0) parts.push(`the prompt writer for ${joinWords(usage.writers.map(imageLabel))}`);
  if (usage.userPicks > 0) parts.push(`picked by ${usage.userPicks} ${usage.userPicks === 1 ? 'person' : 'people'}`);
  if (parts.length === 0) return 'Nothing uses it right now.';
  return `It is ${joinWords(parts)}. Those will fall back to the next model in line.`;
}

function capabilityMarks(model: AdminModel): readonly { key: string; label: string; icon: ReactNode }[] {
  const marks: { key: string; label: string; icon: ReactNode }[] = [];
  if (model.vision) marks.push({ key: 'vision', label: 'Image input', icon: <I.image /> });
  if (model.structuredOutput !== 'none') marks.push({ key: 'json', label: 'JSON output', icon: <I.braces /> });
  if (model.reasoningLevels.length > 0) {
    const levels = model.reasoningLevels.map((level) => TEXT_REASONING_EFFORT_LABELS[level]).join(', ');
    marks.push({ key: 'reasoning', label: `Reasoning: ${levels}`, icon: <I.reasoning /> });
  }
  return marks;
}

const MENU_ITEMS: readonly { action: ModelAction; label: string; icon: ReactNode; danger?: boolean }[] = [
  { action: 'edit', label: 'Edit', icon: <I.pencil /> },
  { action: 'test', label: 'Test', icon: <I.check /> },
  { action: 'remove', label: 'Remove', icon: <I.trash />, danger: true },
];

interface ModelMenuProps {
  readonly label: string;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly open: boolean;
  readonly onSelect: (action: ModelAction) => void;
  readonly onClose: () => void;
}

// Same grammar as BatchOverflowMenu (anchored popover on desktop, sheet with
// backdrop on phone, roving focus, shared shell and row styles); only the
// items differ.
function ModelMenu({ label, anchorRef, open, onSelect, onClose }: ModelMenuProps) {
  const isPhone = useIsPhone();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const portalRootRef = useRef<HTMLDivElement | null>(null);
  const { closing, requestClose } = useExitTransition(onClose, open);

  useModalChrome({ open, onCancel: requestClose, portalRef: portalRootRef, toastHostRef: panelRef, containerKey: isPhone });
  useFocusTrap(panelRef, { active: open, returnFocusTo: anchorRef, containerKey: isPhone });
  useOutsidePointer([panelRef, anchorRef], requestClose, { enabled: open && !isPhone });
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

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    focusRovingItem(event, panelRef.current, '[role="menuitem"]');
  };

  if (!open) return null;

  const panel = (
    <div
      ref={panelRef}
      className={`${menu.panel} ${isPhone ? menu.sheet : `${menu.popover} ${anchors.panel}`}`}
      data-closing={closing ? 'true' : undefined}
      role="menu"
      aria-label={`${label} actions`}
      data-mobile={isPhone ? 'true' : 'false'}
      data-anchor-place={isPhone ? undefined : 'below-end'}
      {...popoverProps}
      onKeyDown={onMenuKeyDown}
    >
      <div className={menu.content} data-overlay-scroll="true">
        {MENU_ITEMS.map((item) => (
          <button
            key={item.action}
            type="button"
            role="menuitem"
            tabIndex={0}
            className={menu.row}
            data-danger={item.danger ? 'true' : undefined}
            onClick={() => {
              if (closing) return;
              onSelect(item.action);
            }}
          >
            <span className={menu.icon} aria-hidden="true">{item.icon}</span>
            <span className={menu.name}>{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return createPortal(
    <div ref={portalRootRef} className={menu.portalRoot}>
      {isPhone ? (
        <>
          <button className={menu.backdrop} type="button" aria-label="Close menu" data-closing={closing ? 'true' : undefined} onClick={requestClose} />
          {panel}
        </>
      ) : panel}
    </div>,
    document.body,
  );
}

const STATUS_WORD: Record<TextModelStatus, string> = {
  available: 'available',
  offline: 'offline',
  unknown: 'unknown',
};

interface ModelRowProps {
  readonly model: AdminModel;
  /** The provider was added moments ago; an unknown status reads "checking…". */
  readonly checking: boolean;
  readonly toggling: boolean;
  readonly checkingAgain: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onCheckAgain: () => void;
  readonly onAction: (action: ModelAction) => void;
}

export default function ModelRow({ model, checking, toggling, checkingAgain, onToggle, onCheckAgain, onAction }: ModelRowProps) {
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const word = model.status === 'unknown' && checking ? 'checking…' : STATUS_WORD[model.status];
  const marks = capabilityMarks(model);

  return (
    <li className={styles.modelRow} aria-label={model.displayName} data-enabled={model.enabled ? 'true' : 'false'}>
      <div className={styles.modelIdentity}>
        <span className={styles.modelName}>{model.displayName}</span>
        <span className={styles.mono}>{model.modelId}</span>
      </div>
      <div className={styles.modelMeta}>
        <span className={styles.caps}>
          {marks.map((mark) => (
            <span key={mark.key} className={styles.cap} role="img" aria-label={mark.label} data-tip={mark.label}>
              {mark.icon}
            </span>
          ))}
        </span>
        <span className={styles.status} data-status={model.status}>
          <span className={styles.statusDot} aria-hidden="true" />
          <span>{word}</span>
        </span>
        {model.status !== 'available' && !checking && (
          <button className={styles.textButton} type="button" disabled={checkingAgain} onClick={onCheckAgain}>
            Check again
          </button>
        )}
      </div>
      <div className={styles.modelControls}>
        <button
          className={styles.switch}
          type="button"
          role="switch"
          aria-checked={model.enabled}
          aria-label={`Use ${model.displayName}`}
          data-tip={model.enabled ? 'On' : 'Off'}
          disabled={toggling}
          onClick={() => { onToggle(!model.enabled); }}
        >
          <span className={styles.switchThumb} aria-hidden="true" />
        </button>
        <button
          ref={moreRef}
          className={styles.iconButton}
          type="button"
          aria-label={`More actions for ${model.displayName}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-tip="More"
          onClick={() => { setMenuOpen((open) => !open); }}
        >
          <I.more />
        </button>
      </div>
      <ModelMenu
        label={model.displayName}
        anchorRef={moreRef}
        open={menuOpen}
        onClose={() => { setMenuOpen(false); }}
        onSelect={(action) => {
          setMenuOpen(false);
          onAction(action);
        }}
      />
    </li>
  );
}
