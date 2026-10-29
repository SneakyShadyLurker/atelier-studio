import { useEffect, useId, useRef } from 'react';
import { useKeyboardScopeActive } from '../../hooks/useKeyboard';
import { useExitTransition } from '../../hooks/useExitTransition';
import { runWhenReachable } from '../../lib/focus';
import { moderationCopy, useModerationNotice } from '../../lib/moderationNotice';
import { DialogShell } from '../DialogShell';
import { I } from '../icons/I';
import buttons from '../../styles/buttons.module.css';
import dialog from '../../styles/dialog.module.css';
import styles from './index.module.css';

export default function ModerationNotice() {
  const notice = useModerationNotice((state) => state.notice);
  const dismiss = useModerationNotice((state) => state.dismiss);
  const titleId = useId();
  const bodyId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const open = notice !== null;
  const { closing, requestClose } = useExitTransition(dismiss, open);
  useKeyboardScopeActive('confirm-open', open && !closing);
  // Tab containment is the native showModal() modal's (DialogShell); only the
  // initial focus target is ours: the close control, as before.
  useEffect(() => {
    if (!open) return;
    const target = closeRef.current;
    runWhenReachable(() => { target?.focus(); }, target);
  }, [open]);
  if (!notice) return null;
  const copy = moderationCopy(notice);

  return (
    <DialogShell open={open} onCancel={requestClose} closing={closing} labelledBy={titleId} describedBy={bodyId}>
      <div className={`${dialog.dialog} ${styles.card}`} data-moderation-notice>
        <div className={dialog.handle} aria-hidden="true" />
        <div className={styles.header}>
          <span className={styles.eyebrow}>Atelier content check</span>
          <button ref={closeRef} type="button" className={styles.close} aria-label="Close content check" onClick={requestClose}>
            <I.close />
          </button>
        </div>
        <div className={styles.heading}>
          <span className={styles.symbol} aria-hidden="true"><I.alert /></span>
          <h2 id={titleId} className={dialog.title}>{copy.title}</h2>
        </div>
        <div id={bodyId} className={styles.content}>
          {copy.details.map((detail) => (
            <section key={detail.key} className={styles.reason}>
              <h3 className={styles.category}>{detail.label}</h3>
              <p className={styles.explanation}>{detail.explanation}</p>
              <p className={styles.guidance}>{detail.guidance}</p>
            </section>
          ))}
        </div>
        <div className={styles.footer}>
          <p className={styles.delivery}>{copy.delivery}</p>
          <button type="button" className={`${buttons.primary} ${styles.returnButton}`} onClick={requestClose}>
            Back to my input
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
