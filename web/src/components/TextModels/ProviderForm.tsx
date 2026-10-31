import { useId, useState, type ReactNode } from 'react';
import type { ConnectionReport, TextProtocol, TextTokenField } from '@atelier/shared';
import { TEXT_TOKEN_FIELDS, validateTextProviderBaseUrl } from '@atelier/shared';
import { ApiError } from '../../api/client';
import { describeError } from '../../lib/errorCopy';
import { isRecord } from '../../lib/guards';
import styles from './AddProviderDialog.module.css';

// The provider form shared by "Add a provider" and "Edit provider": name,
// base URL, key slot, the Advanced disclosure and the connection report.

export const BYOK_MISSING_COPY =
  'This server has no BYOK_ENCRYPTION_KEY, so keys cannot be stored. Providers without a key still work.';

const BUSY_COPY = 'Another test is running. Try again in a moment.';
const NAME_MAX = 60;

export interface ProviderDraft {
  readonly name: string;
  readonly baseUrl: string;
  readonly protocol: TextProtocol;
  readonly tokenField: TextTokenField;
  readonly listModels: boolean;
  /** Only used by the connection test when listing is off; never stored. */
  readonly probeModelId: string;
}

export type DraftErrors = Partial<Record<'name' | 'baseUrl' | 'probeModelId', string>>;

/** Field errors for `draft`; `forTest` skips the name, which a test does not need. */
export function draftErrors(draft: ProviderDraft, forTest: boolean): DraftErrors {
  const errors: { -readonly [K in keyof DraftErrors]: DraftErrors[K] } = {};
  if (!forTest && draft.name.trim() === '') errors.name = 'Give the provider a name.';
  const url = validateTextProviderBaseUrl(draft.baseUrl);
  if (!url.ok) errors.baseUrl = url.message;
  if (forTest && !draft.listModels && draft.probeModelId.trim() === '') {
    errors.probeModelId = 'Enter the model id to send the test request to.';
  }
  return errors;
}

/** The normalized address (trailing slash stripped), or the raw text when invalid. */
export function normalizedUrl(baseUrl: string): string {
  const url = validateTextProviderBaseUrl(baseUrl);
  return url.ok ? url.normalized : baseUrl.trim();
}

/** A 503 `byok-not-configured`: the server cannot store keys. */
export function isByokRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 503) return false;
  const body = error.body;
  return error.message === 'byok-not-configured'
    || (typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'byok-not-configured');
}

export type ConnectionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'report'; readonly report: ConnectionReport; readonly signature: string }
  | { readonly kind: 'error'; readonly message: string; readonly signature: string };

export function connectionFailure(error: unknown, signature: string): ConnectionState {
  if (error instanceof ApiError && error.status === 429) return { kind: 'error', message: BUSY_COPY, signature };
  // A 502 means the server could not run the test; its message says why (credentials redacted server-side).
  if (error instanceof ApiError && error.status === 502) {
    const serverMessage = isRecord(error.body) ? error.body.error : undefined;
    if (typeof serverMessage === 'string' && serverMessage.trim().length > 0) {
      return { kind: 'error', message: serverMessage, signature };
    }
  }
  return { kind: 'error', message: describeError(error, 'The test could not run. Try again.'), signature };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The test report in sentences: `role="status"` for a pass, `role="alert"` for a failure. */
export function ConnectionResult({ state }: { state: ConnectionState }) {
  if (state.kind === 'idle' || state.kind === 'running') return null;
  if (state.kind === 'error') {
    return <div role="alert" className={`${styles.report} ${styles.reportFail}`}><p className={styles.reportLine}>{state.message}</p></div>;
  }
  const { report } = state;
  const lines = report.checks.map((check) => (
    <li key={check.id} className={check.status === 'fail' ? styles.checkFail : styles.check}>{check.message}</li>
  ));
  if (report.ok) {
    return (
      <div role="status" aria-live="polite" className={styles.report}>
        <p className={styles.reportHead}>
          Connection works.
          {report.listedCount !== undefined && ` ${plural(report.listedCount, 'model')} listed.`}
        </p>
        <ul className={styles.checks}>{lines}</ul>
      </div>
    );
  }
  return (
    <div role="alert" className={`${styles.report} ${styles.reportFail}`}>
      <p className={styles.reportHead}>The connection test failed.</p>
      <ul className={styles.checks}>{lines}</ul>
      {report.listUnsupported === true && (
        <p className={styles.reportLine}>
          If the address is right, you can save the provider anyway and enter model ids yourself.
        </p>
      )}
    </div>
  );
}

interface ApiKeyInputProps {
  readonly id: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly describedBy: string | undefined;
  readonly onChange: (value: string) => void;
}

/** Key entry, as ByokDialog: masked with show/hide, kept out of password managers. */
export function ApiKeyInput({ id, value, disabled, describedBy, onChange }: ApiKeyInputProps) {
  const [show, setShow] = useState(false);
  return (
    <div className={styles.inputBox}>
      <input
        id={id}
        className={styles.monoInput}
        aria-describedby={describedBy}
        type={show ? 'text' : 'password'}
        inputMode="text"
        // `new-password` is honored more reliably than `off` for
        // credential-shaped fields; the data-* opt-outs stop 1Password and
        // LastPass from capturing the provider key.
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        value={value}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.value); }}
      />
      <button
        type="button"
        className={styles.linkBtn}
        aria-label={show ? 'Hide API key' : 'Show API key'}
        disabled={disabled}
        onClick={() => { setShow((current) => !current); }}
      >
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

/** Ids joined for aria-describedby, or undefined when none apply. */
export function describedBy(...ids: readonly (string | false | null | undefined)[]): string | undefined {
  const present = ids.filter((id): id is string => typeof id === 'string' && id !== '');
  return present.length === 0 ? undefined : present.join(' ');
}

interface ProviderFieldsProps {
  readonly draft: ProviderDraft;
  readonly errors: DraftErrors;
  /** One plain line under the address (the preset's hint). */
  readonly urlHint?: string | undefined;
  /** The key row: entry on Add, saved-key controls on Edit. */
  readonly keySlot: ReactNode;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<ProviderDraft>) => void;
  readonly onBlurUrl: () => void;
}

const PROTOCOLS: readonly { readonly value: TextProtocol; readonly label: string }[] = [
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
  { value: 'anthropic', label: 'Anthropic' },
];

export function ProviderFields({ draft, errors, urlHint, keySlot, disabled, onChange, onBlurUrl }: ProviderFieldsProps) {
  const nameId = useId();
  const nameErrorId = useId();
  const urlId = useId();
  const urlHintId = useId();
  const urlErrorId = useId();
  const listId = useId();
  const listHintId = useId();
  const probeId = useId();
  const probeErrorId = useId();
  const tokenHintId = useId();
  // Starts open when listing is off, so "Model to test with" is in view.
  const [advancedOpen, setAdvancedOpen] = useState(!draft.listModels);

  return (
    <>
      <div className={styles.field}>
        <label htmlFor={nameId} className={styles.fieldLabel}>Name</label>
        <div className={styles.inputBox}>
          <input
            id={nameId}
            className={styles.textInput}
            maxLength={NAME_MAX}
            autoComplete="off"
            value={draft.name}
            disabled={disabled}
            aria-invalid={errors.name !== undefined ? true : undefined}
            aria-describedby={describedBy(errors.name !== undefined && nameErrorId)}
            onChange={(event) => { onChange({ name: event.target.value }); }}
          />
        </div>
        {errors.name !== undefined && <p id={nameErrorId} className={styles.fieldError}>{errors.name}</p>}
      </div>

      <div className={styles.field}>
        <label htmlFor={urlId} className={styles.fieldLabel}>Base URL</label>
        <div className={styles.inputBox}>
          <input
            id={urlId}
            className={styles.monoInput}
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="http://localhost:11434/v1"
            value={draft.baseUrl}
            disabled={disabled}
            aria-invalid={errors.baseUrl !== undefined ? true : undefined}
            aria-describedby={describedBy(urlHint !== undefined && urlHintId, errors.baseUrl !== undefined && urlErrorId)}
            onChange={(event) => { onChange({ baseUrl: event.target.value }); }}
            onBlur={onBlurUrl}
          />
        </div>
        {errors.baseUrl !== undefined && <p id={urlErrorId} className={styles.fieldError}>{errors.baseUrl}</p>}
        {urlHint !== undefined && <p id={urlHintId} className={styles.fieldHint}>{urlHint}</p>}
      </div>

      {keySlot}

      <details
        className={styles.advanced}
        open={advancedOpen}
        onToggle={(event) => { setAdvancedOpen(event.currentTarget.open); }}
      >
        <summary className={styles.advancedSummary}>Advanced</summary>
        <div className={styles.advancedBody}>
          <fieldset className={styles.choiceGroup} disabled={disabled}>
            <legend className={styles.fieldLabel}>Protocol</legend>
            <div className={styles.choices}>
              {PROTOCOLS.map(({ value, label }) => (
                <label key={value} className={styles.choice}>
                  <input
                    type="radio"
                    name={`${urlId}-protocol`}
                    checked={draft.protocol === value}
                    onChange={() => { onChange({ protocol: value }); }}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {draft.protocol === 'openai-compatible' && (
            <fieldset className={styles.choiceGroup} disabled={disabled} aria-describedby={tokenHintId}>
              <legend className={styles.fieldLabel}>Output limit field</legend>
              <div className={styles.choices}>
                {TEXT_TOKEN_FIELDS.map((value) => (
                  <label key={value} className={styles.choice}>
                    <input
                      type="radio"
                      name={`${urlId}-token-field`}
                      checked={draft.tokenField === value}
                      onChange={() => { onChange({ tokenField: value }); }}
                    />
                    <span className={styles.monoLabel}>{value}</span>
                  </label>
                ))}
              </div>
              <p id={tokenHintId} className={styles.fieldHint}>
                OpenAI uses max_completion_tokens. Most local and older servers expect max_tokens.
              </p>
            </fieldset>
          )}

          <div className={styles.field}>
            <label className={styles.choice} htmlFor={listId}>
              <input
                id={listId}
                type="checkbox"
                checked={draft.listModels}
                disabled={disabled}
                aria-describedby={listHintId}
                onChange={(event) => { onChange({ listModels: event.target.checked }); }}
              />
              <span>Check the model list</span>
            </label>
            <p id={listHintId} className={styles.fieldHint}>
              Atelier reads the server’s model list to test the connection and to show which models are online.
            </p>
          </div>

          {!draft.listModels && (
            <div className={styles.field}>
              <label htmlFor={probeId} className={styles.fieldLabel}>Model to test with</label>
              <div className={styles.inputBox}>
                <input
                  id={probeId}
                  className={styles.monoInput}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={draft.probeModelId}
                  disabled={disabled}
                  aria-invalid={errors.probeModelId !== undefined ? true : undefined}
                  aria-describedby={describedBy(errors.probeModelId !== undefined && probeErrorId)}
                  onChange={(event) => { onChange({ probeModelId: event.target.value }); }}
                />
              </div>
              {errors.probeModelId !== undefined && <p id={probeErrorId} className={styles.fieldError}>{errors.probeModelId}</p>}
            </div>
          )}
        </div>
      </details>
    </>
  );
}
