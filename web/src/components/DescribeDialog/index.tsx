import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { runWhenReachable } from '../../lib/focus';
import { useExitTransition } from '../../hooks/useExitTransition';
import { DialogShell } from '../DialogShell';
import btn from '../../styles/buttons.module.css';
import styles from '../../styles/dialog.module.css';
import local from './index.module.css';

export interface DescribeDialogProps {
  sectionLabel: string;
  title: string;
  body: string;
  fieldLabel: string;
  placeholder: string;
  maxLength: number;
  submitLabel: string;
  busyLabel?: string;
  busy: boolean;
  error?: string | null;
  /** The field may be left blank; submitting then passes ''. */
  optional?: boolean;
  /** Text the field starts with (on mount only). */
  initialText?: string;
  /** Extra controls rendered between the body copy and the field. */
  children?: ReactNode;
  onSubmit: (description: string) => void;
  onCancel: () => void;
}

// Shared scaffold for the "describe X for the AI" prompt dialogs (list seed,
// template seed/clarify, character-card steering). Owns focus-on-mount, the trimmed canSubmit gate,
// Cmd/Ctrl+Enter submit, the optional polite inline error, and the DialogShell
// skeleton. Callers supply only the copy + limits.
export function DescribeDialog({
  sectionLabel,
  title,
  body,
  fieldLabel,
  placeholder,
  maxLength,
  submitLabel,
  busyLabel = 'Generating…',
  busy,
  error = null,
  optional = false,
  initialText = '',
  children,
  onSubmit,
  onCancel,
}: DescribeDialogProps) {
  // Dismissals play the shared exit before the parent unmounts the dialog.
  const { closing, requestClose } = useExitTransition(onCancel);
  const titleId = useId();
  const bodyId = useId();
  const labelId = useId();
  const errorId = useId();
  const hintId = useId();
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState(initialText);
  // Reset the field when `body` (the seed copy or the clarify question) changes
  // to a NEW value: the dialog stays mounted across submits (so its inline error
  // shows), so without this the previous answer would linger under the next
  // clarify question. A submit FAILURE leaves `body` unchanged, so the user's
  // answer is preserved for retry. Render-time reset (React's "adjust state on
  // prop change" pattern) rather than an effect.
  const [prevBody, setPrevBody] = useState(body);
  if (body !== prevBody) {
    setPrevBody(body);
    setText('');
  }
  const canSubmit = (optional || text.trim().length > 0) && !busy;

  // Focus the field on mount and whenever a new question swaps in.
  useEffect(() => {
    const target = areaRef.current;
    runWhenReachable(() => { target?.focus(); }, target);
    return undefined;
  }, [body]);

  const submit = () => {
    // Escape then Cmd/Ctrl+Enter during the exit fade must not start a draft.
    if (closing || !canSubmit) return;
    onSubmit(text.trim());
  };

  return (
    <DialogShell open onCancel={() => { if (!busy) requestClose(); }} closing={closing} busy={busy} labelledBy={titleId} describedBy={bodyId}>
      <div className={styles.dialog}>
        <div className={styles.handle} aria-hidden="true" />
        <div className={styles.label}>{sectionLabel}</div>
        <h2 id={titleId} className={styles.title}>{title}</h2>
        <p id={bodyId} className={styles.body}>{body}</p>

        {children}

        <div className={styles.inputRow}>
          <label className="srOnly" id={labelId} htmlFor={`${labelId}-area`}>
            {fieldLabel}
          </label>
          <textarea
            ref={areaRef}
            id={`${labelId}-area`}
            className={local.textarea}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={text}
            maxLength={maxLength}
            disabled={busy}
            onChange={(event) => { setText(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>

        {error && (
          // Draft generation can be retried from the same field, so keep it polite.
          <div id={errorId} role="status" aria-live="polite" className={styles.inlineError}>{error}</div>
        )}

        <div className={styles.actions}>
          <span id={hintId} className={local.hint}>Press ⌘/Ctrl + Enter to submit</span>
          <div className={styles.actionsRight}>
            <button type="button" className={btn.secondary} onClick={() => { if (!busy) requestClose(); }} disabled={busy}>
              Cancel
            </button>
            <button type="button" className={btn.primary} onClick={submit} disabled={!canSubmit}>
              {busy ? busyLabel : submitLabel}
            </button>
          </div>
        </div>

        {busy && <div className={styles.progressBar} aria-hidden="true" />}
      </div>
    </DialogShell>
  );
}
