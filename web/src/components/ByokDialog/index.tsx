import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { describeError } from '../../lib/errorCopy';
import { useDeleteKey } from '../../hooks/useDeleteKey';
import { useKeyStatus } from '../../hooks/useKeyStatus';
import { useSetKey } from '../../hooks/useSetKey';
import { useExitTransition } from '../../hooks/useExitTransition';
import { useAtelierStore } from '../../store/atelier';
import ConfirmDialog from '../ConfirmDialog';
import { DialogShell } from '../DialogShell';
import btn from '../../styles/buttons.module.css';
import styles from '../../styles/dialog.module.css';

const AI_STUDIO_URL = 'https://aistudio.google.com/apikey';
const MIN_KEY_LENGTH = 20;

export function ByokDialog() {
  const open = useAtelierStore((state) => state.byokOpen);
  if (!open) return null;
  return <ByokDialogInner />;
}

function ByokDialogInner() {
  const close = useAtelierStore((state) => state.closeByok);
  // Dismissals play the shared exit; save/remove successes close instantly.
  const { closing, requestClose } = useExitTransition(close);
  const status = useKeyStatus('google');
  const setKey = useSetKey('google');
  const deleteKey = useDeleteKey('google');
  const [draft, setDraft] = useState('');
  const [show, setShow] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const replaceBtnRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const errorId = useId();
  const busy = setKey.isPending;
  const key = draft.trim();
  const hasStoredKey = status.data?.present === true;
  const present = hasStoredKey && !replacing;
  const canSave = key.length >= MIN_KEY_LENGTH && !busy;
  const inlineErrorBlocksForm = inlineError === "BYOK isn't configured on this server.";

  useEffect(() => {
    if (status.data?.present === false || replacing) inputRef.current?.focus();
  }, [replacing, status.data?.present]);

  useEffect(() => {
    if (present) replaceBtnRef.current?.focus();
  }, [present]);

  // A dismissed dialog keeps focus through its exit fade; Escape then Enter
  // on a focused action must neither store nor remove the key.
  const save = () => {
    if (closing || !canSave) return;
    setInlineError(null);
    setKey.mutate(key, {
      onSuccess: () => {
        close();
      },
      onError: (error) => {
        // A code-less 503 from the keys route means BYOK is not configured
        // server-side (permanent), distinct from describeError's generic
        // "temporarily unavailable". A 503 *with* a GOOGLE_* code is a
        // verification failure — let describeError map it by code.
        if (error instanceof ApiError && error.status === 503) {
          const code =
            error.body && typeof error.body === 'object'
              ? (error.body as { code?: unknown }).code
              : undefined;
          if (typeof code !== 'string') {
            setInlineError("BYOK isn't configured on this server.");
            return;
          }
        }
        setInlineError(describeError(error, "Couldn't reach the server. Try again."));
      },
    });
  };

  const remove = () => {
    if (closing) return;
    deleteKey.mutate(undefined, {
      onSuccess: () => {
        setConfirmRemove(false);
        setReplacing(false);
        setDraft('');
        close();
      },
      onError: (error) => {
        setInlineError(describeError(error, "Couldn't remove the key. Try again."));
      },
    });
  };

  const masked = status.data?.fingerprint ? `AIza${'•'.repeat(12)}${status.data.fingerprint}` : 'AIza••••';

  return (
    <>
      <DialogShell
        open
        onCancel={() => { if (!busy && !confirmRemove) requestClose(); }}
        closing={closing}
        busy={busy}
        labelledBy={titleId}
        describedBy={bodyId}
      >
        <div className={styles.dialog}>
          <div className={styles.handle} aria-hidden="true" />
          <div className={styles.label}>GOOGLE API KEY</div>
          <h2 id={titleId} className={styles.title}>
            {present ? 'Google API key' : 'Add your Google API key'}
          </h2>
          <p id={bodyId} className={styles.body}>
            Unlocks Nano Banana Pro, Nano Banana 2, and Nano Banana 2 Lite. Stored encrypted, scoped to your account.{' '}
            <a className={styles.docLink} href={AI_STUDIO_URL} target="_blank" rel="noopener noreferrer">
              Where do I get one?
            </a>
          </p>

          {present ? (
            <div className={styles.maskedRow}>
              <span className={styles.masked}>{masked}</span>
              <button
                type="button"
                ref={replaceBtnRef}
                className={styles.linkBtn}
                onClick={() => {
                  setInlineError(null);
                  setReplacing(true);
                }}
              >
                Replace
              </button>
            </div>
          ) : (
            <div className={styles.inputRow}>
              <input
                ref={inputRef}
                aria-label="Google API key"
                aria-invalid={inlineError ? true : undefined}
                aria-describedby={inlineError ? errorId : undefined}
                className={styles.input}
                type={show ? 'text' : 'password'}
                inputMode="text"
                // `new-password` is honored more reliably than `off` for
                // credential-shaped fields, and the data-* opt-outs suppress
                // 1Password/LastPass capture of the BYOK key.
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="AIza..."
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setInlineError(null);
                }}
                disabled={busy}
              />
              <button
                type="button"
                aria-label={show ? 'Hide API key' : 'Show API key'}
                className={styles.linkBtn}
                onClick={() => { setShow((value) => !value); }}
                disabled={busy}
              >
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
          )}

          {inlineError && (
            // Server BYOK misconfiguration blocks the dialog; validation errors remain polite.
            <div id={errorId} role={inlineErrorBlocksForm ? 'alert' : 'status'} aria-live={inlineErrorBlocksForm ? 'assertive' : 'polite'} className={styles.inlineError}>
              {inlineError}
            </div>
          )}

          <div className={styles.actions}>
            {hasStoredKey && (
              <button
                type="button"
                className={btn.danger}
                onClick={() => { if (!closing) setConfirmRemove(true); }}
                disabled={busy}
              >
                Remove Key
              </button>
            )}
            <div className={styles.actionsRight}>
              <button
                type="button"
                className={btn.secondary}
                onClick={() => {
                  if (!busy) requestClose();
                }}
                disabled={busy}
              >
                Cancel
              </button>
              {!present && (
                <button type="button" className={btn.primary} onClick={save} disabled={!canSave}>
                  {busy ? 'Saving...' : 'Save Key'}
                </button>
              )}
            </div>
          </div>

          {busy && <div className={styles.progressBar} aria-hidden="true" />}
        </div>
      </DialogShell>

      <ConfirmDialog
        open={confirmRemove}
        title="Remove your Google key?"
        body="The Gemini models will go back to read-only."
        confirmLabel="Remove"
        cancelLabel="Cancel"
        danger
        closeOnBackdrop={false}
        onConfirm={remove}
        onCancel={() => { setConfirmRemove(false); }}
      />
    </>
  );
}

export default ByokDialog;
