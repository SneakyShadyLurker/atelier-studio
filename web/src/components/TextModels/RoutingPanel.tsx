import { useId } from 'react';
import type { AdminModel, AdminProvider, TextTask, TextWriterMode } from '@atelier/shared';
import { TEXT_TASK_LABELS, TEXT_TASKS } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import { useSetRoutingDefault, useSetRoutingWriter, useTextRouting } from '../../hooks/useTextProviders';
import ChipSelect, { type ChipSelectOption } from '../Composer/ChipSelect';
import styles from './index.module.css';

// Model ids are never empty, so '' stands for "Use default" / "No writer".
const NONE = '';

const WRITER_MODES: readonly { readonly mode: TextWriterMode; readonly label: string }[] = [
  { mode: 'lock', label: 'Always use this model' },
  { mode: 'prefer', label: 'Use unless the person picked their own' },
];

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

interface RoutingPanelProps {
  readonly providers: readonly AdminProvider[];
}

/** Default model, task assignments and prompt writers (spec § 12.3). */
export default function RoutingPanel({ providers }: RoutingPanelProps) {
  const headingId = useId();
  const routing = useTextRouting();
  const setDefault = useSetRoutingDefault();
  const setWriter = useSetRoutingWriter();
  const addToast = useAtelierStore((state) => state.addToast);

  const data = routing.data;
  if (data === undefined) {
    return (
      <section className={`${styles.panel} ${styles.routing}`} aria-labelledby={headingId}>
        <h3 id={headingId} className={styles.panelTitle}>Routing</h3>
        <p className={styles.note}>
          {routing.isError ? 'Couldn’t load the routing settings.' : 'Loading routing…'}
        </p>
      </section>
    );
  }

  const byId = new Map<string, AdminModel>(providers.flatMap((provider) => provider.models.map((model) => [model.id, model] as const)));
  const nameOf = (id: string | undefined, fallback: string) =>
    id === undefined ? fallback : byId.get(id)?.displayName ?? 'Removed model';
  const assigned = TEXT_TASKS.filter((task) => data.defaults.byTask[task] !== undefined).length;
  const saving = setDefault.isPending || setWriter.isPending;

  const fail = (fallback: string) => (error: unknown) => {
    addToast(describeError(error, fallback), 'error');
  };
  const saveDefault = (scope: 'default' | TextTask, next: string) => {
    setDefault.mutateAsync({ scope, modelId: next === NONE ? null : next })
      .catch(fail('Couldn’t save the model.'));
  };
  const saveWriter = (imageModelId: string, modelId: string | null, mode?: TextWriterMode) => {
    setWriter.mutateAsync({ imageModelId, body: mode === undefined ? { modelId } : { modelId, mode } })
      .catch(fail('Couldn’t save the prompt writer.'));
  };

  const defaultName = nameOf(data.defaults.default, 'No default');
  // An unassigned task shows the model it falls through to, quietly, so the
  // list reads as a map of where every task goes; overrides stay full ink.
  const inherited = data.defaults.default === undefined
    ? <span className={styles.unsetValue}>Use default</span>
    : <span className={styles.unsetValue}><span aria-hidden="true">↳ </span>{defaultName}</span>;
  const taskOptions = modelOptions(providers, 'Use default');
  const writerOptions = modelOptions(providers, 'No writer');

  return (
    <section className={`${styles.panel} ${styles.routing}`} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.panelTitle}>Routing</h3>

      <div className={styles.routeDefault}>
        <div className={styles.routeMain}>
          <p className={styles.routeLabel}>Default model</p>
          <p className={styles.note}>Every task uses it unless assigned below.</p>
        </div>
        <div className={styles.routeControl}>
          <ChipSelect<string>
            ariaLabel={`Default model, currently ${defaultName}`}
            valueDisplay={defaultName}
            options={modelOptions(providers, 'No default')}
            value={data.defaults.default ?? NONE}
            disabled={saving}
            onChange={(next) => { saveDefault('default', next); }}
          />
        </div>
      </div>

      <div className={styles.routeGroup} role="group" aria-labelledby={`${headingId}-tasks`}>
        <div className={styles.routeGroupHead}>
          <h4 id={`${headingId}-tasks`} className={styles.routeLabel}>Task assignments</h4>
          <p className={styles.note}>{`${assigned} assigned, ${TEXT_TASKS.length - assigned} use the default`}</p>
        </div>
        <ul className={styles.routeList}>
          {TEXT_TASKS.map((task) => {
            const label = TEXT_TASK_LABELS[task];
            const picked = data.defaults.byTask[task];
            const display = nameOf(picked, 'Use default');
            return (
              <li key={task} className={styles.routeItem}>
                <span className={styles.routeItemLabel}>{label}</span>
                <ChipSelect<string>
                  ariaLabel={`Model for ${label}, currently ${display}`}
                  valueDisplay={picked === undefined ? inherited : display}
                  options={taskOptions}
                  value={picked ?? NONE}
                  disabled={saving}
                  onChange={(next) => { saveDefault(task, next); }}
                />
              </li>
            );
          })}
        </ul>
      </div>

      <div className={styles.routeGroup} role="group" aria-labelledby={`${headingId}-writers`}>
        <div className={styles.routeGroupHead}>
          <h4 id={`${headingId}-writers`} className={styles.routeLabel}>Prompt writers</h4>
          <p className={styles.note}>Pick a model to write every prompt for one image model.</p>
        </div>
        <ul className={styles.routeList}>
          {data.imageModels.map((image) => {
            const writer = data.writers[image.id];
            const display = nameOf(writer?.modelId, 'No writer');
            return (
              <li key={image.id} className={styles.routeItem} data-has-writer={writer ? 'true' : undefined}>
                <span className={styles.routeItemLabel}>{image.label}</span>
                <ChipSelect<string>
                  ariaLabel={`Prompt writer for ${image.label}, currently ${display}`}
                  valueDisplay={writer ? display : <span className={styles.unsetValue}>{display}</span>}
                  options={writerOptions}
                  value={writer?.modelId ?? NONE}
                  disabled={saving}
                  onChange={(next) => {
                    // A new writer starts as 'prefer' (the server default);
                    // switching models keeps the chosen mode.
                    if (next === NONE) saveWriter(image.id, null);
                    else saveWriter(image.id, next, writer?.mode === 'lock' ? 'lock' : undefined);
                  }}
                />
                {writer && (
                  <div className={styles.modes} role="radiogroup" aria-label={`When ${image.label} uses ${display}`}>
                    {WRITER_MODES.map(({ mode, label }) => (
                      <label key={mode} className={styles.mode}>
                        <input
                          type="radio"
                          name={`writer-mode-${image.id}`}
                          checked={writer.mode === mode}
                          disabled={saving}
                          onChange={() => { saveWriter(image.id, writer.modelId, mode); }}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
