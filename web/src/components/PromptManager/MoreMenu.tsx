import { useRef, useState } from 'react';
import OverflowMenu, { type OverflowMenuItem } from '../OverflowMenu';
import { I } from '../icons/I';
import btn from '../../styles/buttons.module.css';

interface MoreMenuProps<TAction extends string> {
  /** Accessible name of the More (⋯) trigger, e.g. "More actions for mood". */
  readonly triggerLabel: string;
  /** Accessible name of the menu itself. */
  readonly menuLabel: string;
  readonly items: readonly OverflowMenuItem<TAction>[];
  readonly onSelect: (action: TAction) => void;
}

// The phone editors' More (⋯): secondary actions of an editor head or an
// option row collapse here so the editable body keeps the space. The menu
// grammar (popover / sheet, roving keys, Escape) is OverflowMenu's.
export default function MoreMenu<TAction extends string>({ triggerLabel, menuLabel, items, onSelect }: MoreMenuProps<TAction>) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  // A menu of only disabled rows has nothing to take focus once the app is
  // inerted, so the trigger waits until some action is available (a running
  // save or draft disables every row) and an open menu closes with it.
  const actionable = items.some((item) => !item.disabled);
  if (open && !actionable) setOpen(false);
  return (
    <>
      <button
        ref={triggerRef}
        className={btn.icon}
        type="button"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip="More"
        disabled={!actionable}
        onClick={() => { setOpen((current) => !current); }}
      >
        <I.more />
      </button>
      <OverflowMenu
        label={menuLabel}
        anchorRef={triggerRef}
        open={open}
        groups={[{ key: 'actions', items }]}
        onClose={() => { setOpen(false); }}
        onSelect={(action) => {
          setOpen(false);
          onSelect(action);
        }}
      />
    </>
  );
}
