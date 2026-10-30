import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { AdminProvider, TextModelUsage } from '@atelier/shared';
import { testSavedConnection, type ProviderPatchBody } from '../../api/textProviders';
import { useExitTransition } from '../../hooks/useExitTransition';
import { useDeleteProvider, useUpdateProvider } from '../../hooks/useTextProviders';
import { describeError } from '../../lib/errorCopy';
import { useAtelierStore } from '../../store/atelier';
import ConfirmDialog from '../ConfirmDialog';
import { DialogShell } from '../DialogShell';
import btn from '../../styles/buttons.module.css';
import dialogStyles from '../../styles/dialog.module.css';
import { joinWords, usagePhrases } from './ModelRow';
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

/** What a saved key becomes on Save: kept, replaced with new text, or removed. */
type KeyEdit =
  | { readonly kind: 'keep' }
  | { readonly kind: 'replace'; readonly value: string }
  | { readonly kind: 'remove' };

function draftOf(provider: AdminProvider): ProviderDraft {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    tokenField: provider.tokenField,
    listModels: provider.listModels,
    probeModelId: '',
  };
}

/** Only the fields that changed. */
function patchOf(provider: AdminProvider, draft: ProviderDraft, key: KeyEdit): ProviderPatchBody {
  const name = draft.name.trim();
  const baseUrl = normalizedUrl(draft.baseUrl);
  const typed = key.kind === 'replace' ? key.value.trim() : '';
  return {
    ...(name === provider.name ? {} : { name }),
    ...(baseUrl === provider.baseUrl ? {} : { baseUrl }),
    ...(draft.protocol === provider.protocol ? {} : { protocol: draft.protocol }),
    ...(draft.tokenField === provider.tokenField ? {} : { tokenField: draft.tokenField }),
    ...(draft.listModels === provider.listModels ? {} : { listModels: draft.listModels }),
    ...(typed === '' ? {} : { apiKey: typed }),
    ...(key.kind === 'remove' ? { apiKey: null } : {}),
  };
}

/** Every model's usage merged: what deleting the provider would reroute. */
function mergedUsage(provider: AdminProvider): TextModelUsage {
  const usages = provider.models.map((model) => model.usage);
  return {
    isDefault: usages.some((usage) => usage.isDefault),
    tasks: [...new Set(usages.flatMap((usage) => usage.tasks))],
    writers: [...new Set(usages.flatMap((usage) => usage.writers))],
    userPicks: usages.reduce((sum, usage) => sum + usage.userPicks, 0),
  };
}

function deleteCopy(provider: AdminProvider, imageLabel: (id: string) => string): string {
  const count = provider.models.length;
  if (count === 0) return 'It has no models. Nothing else changes.';
  const models = count === 1 ? 'Its one model goes with it.' : `Its ${count} models go with it.`;
  const parts = usagePhrases(mergedUsage(provider), imageLabel);
  if (parts.length === 0) return `${models} Nothing uses them right now.`;
  const subject = count === 1 ? 'It is' : 'Between them they are';
  return `${models} ${subject} ${joinWords(parts)}. Those will fall back to the next model in line.`;
}

interface EditProviderDialogProps {
  readonly provider: AdminProvider;
  readonly imageLabel: (id: string) => string;
  readonly onClose: () => void;
}

export default function EditProviderDialog({ provider, imageLabel, onClose }: EditProviderDialogProps) {
  const titleId = useId();
  const keyId = useId();
  const byokId = useId();
  const staleId = useId();
  const { closing, requestClose } = useExitTransition(onClose, true);
  const addToast = useAtelierStore((state) => state.addToast);
  const update = useUpdateProvider();
  const remove = useDeleteProvider();
  const test = useMutation({
    mutationFn: ({ id, probeModelId }: { id: string; probeModelId?: string }) => testSavedConnection(id, probeModelId),
  });

  const [draft, setDraft] = useState<ProviderDraft>(() => draftOf(provider));
  const [key, setKey] = useState<KeyEdit>({ kind: 'keep' });
  const [byokRefused, setByokRefused] = useState(false);
  const [urlTouched, setUrlTouched] = useState(false);
  const [showErrors, setShowErrors] = useState<'test' | 'save' | null>(null);
  const [connection, setConnection] = useState<ConnectionState>({ kind: 'idle' });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const busy = update.isPending || remove.isPending;
  const testing = connection.kind === 'running';
  const noKeys = byokRefused || provider.warnings.includes('byok-not-configured');
  const patch = patchOf(provider, draft, key);
  const dirty = Object.keys(patch).length > 0;
  // The saved-provider test probes what is stored, not this form.
  const { name: _name, ...connectionPatch } = patch;
  const unsavedConnection = Object.keys(connectionPatch).length > 0;

  const allErrors = draftErrors(draft, showErrors === 'test');
  const visibleErrors: DraftErrors = {
    ...(showErrors === 'save' && allErrors.name !== undefined ? { name: allErrors.name } : {}),
    ...((urlTouched || showErrors === 'save') && allErrors.baseUrl !== undefined ? { baseUrl: allErrors.baseUrl } : {}),
    ...(showErrors === 'test' && allErrors.probeModelId !== undefined ? { probeModelId: allErrors.probeModelId } : {}),
  };

  const change = (next: Partial<ProviderDraft>) => {
    setDraft((previous) => ({ ...previous, ...next }));
    setSaveError(null);
  };

  const runTest = () => {
    // The saved settings decide; only the probe model comes from the form.
    const probe = draft.probeModelId.trim();
    if (!provider.listModels && probe === '') {
      setShowErrors('test');
      return;
    }
    setConnection({ kind: 'running' });
    test.mutateAsync({ id: provider.id, ...(provider.listModels || probe === '' ? {} : { probeModelId: probe }) })
      .then((report) => { setConnection({ kind: 'report', report, signature: '' }); })
      .catch((error: unknown) => { setConnection(connectionFailure(error, '')); });
  };

  const save = () => {
    if (busy || closing || !dirty) return;
    setShowErrors('save');
    setUrlTouched(true);
    if (Object.keys(draftErrors(draft, false)).length > 0) return;
    setSaveError(null);
    update.mutateAsync({ id: provider.id, patch })
      .then((saved) => {
        addToast(`Saved ${saved.name}`);
        onClose();
      })
      .catch((error: unknown) => {
        if (isByokRefusal(error)) {
          setByokRefused(true);
          setKey({ kind: 'keep' });
        } else {
          setSaveError(describeError(error, 'Couldn’t save the provider. Try again.'));
        }
      });
  };

  const confirmRemove = () => {
    setConfirmDelete(false);
    remove.mutateAsync(provider.id)
      .then(() => {
        addToast(`Deleted ${provider.name}`);
        onClose();
      })
      .catch((error: unknown) => {
        setSaveError(describeError(error, `Couldn’t delete ${provider.name}. Try again.`));
      });
  };

  const byokNote = noKeys && (
    <p id={byokId} className={styles.fieldWarning} role={byokRefused ? 'alert' : undefined}>{BYOK_MISSING_COPY}</p>
  );

  let keySlot;
  if (provider.auth === 'env') {
    keySlot = (
      <div className={styles.field}>
        <p className={styles.fieldLabel}>API key</p>
        <p className={styles.keyRow}>
          <span>Read from <span className={styles.mono}>{provider.envVar ?? 'the server environment'}</span></span>
        </p>
      </div>
    );
  } else if (provider.auth === 'stored' && key.kind !== 'replace') {
    keySlot = (
      <div className={styles.field}>
        <p className={styles.fieldLabel}>API key</p>
        <div className={styles.keyRow}>
          {key.kind === 'remove' ? (
            <>
              <span>The key is removed when you save.</span>
              <button type="button" className={styles.linkBtn} disabled={busy} onClick={() => { setKey({ kind: 'keep' }); }}>Keep key</button>
            </>
          ) : (
            <>
              <span className={styles.mono}>{`••••${(provider.fingerprint ?? '').slice(-4)}`}</span>
              <button type="button" className={styles.linkBtn} disabled={busy || noKeys} onClick={() => { setKey({ kind: 'replace', value: '' }); }}>
                Replace key
              </button>
              <button type="button" className={styles.linkBtn} disabled={busy} onClick={() => { setKey({ kind: 'remove' }); }}>Remove key</button>
            </>
          )}
        </div>
        {byokNote}
      </div>
    );
  } else {
    keySlot = (
      <div className={styles.field}>
        <label htmlFor={keyId} className={styles.fieldLabel}>API key</label>
        <ApiKeyInput
          id={keyId}
          value={key.kind === 'replace' && !noKeys ? key.value : ''}
          disabled={busy || noKeys}
          describedBy={describedBy(noKeys && byokId)}
          onChange={(value) => { setKey({ kind: 'replace', value }); setSaveError(null); }}
        />
        {byokNote}
        {provider.auth === 'stored' && (
          <button type="button" className={styles.linkBtn} disabled={busy} onClick={() => { setKey({ kind: 'keep' }); }}>Keep the saved key</button>
        )}
      </div>
    );
  }

  return (
    <>
      <DialogShell
        open
        onCancel={() => { if (!busy && !confirmDelete) requestClose(); }}
        closing={closing}
        busy={busy}
        labelledBy={titleId}
      >
        <div className={`${dialogStyles.dialog} ${styles.dialog}`}>
          <div className={dialogStyles.handle} aria-hidden="true" />
          <h2 id={titleId} className={dialogStyles.title}>{`Edit ${provider.name}`}</h2>

          <ProviderFields
            draft={draft}
            errors={visibleErrors}
            keySlot={keySlot}
            disabled={busy}
            onChange={change}
            onBlurUrl={() => { setUrlTouched(true); }}
          />

          {unsavedConnection && (
            <p id={staleId} className={styles.fieldHint}>
              Test connection checks the saved settings. Save first to test your changes.
            </p>
          )}
          <ConnectionResult state={connection} />
          {saveError !== null && <p role="alert" className={styles.fieldError}>{saveError}</p>}

          <div className={`${dialogStyles.actions} ${styles.actions}`}>
            <button
              type="button"
              className={btn.secondary}
              onClick={runTest}
              disabled={busy || testing}
              aria-describedby={unsavedConnection ? staleId : undefined}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button type="button" className={btn.danger} onClick={() => { if (!closing) setConfirmDelete(true); }} disabled={busy}>
              Delete provider…
            </button>
            <div className={dialogStyles.actionsRight}>
              <button type="button" className={btn.secondary} onClick={() => { if (!busy) requestClose(); }} disabled={busy}>
                Cancel
              </button>
              <button type="button" className={btn.primary} onClick={save} disabled={busy || !dirty}>
                {update.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
          {(busy || testing) && <div className={dialogStyles.progressBar} aria-hidden="true" />}
        </div>
      </DialogShell>

      <ConfirmDialog
        open={confirmDelete}
        danger
        title={`Delete ${provider.name}?`}
        body={deleteCopy(provider, imageLabel)}
        confirmLabel="Delete provider"
        cancelLabel="Cancel"
        onConfirm={confirmRemove}
        onCancel={() => { setConfirmDelete(false); }}
      />
    </>
  );
}
