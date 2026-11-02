import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
  AdminModel,
  AdminProvider,
  TextModelCapabilities,
  TextReasoningEffort,
} from '@atelier/shared';
import { TEXT_REASONING_EFFORT_LABELS, TEXT_REASONING_EFFORT_VALUES, TEXT_STRUCTURED_OUTPUT_MODES } from '@atelier/shared';
import type { ModelPatchBody } from '../../api/textProviders';
import { useExitTransition } from '../../hooks/useExitTransition';
import { useDeleteModel, useTestModel, useTextProviders, useUpdateModel } from '../../hooks/useTextProviders';
import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import { RelativeTime } from '../Batch/RelativeTime';
import ConfirmDialog from '../ConfirmDialog';
import { DialogShell } from '../DialogShell';
import btn from '../../styles/buttons.module.css';
import dialogStyles from '../../styles/dialog.module.css';
import { joinWords, removeModelCopy } from './ModelRow';
import { describedBy } from './ProviderForm';
import TestReport, {
  CAPABILITY_LABEL,
  JSON_MODE_LABEL,
  PROMPT_STYLE_LABEL,
  probeFailureCopy,
  type CapabilityKey,
  type TestState,
} from './TestReport';
import form from './AddProviderDialog.module.css';
import styles from './ModelDialogs.module.css';

const NAME_MAX = 60;

/** The form: numbers stay text while typed; '' = no setting. */
interface ModelDraft {
  readonly displayName: string;
  readonly vision: boolean;
  readonly maxImages: string;
  readonly structuredOutput: TextModelCapabilities['structuredOutput'];
  readonly reasoningLevels: readonly TextReasoningEffort[];
  readonly reasoningDefault: TextReasoningEffort | '';
  readonly temperature: string;
  readonly topP: string;
  readonly fixedOutputTokens: string;
  readonly latencyProfile: TextModelCapabilities['latencyProfile'];
  readonly promptVariant: TextModelCapabilities['promptVariant'];
  readonly screenRequests: boolean;
}

type DraftErrors = Partial<Record<'displayName' | 'maxImages' | 'reasoningDefault' | 'temperature' | 'topP' | 'fixedOutputTokens', string>>;

const numberText = (value: number | null) => (value === null ? '' : String(value));

/** One capability value as the form holds it. */
function draftValue<K extends CapabilityKey>(key: K, value: TextModelCapabilities[K]): ModelDraft[K] {
  if (key === 'maxImages' || key === 'temperature' || key === 'topP' || key === 'fixedOutputTokens') {
    return numberText(value as number | null) as ModelDraft[K];
  }
  if (key === 'reasoningDefault') return (value ?? '') as ModelDraft[K];
  return value as unknown as ModelDraft[K];
}

function draftOf(model: AdminModel): ModelDraft {
  return {
    displayName: model.displayName,
    vision: model.vision,
    maxImages: numberText(model.maxImages),
    structuredOutput: model.structuredOutput,
    reasoningLevels: model.reasoningLevels,
    reasoningDefault: model.reasoningDefault ?? '',
    temperature: numberText(model.temperature),
    topP: numberText(model.topP),
    fixedOutputTokens: numberText(model.fixedOutputTokens),
    latencyProfile: model.latencyProfile,
    promptVariant: model.promptVariant,
    screenRequests: model.screenRequests,
  };
}

/** Levels in their canonical order, whatever order they were toggled in. */
const ordered = (levels: Iterable<TextReasoningEffort>) => {
  const set = new Set(levels);
  return TEXT_REASONING_EFFORT_VALUES.filter((level) => set.has(level));
};

function parseNumber(text: string, integer: boolean, min: number, max: number): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return undefined;
  return value;
}

/** The server's rules (api `validateModel` + route schema), in its words. */
function errorsOf(draft: ModelDraft): DraftErrors {
  const errors: { -readonly [K in keyof DraftErrors]: DraftErrors[K] } = {};
  const name = draft.displayName.trim();
  if (name.length < 1 || name.length > NAME_MAX) errors.displayName = `Display name must be 1 to ${NAME_MAX} characters.`;
  const maxImages = parseNumber(draft.maxImages, true, 1, 1000);
  if (maxImages === undefined) errors.maxImages = 'Max images must be a whole number from 1 to 1000.';
  else if (maxImages !== null && !draft.vision) errors.maxImages = 'An image limit needs image input turned on.';
  // Empty levels = fixed effort: any default is sent as is.
  if (draft.reasoningDefault !== '' && draft.reasoningLevels.length > 0 && !draft.reasoningLevels.includes(draft.reasoningDefault)) {
    errors.reasoningDefault = 'The default reasoning level must be one of the levels users can pick.';
  }
  if (parseNumber(draft.temperature, false, 0, 2) === undefined) errors.temperature = 'Temperature must be a number from 0 to 2.';
  if (parseNumber(draft.topP, false, 0, 1) === undefined) errors.topP = 'Top P must be a number from 0 to 1.';
  if (parseNumber(draft.fixedOutputTokens, true, 1, 1_000_000) === undefined) {
    errors.fixedOutputTokens = 'Fixed output tokens must be a whole number from 1 to 1,000,000.';
  }
  return errors;
}

const sameLevels = (a: readonly TextReasoningEffort[], b: readonly TextReasoningEffort[]) =>
  a.length === b.length && a.every((level, index) => level === b[index]);

/** Only the fields that changed; call with a draft that has no errors. */
function patchOf(model: AdminModel, draft: ModelDraft): ModelPatchBody {
  const name = draft.displayName.trim();
  const maxImages = parseNumber(draft.maxImages, true, 1, 1000) ?? null;
  const temperature = parseNumber(draft.temperature, false, 0, 2) ?? null;
  const topP = parseNumber(draft.topP, false, 0, 1) ?? null;
  const fixedOutputTokens = parseNumber(draft.fixedOutputTokens, true, 1, 1_000_000) ?? null;
  const reasoningDefault = draft.reasoningDefault === '' ? null : draft.reasoningDefault;
  return {
    ...(name === model.displayName ? {} : { displayName: name }),
    ...(draft.vision === model.vision ? {} : { vision: draft.vision }),
    ...(maxImages === model.maxImages ? {} : { maxImages }),
    ...(draft.structuredOutput === model.structuredOutput ? {} : { structuredOutput: draft.structuredOutput }),
    ...(sameLevels(draft.reasoningLevels, model.reasoningLevels) ? {} : { reasoningLevels: draft.reasoningLevels }),
    ...(reasoningDefault === model.reasoningDefault ? {} : { reasoningDefault }),
    ...(temperature === model.temperature ? {} : { temperature }),
    ...(topP === model.topP ? {} : { topP }),
    ...(fixedOutputTokens === model.fixedOutputTokens ? {} : { fixedOutputTokens }),
    ...(draft.latencyProfile === model.latencyProfile ? {} : { latencyProfile: draft.latencyProfile }),
    ...(draft.promptVariant === model.promptVariant ? {} : { promptVariant: draft.promptVariant }),
    ...(draft.screenRequests === model.screenRequests ? {} : { screenRequests: draft.screenRequests }),
  };
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * "Apply findings": confirmed values land unless the admin changed that field
 * since the test started (those are kept and named); ticked suggestions land
 * too, levels as an addition. Turning image input off clears the image limit,
 * so the findings never leave the form invalid on that rule.
 */
function applyFindings(
  draft: ModelDraft,
  baseline: ModelDraft,
  proposed: Partial<TextModelCapabilities>,
  advertised: Partial<TextModelCapabilities>,
  chosen: ReadonlySet<CapabilityKey>,
): { draft: ModelDraft; kept: string[] } {
  const next: Record<string, unknown> = { ...draft };
  const kept: string[] = [];
  for (const key of Object.keys(CAPABILITY_LABEL) as CapabilityKey[]) {
    const value = proposed[key];
    if (value === undefined) continue;
    if (!sameValue(draft[key], baseline[key])) {
      kept.push(CAPABILITY_LABEL[key]);
      continue;
    }
    next[key] = draftValue(key, value);
  }
  for (const key of chosen) {
    const value = advertised[key];
    if (value === undefined) continue;
    next[key] = key === 'reasoningLevels'
      ? ordered([...(next.reasoningLevels as readonly TextReasoningEffort[]), ...(value as readonly TextReasoningEffort[])])
      : draftValue(key, value as TextModelCapabilities[typeof key]);
  }
  const merged = next as unknown as ModelDraft;
  return { draft: !merged.vision && draft.vision ? { ...merged, maxImages: '' } : merged, kept };
}

interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly error: string | undefined;
  readonly hint?: string;
  readonly children: (describedById: string | undefined) => ReactNode;
}

/** A labelled field with its hint and error tied by aria-describedby. */
function Field({ id, label, error, hint, children }: FieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className={form.field}>
      <label htmlFor={id} className={form.fieldLabel}>{label}</label>
      {children(describedBy(hint !== undefined && hintId, error !== undefined && errorId))}
      {hint !== undefined && <p id={hintId} className={form.fieldHint}>{hint}</p>}
      {error !== undefined && <p id={errorId} className={form.fieldError}>{error}</p>}
    </div>
  );
}

interface EditModelDialogProps {
  readonly provider: AdminProvider;
  readonly model: AdminModel;
  readonly imageLabel: (id: string) => string;
  /** Opened from the row's Test: run the test straight away. */
  readonly startTest: boolean;
  readonly onClose: () => void;
}

export default function EditModelDialog({ provider, model, imageLabel, startTest, onClose }: EditModelDialogProps) {
  const titleId = useId();
  const fieldId = useId();
  const levelsId = useId();
  const screenHintId = useId();
  const { closing, requestClose } = useExitTransition(onClose, true);
  const addToast = useAtelierStore((state) => state.addToast);
  const admin = useTextProviders();
  const update = useUpdateModel();
  const remove = useDeleteModel();
  const test = useTestModel();

  const [initial] = useState(() => draftOf(model));
  const [draft, setDraft] = useState<ModelDraft>(initial);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<CapabilityKey>>(new Set());
  const [appliedNote, setAppliedNote] = useState<readonly string[] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The form when the shown report's test started; read only in handlers.
  const baselineRef = useRef<ModelDraft>(initial);
  const startedRef = useRef(false);

  // The fresh row after a test (verifiedAt, lastTest) or another admin's edit.
  const live = admin.data?.providers.find((row) => row.id === provider.id)?.models.find((row) => row.id === model.id) ?? model;
  const errors = errorsOf(draft);
  const valid = Object.keys(errors).length === 0;
  const patch = valid ? patchOf(model, draft) : {};
  const dirty = Object.keys(patch).length > 0;
  const busy = update.isPending || remove.isPending;
  const screenWarning = provider.warnings.includes('screen-requests-without-key');

  let testState: TestState = { kind: 'idle' };
  if (test.isPending) testState = { kind: 'running' };
  else if (test.isError) testState = { kind: 'error', message: probeFailureCopy(test.error, 'The test could not run. Try again.') };
  else if (test.data !== undefined) testState = { kind: 'report', report: test.data };
  else if (live.lastTest !== null) testState = { kind: 'report', report: live.lastTest };

  const { mutate: runModelTest } = test;
  useEffect(() => {
    if (!startTest || startedRef.current) return;
    startedRef.current = true;
    runModelTest({ providerId: provider.id, modelId: model.id });
  }, [startTest, runModelTest, provider.id, model.id]);

  const change = (next: Partial<ModelDraft>) => {
    setDraft((previous) => ({ ...previous, ...next }));
    setSaveError(null);
  };

  const runTest = () => {
    baselineRef.current = draft;
    setChosen(new Set());
    setAppliedNote(null);
    test.mutate({ providerId: provider.id, modelId: model.id });
  };

  const apply = () => {
    if (testState.kind !== 'report') return;
    const { report } = testState;
    const result = applyFindings(draft, baselineRef.current, report.proposed, report.advertised, chosen);
    setDraft(result.draft);
    setSaveError(null);
    setAppliedNote([
      'Applied. Save to keep them.',
      ...(result.kept.length === 0 ? [] : [`Kept your ${result.kept.length === 1 ? 'change' : 'changes'} to ${joinWords(result.kept)}.`]),
    ]);
  };

  const toggleLevel = (level: TextReasoningEffort) => {
    const has = draft.reasoningLevels.includes(level);
    change({ reasoningLevels: has ? draft.reasoningLevels.filter((item) => item !== level) : ordered([...draft.reasoningLevels, level]) });
  };

  const save = () => {
    if (busy || closing || !dirty || !valid) return;
    setSaveError(null);
    update.mutateAsync({ providerId: provider.id, modelId: model.id, patch })
      .then((saved) => {
        addToast(`Saved ${saved.displayName}`);
        onClose();
      })
      .catch((error: unknown) => { setSaveError(describeError(error, 'Couldn’t save the model. Try again.')); });
  };

  const confirmRemove = () => {
    setConfirmDelete(false);
    remove.mutateAsync({ providerId: provider.id, modelId: model.id })
      .then(() => {
        addToast(`Removed ${model.displayName}`);
        onClose();
      })
      .catch((error: unknown) => { setSaveError(describeError(error, `Couldn’t remove ${model.displayName}. Try again.`)); });
  };

  // With no levels users cannot pick an effort; the default becomes the one
  // effort always sent, and any level is allowed (server rule).
  const fixed = draft.reasoningLevels.length === 0;
  const defaultChoices: readonly TextReasoningEffort[] = fixed
    ? TEXT_REASONING_EFFORT_VALUES
    : ordered([...draft.reasoningLevels, ...(draft.reasoningDefault === '' ? [] : [draft.reasoningDefault])]);
  const advancedError = errors.temperature ?? errors.topP ?? errors.fixedOutputTokens;

  let tested: ReactNode;
  if (live.verifiedAt !== null) tested = <>Last tested <RelativeTime timestamp={live.verifiedAt} /></>;
  else if (live.lastTest !== null) tested = 'The last test did not pass every check.';
  else tested = 'Not tested yet. Test to confirm capabilities.';

  return (
    <>
      <DialogShell
        open
        onCancel={() => { if (!busy && !confirmDelete) requestClose(); }}
        closing={closing}
        busy={busy}
        labelledBy={titleId}
      >
        <div className={`${dialogStyles.dialog} ${form.dialog} ${styles.dialog}`}>
          <div className={dialogStyles.handle} aria-hidden="true" />
          <h2 id={titleId} className={dialogStyles.title}>Edit model</h2>
          <p className={styles.subtitle}>{model.modelId}</p>

          <Field id={`${fieldId}-name`} label="Display name" error={errors.displayName}>
            {(described) => (
              <div className={form.inputBox}>
                <input
                  id={`${fieldId}-name`}
                  className={form.textInput}
                  value={draft.displayName}
                  maxLength={NAME_MAX + 20}
                  autoComplete="off"
                  disabled={busy}
                  aria-invalid={errors.displayName === undefined ? undefined : true}
                  aria-describedby={described}
                  onChange={(event) => { change({ displayName: event.currentTarget.value }); }}
                />
              </div>
            )}
          </Field>

          <div className={form.field}>
            <div className={styles.capRow}>
              <label className={form.choice}>
                <input
                  type="checkbox"
                  checked={draft.vision}
                  disabled={busy}
                  onChange={(event) => { change({ vision: event.currentTarget.checked }); }}
                />
                <span>Image input</span>
              </label>
              <span className={styles.selectRow}>
                <label htmlFor={`${fieldId}-max`} className={styles.selectLabel}>Max images</label>
                <span className={`${form.inputBox} ${styles.numberBox}`}>
                  <input
                    id={`${fieldId}-max`}
                    className={form.textInput}
                    inputMode="numeric"
                    placeholder="No limit"
                    value={draft.maxImages}
                    disabled={busy}
                    aria-invalid={errors.maxImages === undefined ? undefined : true}
                    aria-describedby={describedBy(errors.maxImages !== undefined && `${fieldId}-max-error`)}
                    onChange={(event) => { change({ maxImages: event.currentTarget.value }); }}
                  />
                </span>
              </span>
            </div>
            {errors.maxImages !== undefined && <p id={`${fieldId}-max-error`} className={form.fieldError}>{errors.maxImages}</p>}
          </div>

          <fieldset className={form.choiceGroup} disabled={busy}>
            <legend className={form.fieldLabel}>JSON output</legend>
            <div className={form.choices}>
              {TEXT_STRUCTURED_OUTPUT_MODES.map((mode) => (
                <label key={mode} className={form.choice}>
                  <input
                    type="radio"
                    name={`${fieldId}-json`}
                    checked={draft.structuredOutput === mode}
                    onChange={() => { change({ structuredOutput: mode }); }}
                  />
                  <span>{JSON_MODE_LABEL[mode]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className={form.field}>
            <p id={levelsId} className={form.fieldLabel}>Reasoning levels</p>
            <div className={styles.chips} role="group" aria-labelledby={levelsId}>
              {TEXT_REASONING_EFFORT_VALUES.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={styles.chip}
                  aria-pressed={draft.reasoningLevels.includes(level)}
                  disabled={busy}
                  onClick={() => { toggleLevel(level); }}
                >
                  {TEXT_REASONING_EFFORT_LABELS[level]}
                </button>
              ))}
            </div>
            <span className={styles.selectRow}>
              <label htmlFor={`${fieldId}-default`} className={styles.selectLabel}>{fixed ? 'Fixed effort' : 'Default effort'}</label>
              <select
                id={`${fieldId}-default`}
                className={styles.select}
                value={draft.reasoningDefault}
                disabled={busy}
                aria-invalid={errors.reasoningDefault === undefined ? undefined : true}
                aria-describedby={describedBy(
                  errors.reasoningDefault !== undefined && `${fieldId}-default-error`,
                  fixed && `${fieldId}-default-hint`,
                )}
                onChange={(event) => { change({ reasoningDefault: event.currentTarget.value as TextReasoningEffort | '' }); }}
              >
                <option value="">{fixed ? 'Not sent' : 'No default'}</option>
                {defaultChoices.map((level) => <option key={level} value={level}>{TEXT_REASONING_EFFORT_LABELS[level]}</option>)}
              </select>
            </span>
            {fixed && (
              <p id={`${fieldId}-default-hint`} className={form.fieldHint}>
                People can’t pick an effort for this model; this one is always sent.
              </p>
            )}
            {errors.reasoningDefault !== undefined && (
              <p id={`${fieldId}-default-error`} className={form.fieldError}>{errors.reasoningDefault}</p>
            )}
          </div>

          <div className={styles.testRow}>
            <button type="button" className={btn.secondary} onClick={runTest} disabled={busy || test.isPending}>
              {test.isPending ? 'Testing…' : 'Test model'}
            </button>
            <span className={styles.testNote}>{tested}</span>
          </div>
          <TestReport
            state={testState}
            chosen={chosen}
            onChoose={(key, on) => {
              setChosen((previous) => {
                const next = new Set(previous);
                if (on) next.add(key);
                else next.delete(key);
                return next;
              });
            }}
            onApply={apply}
            appliedNote={appliedNote}
          />

          <details
            className={form.advanced}
            open={advancedOpen || advancedError !== undefined}
            onToggle={(event) => { setAdvancedOpen(event.currentTarget.open); }}
          >
            <summary className={form.advancedSummary}>Advanced</summary>
            <div className={form.advancedBody}>
              <div className={styles.capRow}>
                <Field id={`${fieldId}-temp`} label="Temperature" error={errors.temperature}>
                  {(described) => (
                    <div className={`${form.inputBox} ${styles.numberBox}`}>
                      <input
                        id={`${fieldId}-temp`}
                        className={form.textInput}
                        inputMode="decimal"
                        placeholder="Default"
                        value={draft.temperature}
                        disabled={busy}
                        aria-invalid={errors.temperature === undefined ? undefined : true}
                        aria-describedby={described}
                        onChange={(event) => { change({ temperature: event.currentTarget.value }); }}
                      />
                    </div>
                  )}
                </Field>
                <Field id={`${fieldId}-topp`} label="Top P" error={errors.topP}>
                  {(described) => (
                    <div className={`${form.inputBox} ${styles.numberBox}`}>
                      <input
                        id={`${fieldId}-topp`}
                        className={form.textInput}
                        inputMode="decimal"
                        placeholder="Default"
                        value={draft.topP}
                        disabled={busy}
                        aria-invalid={errors.topP === undefined ? undefined : true}
                        aria-describedby={described}
                        onChange={(event) => { change({ topP: event.currentTarget.value }); }}
                      />
                    </div>
                  )}
                </Field>
                <Field id={`${fieldId}-tokens`} label="Fixed output tokens" error={errors.fixedOutputTokens}>
                  {(described) => (
                    <div className={`${form.inputBox} ${styles.numberBox}`}>
                      <input
                        id={`${fieldId}-tokens`}
                        className={form.textInput}
                        inputMode="numeric"
                        placeholder="Per task"
                        value={draft.fixedOutputTokens}
                        disabled={busy}
                        aria-invalid={errors.fixedOutputTokens === undefined ? undefined : true}
                        aria-describedby={described}
                        onChange={(event) => { change({ fixedOutputTokens: event.currentTarget.value }); }}
                      />
                    </div>
                  )}
                </Field>
              </div>
              <p className={form.fieldHint}>
                Leave a field empty to use the provider’s default. Fixed output tokens replaces every task’s own output budget.
              </p>

              <div className={form.field}>
                <label className={form.choice}>
                  <input
                    type="checkbox"
                    checked={draft.latencyProfile === 'slow'}
                    disabled={busy}
                    onChange={(event) => { change({ latencyProfile: event.currentTarget.checked ? 'slow' : 'standard' }); }}
                  />
                  <span>Slow model</span>
                </label>
                <p className={form.fieldHint}>Waits longer and accepts larger replies, for models that think for minutes.</p>
              </div>

              <fieldset className={form.choiceGroup} disabled={busy}>
                <legend className={form.fieldLabel}>Prompt style</legend>
                <div className={form.choices}>
                  {(['generic', 'kimi'] as const).map((variant) => (
                    <label key={variant} className={form.choice}>
                      <input
                        type="radio"
                        name={`${fieldId}-variant`}
                        checked={draft.promptVariant === variant}
                        onChange={() => { change({ promptVariant: variant }); }}
                      />
                      <span>{PROMPT_STYLE_LABEL[variant]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className={form.field}>
                <label className={form.choice}>
                  <input
                    type="checkbox"
                    checked={draft.screenRequests}
                    disabled={busy}
                    aria-describedby={screenHintId}
                    onChange={(event) => { change({ screenRequests: event.currentTarget.checked }); }}
                  />
                  <span>Screen requests first</span>
                </label>
                <p id={screenHintId} className={form.fieldHint}>
                  Checks each request with the content screen before it reaches this model. Needs OPENROUTER_API_KEY on the server.
                </p>
                {screenWarning && (
                  <p className={form.fieldWarning}>
                    OPENROUTER_API_KEY is not set on this server, so models that screen requests refuse them until it is.
                  </p>
                )}
              </div>
            </div>
          </details>

          {saveError !== null && <p role="alert" className={form.fieldError}>{saveError}</p>}

          <div className={`${dialogStyles.actions} ${form.actions}`}>
            <button type="button" className={btn.danger} onClick={() => { if (!closing) setConfirmDelete(true); }} disabled={busy}>
              Remove model…
            </button>
            <div className={dialogStyles.actionsRight}>
              <button type="button" className={btn.secondary} onClick={() => { if (!busy) requestClose(); }} disabled={busy}>
                Cancel
              </button>
              <button type="button" className={btn.primary} onClick={save} disabled={busy || !dirty || !valid}>
                {update.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
          {(busy || test.isPending) && <div className={dialogStyles.progressBar} aria-hidden="true" />}
        </div>
      </DialogShell>

      <ConfirmDialog
        open={confirmDelete}
        danger
        title={`Remove ${model.displayName}?`}
        body={removeModelCopy(live.usage, imageLabel)}
        confirmLabel="Remove model"
        cancelLabel="Cancel"
        onConfirm={confirmRemove}
        onCancel={() => { setConfirmDelete(false); }}
      />
    </>
  );
}
