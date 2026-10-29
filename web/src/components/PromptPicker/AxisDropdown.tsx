import type { VariableList } from '@atelier/shared';
import type { AxisEvaluation } from '../../lib/promptResolver';
import type { Ref, RefObject } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { isTouchViewport, useIsPromptPickerSheet } from '../../hooks/useIsPhone';
import { useModalToastHost } from '../../hooks/useModalChrome';
import { useAnchoredPopover } from '../../hooks/useNativeAnchor';
import { useNestedDialogEscape } from '../../hooks/useNestedDialogEscape';
import { useOutsidePointer } from '../../hooks/useOutsidePointer';
import { useRovingTabIndex } from '../../hooks/useRovingTabIndex';
import { runWhenReachable } from '../../lib/focus';
import { I } from '../icons/I';
import anchors from '../../styles/anchors.module.css';
import styles from './index.module.css';

interface AxisDropdownProps {
  open: boolean;
  onClose: () => void;
  label: string;
  anchorRef: RefObject<HTMLButtonElement | null>;
  evaluations: readonly AxisEvaluation[];
  currentPin: string | undefined;
  lists: readonly VariableList[];
  menuRootRef?: Ref<HTMLDivElement>;
  onPickRandom: () => void;
  onPickOption: (optionId: string, value: string) => void;
}

function optionLabel(lists: readonly VariableList[], listName: string, optionId: string): string {
  const list = lists.find((candidate) => candidate.name === listName);
  return list?.options.find((option) => option.id === optionId)?.value ?? optionId;
}

export default function AxisDropdown({
  open,
  onClose,
  label,
  anchorRef,
  evaluations,
  currentPin,
  lists,
  menuRootRef,
  onPickRandom,
  onPickOption,
}: AxisDropdownProps) {
  const isSheet = useIsPromptPickerSheet();
  const titleId = useId();
  const filterId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const outsideRefs = [panelRef, anchorRef];

  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? evaluations.filter((evaluation) => evaluation.option.value.toLowerCase().includes(needle))
    : evaluations;
  const focusableEvaluations = filtered.filter((evaluation) => evaluation.admissible);
  const randomActive = currentPin === undefined;
  const activeOptionIndex = focusableEvaluations.findIndex((evaluation) => evaluation.option.id === currentPin);
  const { setRowRef: setMenuRowRef, onKeyDown: onMenuKeyDown, focusAt: focusMenuAt } = useRovingTabIndex<HTMLButtonElement>(
    1 + focusableEvaluations.length,
    randomActive || activeOptionIndex < 0 ? 0 : activeOptionIndex + 1,
  );

  // The sheet/popover branches below replace the panel node on a layout
  // switch; the key moves the trap and the toast host onto the current one.
  useFocusTrap(panelRef, { active: open, returnFocusTo: anchorRef, containerKey: isSheet });
  // A nested custom trap above the picker: feedback raised while it is open
  // must render inside it, and closing it hands the toast back to the picker
  // panel below.
  useModalToastHost({ active: open, toastHostRef: panelRef, containerKey: isSheet });
  // Sheet mode owns a backdrop that dismisses on click — see the touch rule in
  // useOutsidePointer.
  useOutsidePointer(outsideRefs, onClose, { enabled: open && !isSheet });
  useNestedDialogEscape(open, onClose);

  // Filtering is the keyboard-first path to a value, so a pointer device gets
  // the focus. A touch device does not: this input is what summons the soft
  // keyboard, which covers the very list the sheet was opened to read and
  // shifts both this sheet and the picker beneath it by its own height every
  // time it comes and goes. Keyed on touch rather than on `isSheet` — that
  // flag is geometry (it also catches a short DESKTOP window, which has no
  // soft keyboard and should keep type-to-filter). The focus trap still seats
  // focus inside the sheet either way.
  useEffect(() => {
    if (!open || isTouchViewport()) return;
    const target = filterRef.current;
    runWhenReachable(() => { target?.focus(); }, target);
    return undefined;
  }, [open]);

  // Desktop popover: a manual top-layer popover over the picker whose
  // implicit anchor is the axis trigger; CSS places it below, left edges
  // aligned, and re-resolves as filtering resizes it. It portals nothing of
  // its own and hosts the toast while open, so the top layer strands nothing
  // beneath it. Sheet mode is unanchored.
  const popoverProps = useAnchoredPopover(panelRef, anchorRef, {
    active: open && !isSheet,
    containerKey: isSheet,
    onNativeClose: onClose,
  });

  if (!open) return null;

  const panel = (
    <div
      ref={panelRef}
      data-axis-menu="true"
      className={`${styles.menuPanel} ${isSheet ? styles.menuSheet : `${styles.menuPopover} ${anchors.panel}`}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-anchor-place={isSheet ? undefined : 'below-start'}
      {...popoverProps}
      onKeyDown={(event) => {
        const isArrow = event.key === 'ArrowDown' || event.key === 'ArrowUp';
        // Local filter/roving navigation runs first; only then is the arrow
        // kept from reaching the parent picker (React bubbles through portals).
        if (isArrow && event.target === filterRef.current) {
          event.preventDefault();
          focusMenuAt(event.key === 'ArrowDown' ? 0 : focusableEvaluations.length);
        } else {
          onMenuKeyDown(event);
        }
        if (isArrow) event.stopPropagation();
      }}
    >
      <div className={styles.menuHead}>
        <span id={titleId}>{label}</span>
        <button className={styles.menuClose} type="button" tabIndex={0} aria-label="Close" data-tip="Close values" onClick={onClose}>
          <I.close />
        </button>
      </div>
      <label className="srOnly" htmlFor={filterId}>Filter {label} values</label>
      <input
        ref={filterRef}
        id={filterId}
        className={styles.menuFilter}
        placeholder="Filter values..."
        value={query}
        onChange={(event) => { setQuery(event.target.value); }}
      />
      <ul className={styles.menuList} role="list">
        <li>
          <button
            ref={setMenuRowRef(0)}
            className={`${styles.menuRow} ${randomActive ? styles.menuRowActive : ''}`}
            type="button"
            aria-pressed={randomActive}
            onClick={onPickRandom}
          >
            <I.dice />
            <span className={styles.menuName}>Random</span>
            {randomActive ? <span className={styles.menuCheck}><I.check /></span> : null}
          </button>
        </li>
        {filtered.map((evaluation) => {
          const selected = currentPin === evaluation.option.id;
          const blockedBy = evaluation.blockedBy;
          // Row 0 is Random; admissible options follow in `focusableEvaluations` order.
          const rovingIndex = evaluation.admissible ? focusableEvaluations.indexOf(evaluation) + 1 : -1;
          const reasons: string[] = [];
          if (evaluation.option.weight === 0) reasons.push('Manual only');
          if (blockedBy) {
            reasons.push(`excluded by ${blockedBy.label} = ${optionLabel(lists, blockedBy.listName, blockedBy.optionId)}`);
          }
          const reason = reasons.length > 0 ? reasons.join(' · ') : null;
          return (
            <li key={evaluation.option.id}>
              <button
                ref={rovingIndex < 0 ? undefined : setMenuRowRef(rovingIndex)}
                className={`${styles.menuRow} ${selected ? styles.menuRowActive : ''}`}
                type="button"
                aria-pressed={selected}
                aria-disabled={!evaluation.admissible}
                disabled={!evaluation.admissible}
                onClick={() => {
                  if (!evaluation.admissible) return;
                  onPickOption(evaluation.option.id, evaluation.option.value);
                }}
              >
                <span className={styles.menuName}>{evaluation.option.value}</span>
                {reason ? <span className={styles.menuReason}>{reason}</span> : null}
                {selected ? <span className={styles.menuCheck}><I.check /></span> : null}
              </button>
            </li>
          );
        })}
        {filtered.length === 0 ? <li className={styles.menuEmpty}>No matching values</li> : null}
      </ul>
    </div>
  );

  return createPortal(
    <div ref={menuRootRef} data-axis-menu-root="true" data-axis-menu="true">
      {isSheet ? (
        <>
          <button
            data-axis-menu="true"
            className={styles.menuBackdrop}
            type="button"
            aria-label={`Close ${label} values`}
            onClick={onClose}
          />
          {panel}
        </>
      ) : panel}
    </div>,
    document.body,
  );
}
