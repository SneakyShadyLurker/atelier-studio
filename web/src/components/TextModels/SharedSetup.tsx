import type { AdminModel, AdminProvider, TextReasoningEffort, TextTask, TextWriterMode, TextWriterPutRequest } from '@atelier/shared';
import { TEXT_TASK_DESCRIPTIONS, TEXT_TASK_GROUPS, TEXT_TASK_LABELS, TEXT_TASKS } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import {
  EFFORT_FIXED_LABEL,
  NO_DEFAULT_LABEL,
  NO_WRITER_LABEL,
  defaultModelLabel,
  effortChipLabel,
  effortOptions,
  offeredEffort,
  sharedUnsetChip,
  type EffortValue,
} from '../../lib/textModelPick';
import { useAtelierStore } from '../../store/atelier';
import { usePendingTaskPicks, useSetTaskPick, useTextModels } from '../../hooks/useTextModels';
import { useRoutingSaving, useSetRoutingDefault, useSetRoutingWriter, useTextRouting } from '../../hooks/useTextProviders';
import ChipSelect, { type ChipSelectOption } from '../Composer/ChipSelect';
import { ChipText, FeatureGroup, FeaturePanel, FeatureRow } from './FeatureRow';
import styles from './index.module.css';

// Model ids are never empty, so '' stands for "Default model" / "No default" / "No writer".
const NONE = '';

const WRITER_MODES: readonly { readonly mode: TextWriterMode; readonly label: string }[] = [
  { mode: 'lock', label: 'Always' },
  { mode: 'prefer', label: 'Unless someone picked their own' },
];

const FEATURES_NOTE = 'What each feature writes with for everyone. People can pick their own model under Your picks.';
const IMAGE_MODELS_NOTE = 'Give an image model its own prompt writer. It writes every prompt made for that image model.';

// Enabled models grouped by provider; offline ones stay assignable (routing
// falls back while they are down) but carry the hint.
function modelOptions(providers: readonly AdminProvider[], noneLabel: string): readonly ChipSelectOption<string>[] {
  return [
    { value: NONE, label: noneLabel },
    ...providers.flatMap((provider) => provider.models
      .filter((model) => model.enabled)
      .map((model) => (model.status === 'offline'
        ? { value: model.id, label: model.displayName, group: provider.name, hint: 'offline' }
        : { value: model.id, label: model.displayName, group: provider.name }))),
  ];
}

const effortValue = (next: EffortValue): TextReasoningEffort | null => (next === 'default' ? null : next);

interface SharedSetupProps {
  readonly providers: readonly AdminProvider[];
}

/** Shared setup: the default model, feature assignments and prompt writers, each with an effort. */
export default function SharedSetup({ providers }: SharedSetupProps) {
  const routing = useTextRouting();
  const setDefault = useSetRoutingDefault();
  // Any routing save locks every control in both panels until it settles.
  // Read from the mutation cache: a save started before a tab change is
  // still pending when this panel mounts again.
  const saving = useRoutingSaving();
  const setWriter = useSetRoutingWriter();
  const personal = useTextModels();
  const setPick = useSetTaskPick();
  const pendingPicks = usePendingTaskPicks();
  const addToast = useAtelierStore((state) => state.addToast);

  const data = routing.data;
  if (data === undefined) {
    return (
      <FeaturePanel
        label="Features"
        note={routing.isError ? 'Couldn’t load the routing settings.' : 'Loading routing…'}
      />
    );
  }

  const byId = new Map<string, AdminModel>(providers.flatMap((provider) => provider.models.map((model) => [model.id, model] as const)));
  const nameOf = (id: string | undefined, fallback: string) =>
    id === undefined ? fallback : byId.get(id)?.displayName ?? 'Removed model';
  const unassigned = TEXT_TASKS.filter((task) => data.defaults.byTask[task] === undefined).length;
  const defaultModel = data.defaults.default === undefined ? undefined : byId.get(data.defaults.default);
  const defaultNote = ![...byId.values()].some((model) => model.enabled)
    ? 'Turn on a model to choose a default.'
    : data.defaults.default === undefined
      ? unassigned > 0
        ? `No default yet. Choose one for the ${unassigned} unassigned ${unassigned === 1 ? 'feature' : 'features'}.`
        : 'All features have assignments.'
      : defaultModel === undefined
        ? 'This default model is no longer listed. Choose another.'
        : !defaultModel.enabled
          ? `${defaultModel.displayName} is off. Turn it on or choose another default.`
          : defaultModel.status === 'offline'
            ? `${defaultModel.displayName} is offline right now.`
            : 'Every feature uses it unless one is assigned below.';

  const fail = (fallback: string) => (error: unknown) => {
    addToast(describeError(error, fallback), 'error');
  };
  // Handlers read the live routing answer of this render, never a lagging copy.
  const saveDefault = (scope: 'default' | TextTask, next: string) => {
    // A model change omits the effort: the server keeps a stored effort the new model offers.
    setDefault.mutateAsync({ scope, body: { modelId: next === NONE ? null : next } })
      .catch(fail('Couldn’t save the model.'));
  };
  const saveDefaultEffort = (scope: 'default' | TextTask, next: EffortValue) => {
    const modelId = scope === 'default' ? data.defaults.default : data.defaults.byTask[scope];
    if (modelId === undefined) return;
    setDefault.mutateAsync({ scope, body: { modelId, effort: effortValue(next) } })
      .catch(fail('Couldn’t save the reasoning effort.'));
  };
  const saveWriter = (imageModelId: string, body: TextWriterPutRequest) => {
    setWriter.mutateAsync({ imageModelId, body })
      .catch(fail('Couldn’t save the prompt writer.'));
  };
  // The server takes an omitted mode as 'prefer', so a save on an existing
  // writer always carries its current mode.
  const saveWriterModel = (imageModelId: string, next: string) => {
    const writer = data.writers[imageModelId];
    if (next === NONE) saveWriter(imageModelId, { modelId: null });
    else saveWriter(imageModelId, writer === undefined ? { modelId: next } : { modelId: next, mode: writer.mode });
  };
  const saveWriterMode = (imageModelId: string, mode: TextWriterMode) => {
    const writer = data.writers[imageModelId];
    if (writer === undefined) return;
    saveWriter(imageModelId, { modelId: writer.modelId, mode });
  };
  const saveWriterEffort = (imageModelId: string, next: EffortValue) => {
    const writer = data.writers[imageModelId];
    if (writer === undefined) return;
    saveWriter(imageModelId, { modelId: writer.modelId, mode: writer.mode, effort: effortValue(next) });
  };
  const clearOwnPick = (task: TextTask) => {
    if (pendingPicks.has(task)) return;
    setPick.mutateAsync({ task, modelId: null })
      .catch(fail('Couldn’t save the text model.'));
  };

  /** The effort slot of an assigned row: a chip, the fixed-effort text, or nothing for an unlisted model. */
  const effortSlot = (label: string, modelId: string | undefined, stored: TextReasoningEffort | undefined, onSave: (next: EffortValue) => void) => {
    const model = modelId === undefined ? undefined : byId.get(modelId);
    if (model === undefined) return null;
    if (model.reasoningLevels.length === 0) return <p className={styles.effortFixed}>{EFFORT_FIXED_LABEL}</p>;
    const effort = offeredEffort(model.reasoningLevels, stored);
    const display = effortChipLabel(effort);
    return (
      <ChipSelect<EffortValue>
        ariaLabel={`Reasoning effort for ${label}, currently ${display}`}
        valueDisplay={display}
        options={effortOptions(model.reasoningLevels)}
        value={effort}
        disabled={saving}
        onChange={onSave}
      />
    );
  };

  const listing = personal.data;
  const ownPickName = (task: TextTask): string | undefined => {
    const pick = listing?.tasks.find((row) => row.task === task)?.pick;
    return pick === undefined ? undefined : listing?.models.find((model) => model.id === pick)?.displayName;
  };

  const defaultName = nameOf(data.defaults.default, NO_DEFAULT_LABEL);
  const inheritedName = data.defaults.default === undefined ? undefined : defaultName;
  const taskOptions = modelOptions(providers, defaultModelLabel(inheritedName));
  const writerOptions = modelOptions(providers, NO_WRITER_LABEL);

  return (
    <>
      <FeaturePanel label="Features" note={FEATURES_NOTE}>
        <FeatureRow
          label="Default model"
          description={defaultNote}
          model={(
            <ChipSelect<string>
              ariaLabel={`Default model, currently ${defaultName}`}
              valueDisplay={data.defaults.default === undefined
                ? <ChipText value={{ text: NO_DEFAULT_LABEL, quiet: true, inherited: false }} />
                : defaultName}
              valueTitle={defaultName}
              options={modelOptions(providers, NO_DEFAULT_LABEL)}
              value={data.defaults.default ?? NONE}
              disabled={saving}
              onChange={(next) => { saveDefault('default', next); }}
            />
          )}
          effort={effortSlot('Default model', data.defaults.default, data.efforts.default, (next) => { saveDefaultEffort('default', next); })}
        />
        {TEXT_TASK_GROUPS.map((group) => (
          <FeatureGroup key={group.id} label={group.label}>
            {group.tasks.map((task) => {
              const label = TEXT_TASK_LABELS[task];
              const assigned = data.defaults.byTask[task];
              const display = assigned === undefined ? defaultModelLabel(inheritedName) : nameOf(assigned, '');
              const own = ownPickName(task);
              const ownPending = pendingPicks.has(task);
              const title = assigned === undefined ? inheritedName : display;
              return (
                <FeatureRow
                  key={task}
                  label={label}
                  description={TEXT_TASK_DESCRIPTIONS[task]}
                  note={own === undefined ? undefined : (
                    <p className={styles.featureNote}>
                      {`Your own pick here is ${own}. `}
                      <button
                        type="button"
                        className={styles.textAction}
                        aria-disabled={ownPending ? true : undefined}
                        aria-busy={ownPending ? true : undefined}
                        onClick={() => { clearOwnPick(task); }}
                      >
                        Use the shared model
                      </button>
                    </p>
                  )}
                  model={(
                    <ChipSelect<string>
                      ariaLabel={`Model for ${label}, currently ${display}`}
                      valueDisplay={assigned === undefined ? <ChipText value={sharedUnsetChip(inheritedName)} /> : display}
                      {...(title === undefined ? {} : { valueTitle: title })}
                      options={taskOptions}
                      value={assigned ?? NONE}
                      disabled={saving}
                      onChange={(next) => { saveDefault(task, next); }}
                    />
                  )}
                  effort={effortSlot(label, assigned, data.efforts.byTask[task], (next) => { saveDefaultEffort(task, next); })}
                />
              );
            })}
          </FeatureGroup>
        ))}
      </FeaturePanel>

      <FeaturePanel label="Image models" note={IMAGE_MODELS_NOTE}>
        {data.imageModels.map((image) => {
          const writer = data.writers[image.id];
          const display = nameOf(writer?.modelId, NO_WRITER_LABEL);
          return (
            <FeatureRow
              key={image.id}
              label={image.label}
              model={(
                <ChipSelect<string>
                  ariaLabel={`Prompt writer for ${image.label}, currently ${display}`}
                  valueDisplay={writer ? display : <ChipText value={{ text: display, quiet: true, inherited: false }} />}
                  valueTitle={display}
                  options={writerOptions}
                  value={writer?.modelId ?? NONE}
                  disabled={saving}
                  onChange={(next) => { saveWriterModel(image.id, next); }}
                />
              )}
              effort={writer && effortSlot(image.label, writer.modelId, writer.effort, (next) => { saveWriterEffort(image.id, next); })}
              below={writer && (
                <div className={styles.modes} role="radiogroup" aria-label={`When ${image.label} uses ${display}`}>
                  {WRITER_MODES.map(({ mode, label }) => (
                    <label key={mode} className={styles.mode}>
                      <input
                        type="radio"
                        name={`writer-mode-${image.id}`}
                        checked={writer.mode === mode}
                        disabled={saving}
                        onChange={() => { saveWriterMode(image.id, mode); }}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              )}
            />
          );
        })}
      </FeaturePanel>
    </>
  );
}
