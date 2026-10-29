import { useEffect, useId, useRef } from 'react';
import { useKeyboardScopeActive, useKeyboardScoped } from '../../hooks/useKeyboard';
import { useExitTransition } from '../../hooks/useExitTransition';
import { DialogShell } from '../DialogShell';
import btn from '../../styles/buttons.module.css';
import styles from '../../styles/dialog.module.css';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  closeOnBackdrop?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = false,
  closeOnBackdrop = !danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const bodyId = useId();
  // Cancel/dismiss paths play the shared exit before the parent unmounts the
  // dialog; Confirm stays instant — action-driven dismissal should not lag.
  const { closing, requestClose } = useExitTransition(onCancel, open);

  // Scope drops during the exit fade so Enter can't fire Confirm on a dialog
  // the user already dismissed.
  const dialogLive = open && !closing;
  useKeyboardScopeActive('confirm-open', dialogLive);
  useKeyboardScoped('confirm-open', 'Enter', (event) => {
    if (!open || closing) return;
    // Only own these two controls. Other hosted actions (such as Undo) keep
    // native Enter activation without accepting or dismissing this dialog.
    const active = document.activeElement;
    if (active !== confirmRef.current && active !== cancelRef.current) return;
    event.preventDefault();
    if (active === confirmRef.current) onConfirm();
    else requestClose();
  }, dialogLive);

  // No inner focus trap: DialogShell's showModal() already contains focus —
  // including the toast it hosts, which a trap on the card would exclude.
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <DialogShell open={open} onCancel={requestClose} closing={closing} closeOnBackdrop={closeOnBackdrop} labelledBy={titleId} describedBy={bodyId}>
      <div className={styles.dialog}>
        <div className={styles.handle} aria-hidden="true" />
        <h2 id={titleId} className={styles.title}>{title}</h2>
        <p id={bodyId} className={styles.body}>{body}</p>
        <div className={styles.actions}>
          <div className={styles.actionsRight}>
            <button ref={cancelRef} type="button" className={btn.secondary} onClick={requestClose}>
              {cancelLabel}
            </button>
            <button ref={confirmRef} type="button" className={danger ? btn.danger : btn.primary} onClick={() => { if (!closing) onConfirm(); }}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </DialogShell>
  );
}
