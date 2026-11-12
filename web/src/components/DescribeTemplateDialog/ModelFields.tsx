import { useId } from 'react';
import type { TaskModelChoice } from '../../hooks/useTaskModelChoice';
import { DEFAULT_PICK, defaultPickLabel, effortOptions, type EffortValue } from '../../lib/textModelPick';
import { I } from '../icons/I';
import styles from './ModelFields.module.css';

interface ModelFieldsProps {
  choice: TaskModelChoice;
  /** The draft request is in flight. */
  disabled: boolean;
}

// The text model and reasoning level that write the draft: two native selects,
// because a portalled menu would sit inert under the modal <dialog>'s top layer.
export function ModelFields({ choice, disabled }: ModelFieldsProps) {
  const id = useId();
  const { state } = choice;

  if (state.kind === 'locked') {
    return (
      <div className={styles.lockedRow}>
        <p className={styles.locked}>{`Prompts for this image model are always written by ${state.writerName}.`}</p>
      </div>
    );
  }

  const unavailable = state.kind === 'unavailable';
  const levels = choice.effortLevels;
  const effortFixed = levels !== null && levels.length === 0;

  return (
    <div className={styles.row}>
      <div className={styles.cell}>
        <label htmlFor={`${id}-model`} className={styles.label}>Model</label>
        <span className={styles.selectWrap}>
          <select
            id={`${id}-model`}
            className={styles.select}
            value={unavailable ? DEFAULT_PICK : choice.modelId}
            disabled={disabled || unavailable}
            onChange={(event) => { choice.setModelId(event.currentTarget.value); }}
          >
            <option value={DEFAULT_PICK}>{defaultPickLabel(unavailable ? undefined : choice.defaultName)}</option>
            {choice.groups.map((group) => (
              <optgroup key={group.providerName} label={group.providerName}>
                {group.models.map((model) => (
                  <option key={model.id} value={model.id} disabled={model.status === 'offline'}>
                    {model.status === 'offline' ? `${model.displayName} (offline)` : model.displayName}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <I.caret className={styles.caret} />
        </span>
      </div>
      <div className={`${styles.cell} ${styles.effortCell}`}>
        <label htmlFor={`${id}-effort`} className={styles.label}>Reasoning</label>
        <span className={styles.selectWrap}>
          <select
            id={`${id}-effort`}
            className={styles.select}
            value={choice.effort}
            disabled={disabled || levels === null || effortFixed}
            onChange={(event) => { choice.setEffort(event.currentTarget.value as EffortValue); }}
          >
            {effortFixed
              ? <option value="default">Fixed by the model</option>
              : effortOptions(levels ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <I.caret className={styles.caret} />
        </span>
      </div>
    </div>
  );
}
