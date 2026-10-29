import type { AiFillBackend, TextBackendWorkload, TextReasoningEffort } from '@atelier/shared';
import { TEXT_BACKEND_LABELS, TEXT_REASONING_EFFORT_LABELS, textBackendReasoningEfforts } from '@atelier/shared';
import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import { usePendingTextBackendWorkloads, useSetTextBackend, useTextBackends } from '../../hooks/useTextBackends';
import ChipSelect, { type ChipSelectOption } from '../Composer/ChipSelect';
import { LoadingState, ErrorState } from '../StateView';
import ModelStepsSection from './ModelStepsSection';
import styles from './SettingsPanel.module.css';

type SettingsBackend = Exclude<AiFillBackend, 'gpt'>;
type RowValue = 'auto' | SettingsBackend;
type EffortValue = 'default' | TextReasoningEffort;

interface WorkloadRow {
  readonly workload: TextBackendWorkload;
  readonly label: string;
  readonly description: string;
}

const ROWS: readonly WorkloadRow[] = [
  {
    workload: 'ai-fill',
    label: 'Ai-fill',
    description: 'Fills {{ai-fill:}} blanks in prompts',
  },
  {
    workload: 'brainstorm',
    label: 'Brainstorm',
    description: 'Writes full character prompts from a brief',
  },
  {
    workload: 'enhance',
    label: 'Enhance',
    description: 'Rewrites the composer prompt',
  },
  {
    workload: 'condense',
    label: 'Krea condense',
    description: 'Shortens over-budget Krea prompts before render',
  },
  {
    workload: 'storytelling',
    label: 'Storytelling planner',
    description: 'Plans AI Storytelling videos from an outline',
  },
];

const BACKENDS: readonly SettingsBackend[] = [
  'kimi',
  'mimo',
  'grok',
  'gemini-argon',
  'deepseek-abliterated',
  'glm-abliterated',
];

// The settings response is not validated, and a server deployed ahead of this
// bundle can return a backend key it does not know yet.
function isSettingsBackend(backend: string | undefined): backend is SettingsBackend {
  return (BACKENDS as readonly (string | undefined)[]).includes(backend);
}

// Unavailable backends stay listed but dimmed; the server routes their pins as Auto.
function backendOptions(unavailable: ReadonlySet<AiFillBackend>): readonly ChipSelectOption<RowValue>[] {
  return [
    { value: 'auto', label: 'Auto (default)' },
    ...BACKENDS.map((value) => (unavailable.has(value)
      ? { value, label: TEXT_BACKEND_LABELS[value], hint: 'unavailable', disabled: true }
      : { value, label: TEXT_BACKEND_LABELS[value] })),
  ];
}

function effortOptions(backend: SettingsBackend): readonly ChipSelectOption<EffortValue>[] {
  return [
    { value: 'default', label: 'Default' },
    ...textBackendReasoningEfforts(backend).map((value) => ({ value, label: TEXT_REASONING_EFFORT_LABELS[value] })),
  ];
}

function TextBackendsSection() {
  const settings = useTextBackends();
  const setBackend = useSetTextBackend();
  const saving = usePendingTextBackendWorkloads();
  const addToast = useAtelierStore((state) => state.addToast);

  if (settings.isPending) return <LoadingState label="Loading settings…" />;
  // A failed background refetch keeps the last data; only a panel with none
  // falls back to the error state.
  if (settings.data === undefined) {
    return (
      <ErrorState
        message="Couldn’t load the text backend settings."
        onRetry={() => { void settings.refetch(); }}
      />
    );
  }

  const unavailable = new Set(settings.data.unavailable);
  const options = backendOptions(unavailable);

  return (
    <section className={styles.panel} aria-label="Prompt library text backend settings">
      <div className={styles.head} data-zone="head">
        <h2 className={styles.headTitle}>Text backends</h2>
        <p className={styles.headNote}>
          Choose the writing models for local ComfyUI generations. Auto uses each feature’s
          default. Pin a model to set its reasoning effort. GPT image generations always use GPT for
          text.
        </p>
      </div>
      <div className={styles.body} data-zone="body">
        {ROWS.map((row) => {
          const override = settings.data.overrides[row.workload];
          // Local routing already ignores legacy GPT preferences and uses Auto; a key
          // this bundle does not know also shows as Auto instead of breaking the panel.
          const value: RowValue = isSettingsBackend(override) ? override : 'auto';
          const display = value === 'auto'
            ? 'Auto (default)'
            : unavailable.has(value)
              ? `${TEXT_BACKEND_LABELS[value]} unavailable · using Auto`
              : TEXT_BACKEND_LABELS[value];
          // An effort belongs to a pinned, routable backend; Auto keeps each default.
          const effortBackend = value === 'auto' || unavailable.has(value) ? null : value;
          const effort: EffortValue = effortBackend === null
            ? 'default'
            : settings.data.efforts[row.workload] ?? 'default';
          const rowSaving = saving.has(row.workload);
          const effortDisplay = effort === 'default'
            ? 'Default effort'
            : `${TEXT_REASONING_EFFORT_LABELS[effort]} effort`;
          return (
            <div key={row.workload} className={styles.row}>
              <div className={styles.rowMain}>
                <p className={styles.rowLabel}>{row.label}</p>
                <p className={styles.rowDescription}>{row.description}</p>
              </div>
              <div className={styles.rowControl}>
                <ChipSelect<RowValue>
                  ariaLabel={`Text backend for ${row.label}, currently ${display}`}
                  valueDisplay={display}
                  options={options}
                  value={value}
                  disabled={rowSaving}
                  onChange={(next) => {
                    // ChipSelect still reports dimmed rows; an unavailable backend is not selectable.
                    if (next !== 'auto' && unavailable.has(next)) return;
                    // mutateAsync: a second row's mutate() replaces per-call callbacks,
                    // which silenced the first save's failure toast.
                    setBackend.mutateAsync({ workload: row.workload, backend: next === 'auto' ? null : next })
                      .catch((error: unknown) => {
                        addToast(describeError(error, "Couldn't save the text backend."), 'error');
                      });
                  }}
                />
                <ChipSelect<EffortValue>
                  ariaLabel={`Reasoning effort for ${row.label}, currently ${effortDisplay}`}
                  valueDisplay={effortDisplay}
                  options={effortBackend === null ? [{ value: 'default', label: 'Default' }] : effortOptions(effortBackend)}
                  value={effort}
                  disabled={effortBackend === null || rowSaving}
                  {...(effortBackend === null ? { tip: 'Pin a model to choose its reasoning effort' } : {})}
                  onChange={(next) => {
                    if (effortBackend === null) return;
                    setBackend.mutateAsync({ workload: row.workload, backend: effortBackend, effort: next === 'default' ? null : next })
                      .catch((error: unknown) => {
                        addToast(describeError(error, "Couldn't save the reasoning effort."), 'error');
                      });
                  }}
                />
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
      <TextBackendsSection />
      <ModelStepsSection />
    </div>
  );
}
