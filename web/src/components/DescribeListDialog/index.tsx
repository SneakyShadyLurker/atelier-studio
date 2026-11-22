import { useId } from 'react';
import { LIST_DESCRIPTION_MAX_CHARS } from '@atelier/shared/prompt-limits';
import type { TaskModelChoice } from '../../hooks/useTaskModelChoice';
import type { ListReviewMode } from '../PromptManager/listReview';
import { DescribeDialog } from '../DescribeDialog';
import { ModelFields } from '../DescribeDialog/ModelFields';
import styles from './index.module.css';

export type DescribeListDialogMode = 'create' | 'seed' | 'populated' | 'clarify';

interface DescribeListDialogProps {
  /** `create` a new list, `seed` an empty one, Add or Rework on a `populated` one, or answer a `clarify` question. */
  mode: DescribeListDialogMode;
  question?: string | null;
  /** The populated dialog's chip: Add options or Rework. */
  choice?: ListReviewMode;
  onChoice?: (choice: ListReviewMode) => void;
  /** The list is at its option limit: Add options is off (R4.1). */
  full?: boolean;
  busy: boolean;
  error?: string | null;
  /** A neutral note about the last answer (it changed nothing). */
  notice?: string | null;
  /** The field's starting text ("Rework again" passes the last instructions). */
  initialText?: string;
  /** The text model and reasoning level that write the draft (every mode but clarify). */
  modelChoice?: TaskModelChoice;
  onSubmit: (description: string) => void;
  onCancel: () => void;
}

const SEED_BODY = 'Say what this list should hold. The options fill the list for you to edit, reorder or delete, and nothing is saved until you press Save list.';
const CREATE_BODY = 'Say what the list should vary and how many options you want. The AI names the list and writes its options, which stay unsaved until you press Save list.';
const ADD_BODY = 'The AI adds options in the vein of the ones you have. Say what to add, or leave this blank for more of the same. You review each one before it is applied.';
const REWORK_BODY = "Say what should change: rewrite, remove, reweight or add options. You review each change before it is applied, and options you don't mention stay as they are.";

const CHOICES: readonly { readonly value: ListReviewMode; readonly label: string }[] = [
  { value: 'extend', label: 'Add options' },
  { value: 'rework', label: 'Rework' },
];

export default function DescribeListDialog({
  mode,
  question = null,
  choice = 'extend',
  onChoice,
  full = false,
  busy,
  error = null,
  notice = null,
  initialText,
  modelChoice,
  onSubmit,
  onCancel,
}: DescribeListDialogProps) {
  const groupId = useId();
  const fields = modelChoice !== undefined && mode !== 'clarify'
    ? <ModelFields choice={modelChoice} disabled={busy} />
    : null;
  const shared = {
    maxLength: LIST_DESCRIPTION_MAX_CHARS,
    busy,
    error,
    notice,
    ...(initialText !== undefined ? { initialText } : {}),
    onSubmit,
    onCancel,
  };

  if (mode === 'populated') {
    const adding = choice === 'extend';
    return (
      <DescribeDialog
        title={adding ? 'Add to the list' : 'Rework the list'}
        body={adding ? ADD_BODY : REWORK_BODY}
        fieldLabel={adding ? 'What to add' : 'Change instructions'}
        placeholder={adding ? 'e.g. 15 more, leaning toward winter' : 'e.g. shorten every option and drop the near-duplicates'}
        submitLabel={adding ? 'Add options' : 'Rework list'}
        {...(adding ? {} : { busyLabel: 'Reworking…' })}
        optional={adding}
        // Switching chips keeps the typed text (R4.2).
        resetKey="populated"
        {...shared}
      >
        <fieldset className={styles.choiceGroup} disabled={busy}>
          <legend className="srOnly">Draft mode</legend>
          <div className={styles.choices}>
            {CHOICES.map((option) => (
              <label key={option.value} className={styles.choice}>
                <input
                  type="radio"
                  name={`${groupId}-mode`}
                  className={styles.choiceInput}
                  checked={choice === option.value}
                  disabled={option.value === 'extend' && full}
                  onChange={() => { onChoice?.(option.value); }}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          {full && <p className={styles.note}>This list is at its option limit, so there is no room to add.</p>}
        </fieldset>
        {fields}
      </DescribeDialog>
    );
  }
  if (mode === 'clarify') {
    return (
      <DescribeDialog
        title="One more thing"
        body={question ?? ''}
        fieldLabel="List description"
        placeholder="e.g. cat breeds for a portrait template"
        submitLabel="Add options"
        {...shared}
      />
    );
  }
  const creating = mode === 'create';
  return (
    <DescribeDialog
      title={creating ? 'Describe the new list' : 'Describe the list'}
      body={creating ? CREATE_BODY : SEED_BODY}
      fieldLabel="List description"
      placeholder={creating ? 'e.g. twenty weather conditions, from clear to stormy' : 'e.g. cat breeds for a portrait template'}
      submitLabel="Draft list"
      {...shared}
    >
      {fields}
    </DescribeDialog>
  );
}
