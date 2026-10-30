import type { PublicTextModel, TaskRow, TextModelsResponse, TextReasoningEffort } from '@atelier/shared';
import { TEXT_REASONING_EFFORT_LABELS, TEXT_TASK_LABELS, TEXT_TASKS } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import { usePendingTaskPicks, useSetTaskPick, useTextModels } from '../../hooks/useTextModels';
import ChipSelect, { type ChipSelectOption } from '../Composer/ChipSelect';
import { LoadingState, ErrorState } from '../StateView';
import ModelStepsSection from './ModelStepsSection';
import styles from './SettingsPanel.module.css';

// Model ids are never empty, so '' stands for "Use default".
const DEFAULT_PICK = '';
type EffortValue = 'default' | TextReasoningEffort;

// Models grouped by provider in first-appearance order; offline ones stay
// listed but dimmed, since the server refuses to save them.
function modelOptions(models: readonly PublicTextModel[], defaultName: string | undefined): readonly ChipSelectOption<string>[] {
  const byProvider = new Map<string, PublicTextModel[]>();
  for (const model of models) {
    const group = byProvider.get(model.providerName);
    if (group) group.push(model);
    else byProvider.set(model.providerName, [model]);
  }
  return [
    { value: DEFAULT_PICK, label: defaultName === undefined ? 'Use default' : `Use default · ${defaultName}` },
    ...[...byProvider].flatMap(([providerName, group]) => group.map((model) => (model.status === 'offline'
      ? { value: model.id, label: model.displayName, group: providerName, hint: 'offline', disabled: true }
      : { value: model.id, label: model.displayName, group: providerName }))),
  ];
}

function effortOptions(levels: readonly TextReasoningEffort[]): readonly ChipSelectOption<EffortValue>[] {
  return [
    { value: 'default', label: 'Default' },
    ...levels.map((value) => ({ value, label: TEXT_REASONING_EFFORT_LABELS[value] })),
  ];
}

// The model "Use default" resolves to. Without a usable pick the server's
// effective model already is the default (after its own fallbacks); otherwise
// the first listed fallback that is not offline, as the resolver skips those.
function defaultModelId(data: TextModelsResponse, row: TaskRow, byId: ReadonlyMap<string, PublicTextModel>): string | undefined {
  const configured = [data.defaults.byTask[row.task], data.defaults.default].find((id) => {
    const model = id === undefined ? undefined : byId.get(id);
    return model !== undefined && model.status !== 'offline';
  });
  return row.pick === undefined || row.pickState === 'offline' ? row.effectiveModelId ?? configured : configured;
}

function TextModelsSection() {
  const settings = useTextModels();
  const setPick = useSetTaskPick();
  const saving = usePendingTaskPicks();
  const addToast = useAtelierStore((state) => state.addToast);

  if (settings.isPending) return <LoadingState label="Loading settings…" />;
  // A failed background refetch keeps the last data; only a panel with none
  // falls back to the error state.
  if (settings.data === undefined) {
    return (
      <ErrorState
        message="Couldn’t load the text model settings."
        onRetry={() => { void settings.refetch(); }}
      />
    );
  }

  const data = settings.data;
  const byId = new Map(data.models.map((model) => [model.id, model]));
  // Rows come from the shared task list, so every task shows even when the
  // response omits one, and a task this bundle does not know is skipped.
  const rowByTask = new Map(data.tasks.map((row) => [row.task, row]));

  return (
    <section className={styles.panel} aria-label="Prompt library text model settings">
      <div className={styles.head} data-zone="head">
        <h2 className={styles.headTitle}>Text models</h2>
        <p className={styles.headNote}>
          Pick which model writes for each feature. Default uses what your admin set.
        </p>
      </div>
      <div className={styles.body} data-zone="body">
        {TEXT_TASKS.map((task) => {
          const row: TaskRow = rowByTask.get(task) ?? { task };
          const label = TEXT_TASK_LABELS[row.task];
          const defaultId = defaultModelId(data, row, byId);
          const defaultName = defaultId === undefined ? undefined : byId.get(defaultId)?.displayName;
          // A pick the response does not list shows as the default instead of breaking the panel.
          const picked = row.pick === undefined ? undefined : byId.get(row.pick);
          const offlinePick = picked !== undefined && row.pickState === 'offline';
          // An effort belongs to a pick the task actually uses; the default keeps its own.
          const activePick = picked !== undefined && !offlinePick ? picked : undefined;
          const display = picked !== undefined
            ? picked.displayName
            : defaultName === undefined ? 'Default' : `Default · ${defaultName}`;
          // Only an effort the picked model still offers is in use.
          const effort: EffortValue = activePick !== undefined && row.effort !== undefined && activePick.reasoningLevels.includes(row.effort)
            ? row.effort
            : 'default';
          const effortDisplay = effort === 'default'
            ? 'Default effort'
            : `${TEXT_REASONING_EFFORT_LABELS[effort]} effort`;
          const rowSaving = saving.has(row.task);
          return (
            <div key={row.task} className={styles.row}>
              <div className={styles.rowMain}>
                <p className={styles.rowLabel}>{label}</p>
                {offlinePick && (
                  <p className={styles.rowNote}>
                    {`${picked.displayName} is offline right now; ${label} is using the default.`}
                  </p>
                )}
              </div>
              <div className={styles.rowControl}>
                <ChipSelect<string>
                  ariaLabel={`Text model for ${label}, currently ${display}`}
                  valueDisplay={display}
                  options={modelOptions(data.models, defaultName)}
                  value={picked?.id ?? DEFAULT_PICK}
                  disabled={rowSaving}
                  onChange={(next) => {
                    // ChipSelect still reports dimmed rows; an offline model is not selectable.
                    if (next !== DEFAULT_PICK && byId.get(next)?.status === 'offline') return;
                    // mutateAsync: a second row's mutate() replaces per-call callbacks,
                    // which silenced the first save's failure toast.
                    setPick.mutateAsync({ task: row.task, modelId: next === DEFAULT_PICK ? null : next })
                      .catch((error: unknown) => {
                        addToast(describeError(error, "Couldn't save the text model."), 'error');
                      });
                  }}
                />
                {activePick?.reasoningLevels.length === 0 ? (
                  <p className={styles.effortFixed}>Effort fixed by the model</p>
                ) : (
                  <ChipSelect<EffortValue>
                    ariaLabel={`Reasoning effort for ${label}, currently ${effortDisplay}`}
                    valueDisplay={effortDisplay}
                    options={activePick === undefined ? [{ value: 'default', label: 'Default' }] : effortOptions(activePick.reasoningLevels)}
                    value={effort}
                    disabled={activePick === undefined || rowSaving}
                    {...(activePick === undefined ? { tip: 'Pick a model to choose its reasoning effort' } : {})}
                    onChange={(next) => {
                      if (activePick === undefined) return;
                      setPick.mutateAsync({ task: row.task, modelId: activePick.id, effort: next === 'default' ? null : next })
                        .catch((error: unknown) => {
                          addToast(describeError(error, "Couldn't save the reasoning effort."), 'error');
                        });
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Each section owns its own loading and error state.
export default function SettingsPanel() {
  return (
    <div className={styles.stack}>
      <TextModelsSection />
      <ModelStepsSection />
    </div>
  );
}
