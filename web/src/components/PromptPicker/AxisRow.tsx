import type { TagDimension, VariableList } from '@atelier/shared';
import type { Ref } from 'react';
import { useId, useRef, useState } from 'react';
import { occurrencePin, pinAt } from '../../lib/promptPins';
import { evaluateAxis, occurrenceLabel } from '../../lib/promptResolver';
import type { VarOccurrence } from '../../lib/promptResolver';
import { I } from '../icons/I';
import AxisDropdown from './AxisDropdown';
import styles from './index.module.css';

interface AxisRowProps {
  occurrence: VarOccurrence;
  occurrences: readonly VarOccurrence[];
  pins: Readonly<Record<string, string>>;
  lists: readonly VariableList[];
  dims: readonly TagDimension[];
  menuRootRef?: Ref<HTMLDivElement>;
  isSweep?: boolean;
  onToggleSweep?: (occurrenceKey: string) => void;
  sweepCount?: number;
  onPin: (occurrenceKey: string, optionId: string) => void;
  onUnpin: (occurrenceKey: string) => void;
}

function optionLabel(lists: readonly VariableList[], listName: string, optionId: string): string {
  const list = lists.find((candidate) => candidate.name === listName);
  return list?.options.find((option) => option.id === optionId)?.value ?? optionId;
}

function axisDimensions(listName: string, lists: readonly VariableList[], dims: readonly TagDimension[]): string {
  const list = lists.find((candidate) => candidate.name === listName);
  if (!list) return '';
  const touched = new Set<string>();
  for (const option of list.options) {
    for (const tagId of option.tagIds) {
      const dim = dims.find((candidate) => candidate.tags.some((tag) => tag.id === tagId));
      if (dim) touched.add(dim.name);
    }
  }
  return [...touched].join(', ');
}

export default function AxisRow({ occurrence, occurrences, pins, lists, dims, menuRootRef, isSweep, onToggleSweep, sweepCount, onPin, onUnpin }: AxisRowProps) {
  const headingId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const label = occurrenceLabel(occurrences, occurrence);
  // Every pin is checked against every option, so a closed row skips it: only
  // the open menu, or a sweep hint with no count from the picker, needs it.
  const needsEvaluations = menuOpen || (isSweep === true && sweepCount === undefined);
  const evaluations = needsEvaluations ? evaluateAxis(occurrence, occurrences, pins, lists, dims) : null;
  const optionCount = lists.find((candidate) => candidate.name === occurrence.listName)?.options.length ?? 0;
  const currentPin = occurrencePin(pins, occurrence.key, occurrence.listName);
  const dimensions = axisDimensions(occurrence.listName, lists, dims);
  const randomActive = currentPin === undefined;
  const hintCount = sweepCount
    ?? (evaluations ?? []).filter((e) => e.admissible && e.option.weight > 0).length;

  const goRandom = () => {
    // currentPin resolves dual-form (occurrence-key OR bare list-name); clear
    // whichever form(s) actually hold a pin so a bare-name pin isn't left
    // stuck after pressing Random.
    if (pinAt(pins, occurrence.key) !== undefined) onUnpin(occurrence.key);
    if (pinAt(pins, occurrence.listName) !== undefined) onUnpin(occurrence.listName);
    setLiveMessage(`${label} set to random`);
  };

  return (
    <section
      className={`${styles.axis} ${isSweep ? styles.axisSweepActive : ''}`}
      role="group"
      aria-labelledby={headingId}
    >
      <div className={styles.axisHead}>
        <h3 id={headingId}>{label}</h3>
        {dimensions && <span>{dimensions}</span>}
        <button
          type="button"
          className={styles.sweepToggle}
          data-size="22"
          aria-pressed={isSweep ?? false}
          aria-label={`Sweep this axis: ${label}`}
          data-tip="Sweep this axis"
          onClick={() => { onToggleSweep?.(occurrence.key); }}
        >
          <I.layers />
        </button>
      </div>
      <div className={styles.pillRow}>
        <button
          className={`${styles.pill} ${randomActive ? styles.pillActive : ''}`}
          type="button"
          aria-pressed={randomActive}
          onClick={goRandom}
        >
          Random
        </button>
        <button
          ref={triggerRef}
          className={styles.axisTrigger}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          aria-label={`Choose ${label} value`}
          data-selected={randomActive ? 'false' : 'true'}
          onClick={() => { setMenuOpen((value) => !value); }}
        >
          <span className={styles.axisTriggerValue} data-placeholder={randomActive ? 'true' : 'false'}>
            {randomActive ? `${optionCount} options` : optionLabel(lists, occurrence.listName, currentPin)}
          </span>
          <I.caret />
        </button>
      </div>
      {isSweep ? (
        <p className={styles.sweepHint}>
          Sweeps {hintCount} options · queues {hintCount} rolls
        </p>
      ) : null}
      {menuOpen && evaluations ? (
        <AxisDropdown
          open
          onClose={() => { setMenuOpen(false); }}
          label={label}
          anchorRef={triggerRef}
          evaluations={evaluations}
          currentPin={currentPin}
          lists={lists}
          {...(menuRootRef ? { menuRootRef } : {})}
          onPickRandom={() => {
            goRandom();
            setMenuOpen(false);
          }}
          onPickOption={(optionId, value) => {
            onPin(occurrence.key, optionId);
            setLiveMessage(`Pinned ${label} to ${value}`);
            setMenuOpen(false);
          }}
        />
      ) : null}
      <div className="srOnly" aria-live="polite" aria-atomic="true">{liveMessage}</div>
    </section>
  );
}
