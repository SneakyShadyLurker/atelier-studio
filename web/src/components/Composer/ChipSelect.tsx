import type { CSSProperties, ReactNode, Ref } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOutsidePointer } from '../../hooks/useOutsidePointer';
import { useExitTransition } from '../../hooks/useExitTransition';
import { useIsPhone } from '../../hooks/useIsPhone';
import { useKeyboardScopeActive, useKeyboardScoped } from '../../hooks/useKeyboard';
import { I } from '../icons/I';
import anchors from '../../styles/anchors.module.css';
import styles from './index.module.css';

export interface ChipSelectOption<TValue extends string | number> {
  value: TValue;
  label: string;
  hint?: string;
  group?: string;
  // Override the rendered header for the group. Defaults to `group` when omitted;
  // pass '' to keep the divider but suppress the header text.
  groupLabel?: string;
  title?: string;
  // Visually dimmed and excluded from the selected check, but still clickable.
  // Use for rows that surface an alternate action via onChange (e.g. BYOK gating
  // rows whose handler opens a dialog instead of switching selection).
  disabled?: boolean;
  // Visually dimmed like a disabled row, but semantically enabled because
  // selecting it performs a real alternate action.
  actionable?: boolean;
  // Alternate actions may keep the listbox mounted to show their in-place
  // pending and terminal state.
  keepOpenOnSelect?: boolean;
}

interface ChipSelectProps<TValue extends string | number> {
  ariaLabel: string;
  valueDisplay: ReactNode;
  valueTitle?: string;
  iconLeft?: ReactNode;
  options: readonly ChipSelectOption<TValue>[];
  value: TValue;
  disabled?: boolean;
  /**
   * Tooltip text rendered as `data-tip` on the chip trigger. Use to explain
   * *why* the chip is in its current state — particularly important when
   * `disabled` is true so the user understands what's locking the value
   * (e.g. "Local generation runs one tile at a time"). Surfaces via the
   * project's standard `[data-tip]` hover affordance.
   */
  tip?: string;
  /**
   * Attached to the portaled menu container so a parent popover can include it
   * in its outside-pointer exclusion list. Without this, a parent that dismisses
   * on outside pointerdown (e.g. PromptPicker) closes itself when the user clicks
   * a menu option, because the option lives in a body-level portal outside the
   * parent panel. Mirrors AxisDropdown's menuRootRef.
   */
  menuRootRef?: Ref<HTMLDivElement>;
  onChange: (value: TValue) => void;
}

// Single-select listbox keyboard contract: arrows move active-descendant,
// Enter and Space both commit the active option (ARIA listbox APG — there is
// no typeahead here, so Space is a selection key, not a passthrough).
export default function ChipSelect<TValue extends string | number>({
  ariaLabel,
  valueDisplay,
  valueTitle,
  iconLeft,
  options,
  value,
  disabled = false,
  tip,
  menuRootRef,
  onChange,
}: ChipSelectProps<TValue>) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  // Menu dismissals play the shared exit before the listbox unmounts.
  const { closing, requestClose, cancelClose } = useExitTransition(() => { setOpen(false); }, open);
  const [activeIdx, setActiveIdx] = useState(() =>
    Math.max(0, options.findIndex((opt) => opt.value === value)),
  );
  // Suppress mouse hover claiming activeDescendant after keyboard navigation
  // until the user actively moves the cursor. WAI-ARIA combobox APG pattern —
  // without this, a stationary cursor over a row hijacks the next ↑/↓ press.
  const suppressHoverRef = useRef(false);
  const isPhone = useIsPhone();
  const reactId = useId();
  const listboxId = `${reactId}-list`;
  // Desktop menu: CSS anchors it above the chip (below when it does not fit),
  // at least as wide as the chip, scrolling within the free side when it fits
  // neither (styles/anchors.module.css). The phone sheet is unanchored.
  // A name, not the top layer: the menu stays in the page's z-index order
  // under the global toast stack, whose Undo it must never cover. The name is
  // this instance's own id, declared on both ends, so repeated chips cannot
  // cross-bind.
  const anchor = { '--named-anchor': `--chip-${reactId.replace(/[^\w-]/g, '')}` } as CSSProperties;
  // Closes over activeIdx / options / onChange directly: useKeyboardScoped
  // already keeps its own latest-handler ref, so mirroring them into local refs
  // here was a second copy of the same mechanism.
  const handleMenuKey = (event: KeyboardEvent) => {
    const opts = options;
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
      triggerRef.current?.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      suppressHoverRef.current = true;
      setActiveIdx((i) => (opts.length === 0 ? i : (i + 1) % opts.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      suppressHoverRef.current = true;
      setActiveIdx((i) => (opts.length === 0 ? i : (i - 1 + opts.length) % opts.length));
    } else if (event.key === 'Home') {
      event.preventDefault();
      suppressHoverRef.current = true;
      setActiveIdx(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      suppressHoverRef.current = true;
      setActiveIdx(opts.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const opt = opts[activeIdx];
      if (opt) {
        onChange(opt.value);
        if (opt.keepOpenOnSelect !== true) {
          requestClose();
          triggerRef.current?.focus();
        }
      }
    } else if (event.key === 'Tab') {
      triggerRef.current?.focus();
      requestClose();
    }
  };

  // Scope drops during the exit fade so Enter/Space can't re-activate an
  // option on a menu the user already dismissed.
  const menuLive = open && !closing;
  useKeyboardScopeActive('chipselect-open', menuLive);
  useKeyboardScoped('chipselect-open', 'Escape', handleMenuKey, menuLive);
  useKeyboardScoped('chipselect-open', 'ArrowDown', handleMenuKey, menuLive);
  useKeyboardScoped('chipselect-open', 'ArrowUp', handleMenuKey, menuLive);
  useKeyboardScoped('chipselect-open', 'Home', handleMenuKey, menuLive);
  useKeyboardScoped('chipselect-open', 'End', handleMenuKey, menuLive);
  useKeyboardScoped('chipselect-open', 'Enter', handleMenuKey, menuLive);
  useKeyboardScoped('chipselect-open', ' ', handleMenuKey, menuLive);
  useKeyboardScoped('chipselect-open', 'Tab', handleMenuKey, menuLive);

  const groups: { key: string | undefined; header: string | undefined; opts: ChipSelectOption<TValue>[] }[] = [];
  for (const opt of options) {
    const last = groups[groups.length - 1];
    if (last && last.key === opt.group) {
      last.opts.push(opt);
    } else {
      const header = opt.groupLabel ?? opt.group;
      groups.push({ key: opt.group, header, opts: [opt] });
    }
  }

  const close = requestClose;
  const outsideRefs = [menuRef, triggerRef];

  // Desktop: dismiss on any outside pointerdown (non-modal popover). Phone: the
  // bottom-sheet is modal and owns a full-screen backdrop that closes on CLICK.
  // Outside-pointer dismissal MUST stay off on phone — it fires on pointerdown,
  // which would close the sheet (unmounting the backdrop) before the click
  // lands, letting that click fall through to the composer scrim and collapse
  // the whole composer. The backdrop is the phone dismissal path.
  useOutsidePointer(outsideRefs, close, { enabled: open && !isPhone });

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  const activeOptionId = options[activeIdx] ? `${reactId}-opt-${String(options[activeIdx].value)}` : undefined;

  useEffect(() => {
    if (!open || !activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionId, open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.chip}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        data-tip={tip}
        style={anchor}
        onClick={() => {
          if (disabled) return;
          if (closing) {
            // Mid-fade re-toggle: abort the exit and snap the menu back
            // instead of swallowing the click.
            cancelClose();
          } else if (open) {
            close();
          } else {
            const idx = options.findIndex((opt) => opt.value === value);
            setActiveIdx(idx >= 0 ? idx : 0);
            setOpen(true);
          }
        }}
      >
        {iconLeft}
        <span className={styles.chipVal} data-tip={valueTitle}>
          {valueDisplay}
        </span>
        <I.caret className={styles.chipCaret} />
      </button>
      {open && createPortal(
        <div ref={menuRootRef} data-chip-menu-root="true">
        {isPhone && (
          // Bottom-sheet backdrop: phone only. The sheet is modal, so an
          // outside tap must be consumed here (close the sheet) instead of
          // falling through to the full-screen composer scrim, whose onClick
          // would otherwise collapse the entire composer on the same tap.
          // Desktop stays non-modal — dismissal is handled by useOutsidePointer
          // so clicks can still land on the page behind the menu.
          <button
            type="button"
            className={styles.menuBackdrop}
            data-closing={closing ? 'true' : undefined}
            data-testid="chipselect-backdrop"
            aria-label={`Close ${ariaLabel} menu`}
            onClick={close}
          />
        )}
        <div
          ref={menuRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={activeOptionId}
          tabIndex={-1}
          className={isPhone ? styles.menu : `${styles.menu} ${anchors.panel}`}
          data-closing={closing ? 'true' : undefined}
          data-anchor-place={isPhone ? undefined : 'above-start'}
          data-anchor-width={isPhone ? undefined : 'trigger'}
          data-anchored={isPhone ? undefined : 'name'}
          style={isPhone ? undefined : anchor}
        >
          {groups.map((group, groupIdx) => (
            <div key={group.key ?? `group-${String(groupIdx)}`} className={styles.menuGroup}>
              {group.header && <div className={styles.menuGroupHeader}>{group.header}</div>}
              {group.opts.map((opt) => {
                const flatIdx = options.indexOf(opt);
                const selected = !opt.disabled && opt.value === value;
                const active = flatIdx === activeIdx;
                const dimmed = opt.disabled === true || opt.actionable === true;
                const optionClass = [
                  styles.menuOption,
                  active ? styles.menuOptionActive : '',
                  selected ? styles.menuOptionSelected : '',
                  dimmed ? styles.menuOptionDisabled : '',
                ].filter(Boolean).join(' ');
                return (
                  <div
                    key={String(opt.value)}
                    id={`${reactId}-opt-${String(opt.value)}`}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={opt.disabled ? true : undefined}
                    aria-label={opt.actionable === true
                      ? `${opt.label} — ${opt.hint ?? 'action available'}`
                      : undefined}
                    data-dimmed={dimmed ? 'true' : undefined}
                    data-tip={opt.title}
                    className={optionClass}
                    onMouseEnter={() => {
                      if (suppressHoverRef.current) return;
                      setActiveIdx(flatIdx);
                    }}
                    onMouseMove={() => {
                      suppressHoverRef.current = false;
                      setActiveIdx(flatIdx);
                    }}
                    onClick={() => {
                      onChange(opt.value);
                      if (opt.keepOpenOnSelect !== true) {
                        close();
                        triggerRef.current?.focus();
                      }
                    }}
                  >
                    <span className={styles.menuOptionLabel}>{opt.label}</span>
                    {opt.hint && <span className={styles.menuOptionHint}>{opt.hint}</span>}
                    {selected && <I.check className={styles.menuOptionCheck} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        </div>,
        document.body,
      )}
    </>
  );
}
