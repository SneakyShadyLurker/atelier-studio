import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { AdminProvider, TextPreset, TextProviderConnectionTestRequest } from '@atelier/shared';
import { TEXT_PRESETS } from '@atelier/shared';
import { testDraftConnection, type ProviderCreateBody } from '../../api/textProviders';
import { useExitTransition } from '../../hooks/useExitTransition';
import { useCreateProvider } from '../../hooks/useTextProviders';
import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import { DialogShell } from '../DialogShell';
import btn from '../../styles/buttons.module.css';
import dialogStyles from '../../styles/dialog.module.css';
import {
  ApiKeyInput,
  BYOK_MISSING_COPY,
  ConnectionResult,
  connectionFailure,
  describedBy,
  draftErrors,
  isByokRefusal,
  normalizedUrl,
  ProviderFields,
  type ConnectionState,
  type DraftErrors,
  type ProviderDraft,
} from './ProviderForm';
import styles from './AddProviderDialog.module.css';

const PRESET_URLS: ReadonlySet<string> = new Set(TEXT_PRESETS.map((preset) => preset.baseUrl));
const isCustom = (preset: TextPreset) => preset.baseUrl === '';

const EMPTY_DRAFT: ProviderDraft = {
  name: '',
  baseUrl: '',
  protocol: 'openai-compatible',
  tokenField: 'max_completion_tokens',
  listModels: true,
  probeModelId: '',
};

/**
 * Applies a preset: protocol, token field and listing always; the name and
 * address only when the admin has not typed their own (empty, or still the
 * previous preset's value). Custom presets suggest no name and no address.
 */
function applyPreset(draft: ProviderDraft, preset: TextPreset, previous: TextPreset | null): ProviderDraft {
  const nameIsSuggestion = draft.name.trim() === '' || (previous !== null && draft.name === previous.label);
  const urlIsSuggestion = draft.baseUrl.trim() === '' || PRESET_URLS.has(draft.baseUrl);
  return {
    ...draft,
    name: nameIsSuggestion ? (isCustom(preset) ? '' : preset.label) : draft.name,
    baseUrl: urlIsSuggestion ? preset.baseUrl : draft.baseUrl,
    protocol: preset.protocol,
    tokenField: preset.tokenField ?? draft.tokenField,
    listModels: preset.listModels,
  };
}

interface Connection {
  readonly body: TextProviderConnectionTestRequest;
  readonly signature: string;
}

/** What the test sends; any change to it makes an earlier report stale. */
function connectionOf(draft: ProviderDraft, apiKey: string): Connection {
  const key = apiKey.trim();
  const probe = draft.probeModelId.trim();
  const body: TextProviderConnectionTestRequest = {
    protocol: draft.protocol,
    baseUrl: normalizedUrl(draft.baseUrl),
    ...(key === '' ? {} : { apiKey: key }),
    ...(draft.protocol === 'openai-compatible' ? { tokenField: draft.tokenField } : {}),
    listModels: draft.listModels,
    ...(!draft.listModels && probe !== '' ? { probeModelId: probe } : {}),
  };
  return { body, signature: JSON.stringify(body) };
}

interface AddProviderDialogProps {
  /** The server reported `byok-not-configured`: keys cannot be stored. */
  readonly byokMissing: boolean;
  readonly onClose: () => void;
  /** The provider exists; the view moves straight on to adding its models. */
  readonly onSaved: (provider: AdminProvider) => void;
}

export default function AddProviderDialog({ byokMissing, onClose, onSaved }: AddProviderDialogProps) {
  const titleId = useId();
  const keyId = useId();
  const keyHintId = useId();
  const byokId = useId();
  const { closing, requestClose } = useExitTransition(onClose, true);
  const addToast = useAtelierStore((state) => state.addToast);
  const create = useCreateProvider();
  const test = useMutation({ mutationFn: testDraftConnection });

  const [preset, setPreset] = useState<TextPreset | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [apiKey, setApiKey] = useState('');
  const [byokRefused, setByokRefused] = useState(false);
  const [urlTouched, setUrlTouched] = useState(false);
  const [showErrors, setShowErrors] = useState<'test' | 'save' | null>(null);
  const [connection, setConnection] = useState<ConnectionState>({ kind: 'idle' });
  const [saveError, setSaveError] = useState<string | null>(null);

  const noKeys = byokMissing || byokRefused;
  const current = connectionOf(draft, noKeys ? '' : apiKey);
  const busy = create.isPending;
  const testing = connection.kind === 'running';
  // A report counts only for the settings it tested.
  const fresh = connection.kind === 'report' || connection.kind === 'error' ? connection.signature === current.signature : false;
  const shown: ConnectionState = fresh || testing ? connection : { kind: 'idle' };
  const report = shown.kind === 'report' ? shown.report : null;
  const passed = report?.ok === true;
  const saveAnyway = report !== null && !report.ok && report.listUnsupported === true;

  // Errors appear once they matter: the address after it is left, the rest
  // when the admin tries to test or save.
  const allErrors = draftErrors(draft, showErrors !== 'save');
  const visibleErrors: DraftErrors = {
    ...(showErrors === 'save' && allErrors.name !== undefined ? { name: allErrors.name } : {}),
    ...((urlTouched || showErrors !== null) && allErrors.baseUrl !== undefined ? { baseUrl: allErrors.baseUrl } : {}),
    ...(showErrors !== null && allErrors.probeModelId !== undefined ? { probeModelId: allErrors.probeModelId } : {}),
  };

  const change = (patch: Partial<ProviderDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setSaveError(null);
  };

  const choosePreset = (next: TextPreset) => {
    setDraft((previous) => applyPreset(previous, next, preset));
    setPreset(next);
    setSaveError(null);
  };

  const runTest = () => {
    setShowErrors('test');
    setUrlTouched(true);
    if (Object.keys(draftErrors(draft, true)).length > 0) return;
    const { body, signature } = current;
    setConnection({ kind: 'running' });
    test.mutateAsync(body)
      .then((result) => { setConnection({ kind: 'report', report: result, signature }); })
      .catch((error: unknown) => { setConnection(connectionFailure(error, signature)); });
  };

  const save = () => {
    if (busy || closing) return;
    setShowErrors('save');
    if (Object.keys(draftErrors(draft, false)).length > 0) return;
    const { apiKey: key, ...connectionBody } = current.body;
    const body: ProviderCreateBody = {
      name: draft.name.trim(),
      protocol: connectionBody.protocol,
      baseUrl: connectionBody.baseUrl,
      ...(preset === null ? {} : { preset: preset.id }),
      ...(key === undefined ? {} : { apiKey: key }),
      ...(connectionBody.tokenField === undefined ? {} : { tokenField: connectionBody.tokenField }),
      listModels: draft.listModels,
    };
    setSaveError(null);
    create.mutateAsync(body)
      .then((provider) => {
        addToast(`Saved ${provider.name}`);
        onSaved(provider);
      })
      .catch((error: unknown) => {
        if (isByokRefusal(error)) setByokRefused(true);
        else setSaveError(describeError(error, 'Couldn’t save the provider. Try again.'));
      });
  };

  const keyHint = preset !== null && !preset.keyRequired ? 'Optional for this preset.' : undefined;
  const keySlot = (
    <div className={styles.field}>
      <label htmlFor={keyId} className={styles.fieldLabel}>API key</label>
      <ApiKeyInput
        id={keyId}
        value={noKeys ? '' : apiKey}
        disabled={busy || noKeys}
        describedBy={describedBy(keyHint !== undefined && !noKeys && keyHintId, noKeys && byokId)}
        onChange={(value) => { setApiKey(value); setSaveError(null); }}
      />
      {noKeys ? (
        <p id={byokId} className={styles.fieldWarning} role={byokRefused ? 'alert' : undefined}>{BYOK_MISSING_COPY}</p>
      ) : keyHint !== undefined && <p id={keyHintId} className={styles.fieldHint}>{keyHint}</p>}
    </div>
  );

  return (
    <DialogShell open onCancel={() => { if (!busy) requestClose(); }} closing={closing} busy={busy} labelledBy={titleId}>
      <div className={`${dialogStyles.dialog} ${styles.dialog}`}>
        <div className={dialogStyles.handle} aria-hidden="true" />
        <h2 id={titleId} className={dialogStyles.title}>Add a provider</h2>

        <fieldset className={styles.choiceGroup} disabled={busy}>
          <legend className={styles.fieldLabel}>Preset</legend>
          <div className={styles.presets}>
            {TEXT_PRESETS.map((option) => (
              <label key={option.id} className={styles.preset}>
                <input
                  type="radio"
                  name={`${titleId}-preset`}
                  className={styles.presetInput}
                  checked={preset?.id === option.id}
                  onChange={() => { choosePreset(option); }}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <ProviderFields
          draft={draft}
          errors={visibleErrors}
          urlHint={preset?.hint}
          keySlot={keySlot}
          disabled={busy}
          onChange={change}
          onBlurUrl={() => { if (draft.baseUrl.trim() !== '') setUrlTouched(true); }}
        />

        <ConnectionResult state={shown} />
        {saveError !== null && <p role="alert" className={styles.fieldError}>{saveError}</p>}

        <div className={`${dialogStyles.actions} ${styles.actions}`}>
          <button type="button" className={`${btn.secondary} ${styles.testButton}`} onClick={runTest} disabled={busy || testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <div className={dialogStyles.actionsRight}>
            <button type="button" className={btn.secondary} onClick={() => { if (!busy) requestClose(); }} disabled={busy}>
              Cancel
            </button>
            {saveAnyway && (
              <button type="button" className={btn.secondary} onClick={save} disabled={busy}>Save anyway</button>
            )}
            <button type="button" className={btn.primary} onClick={save} disabled={busy || !passed}>
              {busy ? 'Saving…' : 'Save provider'}
            </button>
          </div>
        </div>
        {(busy || testing) && <div className={dialogStyles.progressBar} aria-hidden="true" />}
      </div>
    </DialogShell>
  );
}
