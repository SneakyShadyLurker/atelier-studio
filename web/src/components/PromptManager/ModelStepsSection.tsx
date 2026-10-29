import { useState, type KeyboardEvent } from 'react';
import type { ModelStepsSetting } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import { useModelSteps, usePendingModelSteps, useSetModelSteps } from '../../hooks/useModelSteps';
import { ErrorState } from '../StateView';
import buttons from '../../styles/buttons.module.css';
import styles from './SettingsPanel.module.css';

interface StepsRowProps {
  readonly model: ModelStepsSetting;
  readonly min: number;
  readonly max: number;
  readonly saving: boolean;
  /** Resolves false when the save failed and the stored value rolled back. */
  readonly onSave: (steps: number | null) => Promise<boolean>;
}

function StepsRow({ model, min, max, saving, onSave }: StepsRowProps) {
  const current = model.steps ?? model.defaultSteps;
  const [draft, setDraft] = useState(String(current));
  // Follow a new stored value (save, reset, rollback, refetch) without
  // remounting the row: a remount mid-click would swallow Reset and drop focus.
  const [synced, setSynced] = useState(current);
  if (synced !== current) {
    setSynced(current);
    setDraft(String(current));
  }

  const save = (steps: number | null) => {
    // A fast failure can roll back before the optimistic value ever renders,
    // so the draft is reverted explicitly rather than by the sync above alone.
    void onSave(steps).then((ok) => { if (!ok) setDraft(String(current)); });
  };

  const commit = () => {
    const parsed = Number(draft);
    // Invalid or out-of-range input reverts without a request.
    if (draft.trim() === '' || !Number.isInteger(parsed) || parsed < min || parsed > max || parsed === current) {
      setDraft(String(current));
      return;
    }
    save(parsed === model.defaultSteps ? null : parsed);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur();
  };

  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <p className={styles.rowLabel}>{model.name}</p>
        <p className={styles.rowDescription}>Default {model.defaultSteps} steps</p>
      </div>
      <div className={styles.rowControl}>
        <input
          type="number"
          min={min}
          max={max}
          step={1}
          inputMode="numeric"
          className={styles.stepsInput}
          value={draft}
          aria-label={`Sampling steps for ${model.name}, ${min} to ${max}`}
          data-tuned={model.steps !== null ? 'true' : 'false'}
          disabled={saving}
          onChange={(event) => { setDraft(event.target.value); }}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className={buttons.secondary}
          aria-label={`Reset ${model.name} to ${model.defaultSteps} steps`}
          disabled={model.steps === null || saving}
          // Keep focus in the input so a pending edit is not committed by its
          // blur before Reset runs; Reset discards it.
          onMouseDown={(event) => { event.preventDefault(); }}
          onClick={() => {
            setDraft(String(model.defaultSteps));
            save(null);
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function isNonEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

export default function ModelStepsSection() {
  const settings = useModelSteps();
  const setSteps = useSetModelSteps();
  const saving = usePendingModelSteps();
  const addToast = useAtelierStore((state) => state.addToast);

  // Nothing to show until the list arrives; users without local models get none.
  if (settings.isPending) return null;
  if (settings.data === undefined) {
    return (
      <section className={styles.panel} aria-label="Model steps settings">
        <ErrorState
          message="Couldn’t load the model step settings."
          onRetry={() => { void settings.refetch(); }}
        />
      </section>
    );
  }
  const { models, min, max } = settings.data;
  // The response is not validated; a malformed one hides the section.
  if (!isNonEmptyList(models)) return null;

  return (
    <section className={styles.panel} aria-label="Model steps settings">
      <div className={styles.head} data-zone="head">
        <h2 className={styles.headTitle}>Model steps</h2>
        <p className={styles.headNote}>
          Sampling steps for each local model. More steps take longer to render. Reset returns a
          model to its default.
        </p>
      </div>
      <div className={styles.body} data-zone="body">
        {models.map((model) => (
          <StepsRow
            key={model.modelId}
            model={model}
            min={min}
            max={max}
            saving={saving.has(model.modelId)}
            // mutateAsync, not mutate's per-call onError: a second row's save
            // replaces mutate's callbacks, which silenced the first one's failure.
            onSave={(steps) => setSteps.mutateAsync({ modelId: model.modelId, steps }).then(
              () => true,
              (error: unknown) => {
                addToast(describeError(error, "Couldn't save the model steps."), 'error');
                return false;
              },
            )}
          />
        ))}
      </div>
    </section>
  );
}
