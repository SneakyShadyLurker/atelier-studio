import { useId } from 'react';
import type { TestReport as TestReportData, TextModelCapabilities, TextProbeCheck } from '@atelier/shared';
import { TEXT_REASONING_EFFORT_LABELS } from '@atelier/shared';
import { ApiError } from '../../api/client';
import { describeError } from '../../lib/errorCopy';
import { I } from '../icons/I';
import btn from '../../styles/buttons.module.css';
import form from './AddProviderDialog.module.css';
import styles from './ModelDialogs.module.css';

// "Test model" (spec § 6.5): four check lines, pending until the one JSON
// report arrives; confirmed findings and what the provider merely reported
// are labelled apart. Merging into the form is the dialog's job.

/** One shared limiter covers connection tests, model tests and list calls. */
export const PROBE_BUSY_COPY = 'Another test or model list is running. Try again in a moment.';

/**
 * A failed test or list call in plain words: 429 is the shared limiter, and a
 * 502 carries the server's own redacted explanation of the upstream failure.
 */
export function probeFailureCopy(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return PROBE_BUSY_COPY;
    if (error.status === 502 && error.message.trim() !== '') return error.message;
  }
  return describeError(error, fallback);
}

const CHECK_LABEL: Readonly<Record<string, string>> = {
  plain: 'Plain reply',
  json: 'JSON output',
  image: 'Image input',
  reasoning: 'Reasoning',
};

/** The probe's order (server `testModel`). */
const CHECK_ORDER = ['plain', 'json', 'image', 'reasoning'] as const;

const STATUS_WORD: Record<TextProbeCheck['status'], string> = { pass: 'Passed', fail: 'Failed', skip: 'Skipped' };

export type CapabilityKey = keyof TextModelCapabilities;

export const CAPABILITY_LABEL: Record<CapabilityKey, string> = {
  vision: 'Image input',
  maxImages: 'Max images',
  structuredOutput: 'JSON output',
  reasoningLevels: 'Reasoning levels',
  reasoningDefault: 'Default effort',
  temperature: 'Temperature',
  topP: 'Top P',
  fixedOutputTokens: 'Fixed output tokens',
  latencyProfile: 'Slow model',
  promptVariant: 'Prompt style',
};

export const JSON_MODE_LABEL: Record<TextModelCapabilities['structuredOutput'], string> = {
  json_schema: 'Schema',
  json_object: 'JSON only',
  none: 'None',
};

export const PROMPT_STYLE_LABEL: Record<TextModelCapabilities['promptVariant'], string> = {
  generic: 'Standard',
  kimi: 'Kimi-tuned',
};

function valueWords<K extends CapabilityKey>(key: K, value: TextModelCapabilities[K]): string {
  switch (key) {
    case 'vision':
      return value === true ? 'on' : 'off';
    case 'structuredOutput':
      return JSON_MODE_LABEL[value as TextModelCapabilities['structuredOutput']];
    case 'reasoningLevels': {
      const levels = value as TextModelCapabilities['reasoningLevels'];
      return levels.length === 0 ? 'none' : levels.map((level) => TEXT_REASONING_EFFORT_LABELS[level]).join(', ');
    }
    case 'reasoningDefault':
      return value === null ? 'not sent' : TEXT_REASONING_EFFORT_LABELS[value as NonNullable<TextModelCapabilities['reasoningDefault']>];
    case 'latencyProfile':
      return value === 'slow' ? 'on' : 'off';
    case 'promptVariant':
      return PROMPT_STYLE_LABEL[value as TextModelCapabilities['promptVariant']];
    case 'maxImages':
    case 'temperature':
    case 'topP':
    case 'fixedOutputTokens':
      return value === null ? 'no setting' : String(value);
  }
}

export interface Finding {
  readonly key: CapabilityKey;
  readonly text: string;
}

/** Each present field of a partial capability set as "Label: value". */
export function findingsOf(values: Partial<TextModelCapabilities>): Finding[] {
  return (Object.keys(CAPABILITY_LABEL) as CapabilityKey[])
    .filter((key) => values[key] !== undefined)
    .map((key) => {
      const value = values[key] as TextModelCapabilities[typeof key];
      return { key, text: `${CAPABILITY_LABEL[key]}: ${valueWords(key, value)}` };
    });
}

/** Advertised findings as suggestions; levels are the extras the probe did not try, offered as additions. */
export function suggestionsOf(values: Partial<TextModelCapabilities>): Finding[] {
  return findingsOf(values).map((finding) => (
    finding.key === 'reasoningLevels'
      ? { key: finding.key, text: `${CAPABILITY_LABEL.reasoningLevels}: also ${valueWords('reasoningLevels', values.reasoningLevels ?? [])}` }
      : finding
  ));
}

export type TestState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'report'; readonly report: TestReportData };

interface TestReportProps {
  readonly state: TestState;
  /** Advertised keys the admin ticked. */
  readonly chosen: ReadonlySet<CapabilityKey>;
  readonly onChoose: (key: CapabilityKey, chosen: boolean) => void;
  readonly onApply: () => void;
  /** Set once findings were applied: what was applied and what was kept. */
  readonly appliedNote: readonly string[] | null;
}

function CheckLine({ check }: { check: TextProbeCheck }) {
  const label = CHECK_LABEL[check.id] ?? check.id;
  return (
    <li className={styles.checkLine} data-status={check.status}>
      <span className={styles.checkMark} aria-hidden="true">
        {check.status === 'pass' ? <I.check /> : check.status === 'fail' ? <I.close /> : '–'}
      </span>
      <span>
        <span className="srOnly">{`${STATUS_WORD[check.status]}: `}</span>
        <span className={styles.checkLabel}>{label}</span>
        {`: ${check.message}`}
      </span>
    </li>
  );
}

export default function TestReport({ state, chosen, onChoose, onApply, appliedNote }: TestReportProps) {
  const confirmedId = useId();
  if (state.kind === 'idle') return null;
  if (state.kind === 'error') {
    return <div role="alert" className={`${form.report} ${form.reportFail}`}><p className={form.reportLine}>{state.message}</p></div>;
  }
  if (state.kind === 'running') {
    return (
      <div role="status" aria-live="polite" className={form.report}>
        <ul className={form.checks}>
          {CHECK_ORDER.map((id) => (
            <li key={id} className={styles.checkLine} data-status="pending">{`${CHECK_LABEL[id] ?? id}: checking…`}</li>
          ))}
        </ul>
      </div>
    );
  }

  const { report } = state;
  const failed = report.checks.filter((check) => check.status === 'fail').length;
  const confirmed = findingsOf(report.proposed);
  const suggested = suggestionsOf(report.advertised);
  const canApply = confirmed.length > 0 || suggested.length > 0;

  return (
    <div role="status" aria-live="polite" className={`${form.report} ${failed > 0 ? form.reportFail : ''}`}>
      {failed > 0 && (
        <p role="alert" className={form.reportHead}>
          {failed === 1 ? '1 check failed.' : `${failed} checks failed.`}
        </p>
      )}
      <ul className={form.checks}>
        {report.checks.map((check) => <CheckLine key={check.id} check={check} />)}
      </ul>

      {confirmed.length > 0 && (
        <div className={styles.findings} role="group" aria-labelledby={confirmedId}>
          <p id={confirmedId} className={styles.findingsHead}>Confirmed by the test</p>
          <ul className={styles.findingList}>
            {confirmed.map((finding) => <li key={finding.key}>{finding.text}</li>)}
          </ul>
        </div>
      )}

      {suggested.length > 0 && (
        <fieldset className={styles.findings}>
          <legend className={styles.findingsHead}>Reported by the provider</legend>
          <div className={form.choices}>
            {suggested.map((finding) => (
              <label key={finding.key} className={form.choice}>
                <input
                  type="checkbox"
                  checked={chosen.has(finding.key)}
                  onChange={(event) => { onChoose(finding.key, event.currentTarget.checked); }}
                />
                <span>{finding.text}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {report.wireNotes.map((note) => <p key={note} className={form.reportLine}>{note}</p>)}

      {canApply && (
        <div className={styles.applyRow}>
          <button type="button" className={btn.secondary} onClick={onApply} disabled={appliedNote !== null}>
            Apply findings
          </button>
          {appliedNote?.map((line) => <span key={line} className={styles.testNote}>{line}</span>)}
        </div>
      )}
    </div>
  );
}
