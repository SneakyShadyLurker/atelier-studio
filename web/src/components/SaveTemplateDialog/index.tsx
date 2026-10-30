import { useEffect, useId, useRef, useState } from 'react';
import { PROMPT_LIBRARY_NAME_MAX_CHARS } from '@atelier/shared/prompt-limits';
import { ApiError } from '../../api/client';
import { useCreateTemplate } from '../../hooks/usePromptMutations';
import { useExitTransition } from '../../hooks/useExitTransition';
import { runWhenReachable } from '../../lib/focus';
import { isImeComposing } from '../../lib/ime';
import { useAtelierStore } from '../../store/atelier';
import { DialogShell } from '../DialogShell';
import { deriveTemplateName } from './deriveTemplateName';
import btn from '../../styles/buttons.module.css';
import styles from '../../styles/dialog.module.css';
import local from './index.module.css';

export default function SaveTemplateDialog() {
  const prompt = useAtelierStore((state) => state.saveTemplatePrompt);
  if (prompt === null) return null;
  return <SaveTemplateDialogInner prompt={prompt} />;
}

function messageForError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    if (error.message === 'name already used') return 'A template with that name already exists.';
    if (error.message === 'template body too large') return 'This prompt is too long to save as a template.';
    return "You've reached the template limit.";
  }
  return 'Couldn’t reach the server. Try again.';
}

function SaveTemplateDialogInner({ prompt }: { prompt: string }) {
  const close = useAtelierStore((state) => state.closeSaveTemplate);
  // Dismissals play the shared exit; the post-save close stays instant
  // (action-driven dismissal — the toast is the feedback).
  const { closing, requestClose } = useExitTransition(close);
  const addToast = useAtelierStore((state) => state.addToast);
  const create = useCreateTemplate();
  const labelId = useId();
  const titleId = useId();
  const bodyId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(() => deriveTemplateName(prompt));
  const [inlineError, setInlineError] = useState<string | null>(null);
  const busy = create.isPending;
  const canSave = name.trim().length > 0 && name.trim().length <= PROMPT_LIBRARY_NAME_MAX_CHARS && !busy;

  useEffect(() => {
    const target = inputRef.current;
    runWhenReachable(() => {
      target?.focus();
      target?.select();
    }, target);
    return undefined;
  }, []);

  const save = () => {
    // Escape then Enter during the exit fade must not save.
    if (closing || !canSave) return;
    setInlineError(null);
    create.mutate(
      { name: name.trim(), body: prompt },
      {
        onSuccess: () => {
          close();
          addToast('Saved to templates');
        },
        onError: (error) => { setInlineError(messageForError(error)); },
      },
    );
  };

  return (
    <DialogShell open onCancel={() => { if (!busy) requestClose(); }} closing={closing} busy={busy} labelledBy={titleId} describedBy={bodyId}>
      <div className={styles.dialog}>
        <div className={styles.handle} aria-hidden="true" />
        <div className={styles.label}>SAVE TO TEMPLATES</div>
        <h2 id={titleId} className={styles.title}>Save prompt as template</h2>
        <p id={bodyId} className={styles.body}>
          Adds this prompt to your Templates library so you can reuse it anytime.
        </p>

        <div className={styles.inputRow}>
          <label className="srOnly" id={labelId} htmlFor={`${labelId}-input`}>
            Template name
          </label>
          <input
            ref={inputRef}
            id={`${labelId}-input`}
            aria-invalid={inlineError ? true : undefined}
            aria-describedby={inlineError ? errorId : undefined}
            className={styles.input}
            type="text"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Name this template"
            onKeyDown={(event) => { if (event.key === 'Enter' && !isImeComposing(event)) { event.preventDefault(); save(); } }}
            value={name}
            maxLength={PROMPT_LIBRARY_NAME_MAX_CHARS}
            onChange={(event) => {
              setName(event.target.value);
              setInlineError(null);
            }}
            disabled={busy}
          />
        </div>

        <div className={styles.label}>PROMPT</div>
        <pre className={local.preview} aria-label="Prompt to be saved">{prompt}</pre>

        {inlineError && (
          // Template save errors are recoverable edits, so announce without interrupting.
          <div id={errorId} role="status" aria-live="polite" className={styles.inlineError}>{inlineError}</div>
        )}

        <div className={styles.actions}>
          <div className={styles.actionsRight}>
            <button
              type="button"
              className={btn.secondary}
              onClick={() => { if (!busy) requestClose(); }}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="button" className={btn.primary} onClick={save} disabled={!canSave}>
              {busy ? 'Saving…' : 'Save template'}
            </button>
          </div>
        </div>

        {busy && <div className={styles.progressBar} aria-hidden="true" />}
      </div>
    </DialogShell>
  );
}
