import { useEffect, useEffectEvent, useId, useState, type ReactNode, type RefObject } from 'react';
import { isImeComposing } from '../../lib/ime';
import btn from '../../styles/buttons.module.css';
import { Disclosure } from '../Disclosure';
import { I } from '../icons/I';
import styles from './TemplateReview/index.module.css';

/*
 * The parts the AI reviews share: the head with its bulk decisions and
 * navigation, a painted mark, a change's note row, the unplaced-suggestions disclosure, the
 * keyboard hint and the form-scoped shortcuts. The template review's
 * stylesheet owns every class used here.
 */

export const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

export const plural = (count: number, one: string, many: string) => `${String(count)} ${count === 1 ? one : many}`;

/** The polite announcement after a decision. */
export function countAnnouncement(accepted: number, rejected: number): string {
  return `${plural(accepted, 'change', 'changes')} to apply, ${String(rejected)} rejected`;
}

export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
}

interface ReviewHeadProps {
  summary: string | null;
  total: number;
  acceptedCount: number;
  /** Index of the current change, zero-based. */
  current: number;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onPrevious: () => void;
  onNext: () => void;
  acceptAllRef: RefObject<HTMLButtonElement | null>;
  rejectAllRef: RefObject<HTMLButtonElement | null>;
}

interface BulkActionProps {
  ref: RefObject<HTMLButtonElement | null>;
  shown: boolean;
  onClick: () => void;
  children: string;
}

function BulkAction({ ref, shown, onClick, children }: BulkActionProps) {
  return (
    <button
      type="button"
      ref={ref}
      className={styles.textAction}
      data-shown={shown ? 'true' : 'false'}
      aria-hidden={shown ? undefined : true}
      inert={!shown}
      onClick={() => { if (shown) onClick(); }}
    >
      {children}
    </button>
  );
}

export function ReviewHead({
  summary,
  total,
  acceptedCount,
  current,
  onAcceptAll,
  onRejectAll,
  onPrevious,
  onNext,
  acceptAllRef,
  rejectAllRef,
}: ReviewHeadProps) {
  return (
    <div className={styles.head}>
      <span className={styles.label}>Review</span>
      {summary !== null && summary !== '' && <p className={styles.summary}>{summary}</p>}
      <div className={styles.tools}>
        {/* Both stay laid out: an action that does not apply is hidden in its
            slot, so a decision never changes the head's width or line count
            and nothing below it moves. */}
        <BulkAction ref={acceptAllRef} shown={acceptedCount < total} onClick={onAcceptAll}>Accept all</BulkAction>
        <BulkAction ref={rejectAllRef} shown={acceptedCount > 0} onClick={onRejectAll}>Reject all</BulkAction>
        <button
          type="button"
          className={`${btn.iconAction} ${styles.nav}`}
          aria-label="Previous change"
          aria-disabled={current === 0}
          data-tip="Previous change"
          onClick={onPrevious}
        >
          <I.caret className={styles.up} />
        </button>
        <span className={styles.count}>{`${String(current + 1)} / ${String(total)}`}</span>
        <button
          type="button"
          className={`${btn.iconAction} ${styles.nav}`}
          aria-label="Next change"
          aria-disabled={current >= total - 1}
          data-tip="Next change"
          onClick={onNext}
        >
          <I.caret />
        </button>
      </div>
    </div>
  );
}

/** One painted run. The painted span stays put across decisions, so its tint
 *  eases; only while accepted does it hold the semantic del/ins. */
export function Mark({ kind, accepted, text }: { kind: 'del' | 'ins'; accepted: boolean; text: string }) {
  if (kind === 'del') {
    return (
      <span className={styles.del}>
        {accepted ? <del><span className="srOnly">deleted: </span>{text}</del> : text}
      </span>
    );
  }
  return (
    <span className={styles.ins}>
      {accepted ? <ins><span className="srOnly">inserted: </span>{text}</ins> : text}
    </span>
  );
}

/** The fields a note row reads from a change. */
export interface NotedChange {
  readonly id: number;
  readonly why: string;
}

interface NoteRowProps {
  change: NotedChange;
  accepted: boolean;
  current: boolean;
  reasonId: string;
  onToggle: () => void;
}

export function NoteRow({ change, accepted, current, reasonId, onToggle }: NoteRowProps) {
  return (
    <div className={styles.note} data-current={current ? 'true' : undefined} data-note-id={change.id}>
      <span className={styles.num} aria-hidden="true">{change.id + 1}</span>
      <span className={styles.why}>
        <span id={reasonId}>
          {change.why}
          {!accepted && <span className="srOnly"> Rejected.</span>}
        </span>
        {change.why === '' ? null : ' '}
        {/* Always laid out, shown only while rejected: the word must not add a
            line to the note when a decision flips (nothing moves, R4.5). */}
        <span className={styles.state} data-shown={accepted ? 'false' : 'true'} aria-hidden="true">Rejected</span>
      </span>
      <button type="button" className={styles.act} aria-describedby={reasonId} onClick={onToggle}>
        <span aria-hidden={!accepted} data-shown={accepted ? 'true' : 'false'}>Reject</span>
        <span aria-hidden={accepted} data-shown={accepted ? 'false' : 'true'}>Accept</span>
      </button>
    </div>
  );
}

interface UnplacedListProps {
  count: number;
  /** One `<li>` per suggestion that could not be placed. */
  children: ReactNode;
}

/** "N suggestions could not be placed", closed until asked. Renders nothing at zero. */
export function UnplacedList({ count, children }: UnplacedListProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (count === 0) return null;
  return (
    <div className={styles.unplaced}>
      <button
        type="button"
        className={styles.unplacedToggle}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => { setOpen((wasOpen) => !wasOpen); }}
      >
        <span className={styles.caret} data-open={open ? 'true' : 'false'}><I.caret /></span>
        {`${plural(count, 'suggestion', 'suggestions')} could not be placed`}
      </button>
      <Disclosure id={id} open={open}>
        <ul className={styles.unplacedList}>{children}</ul>
      </Disclosure>
    </div>
  );
}

export function ReviewHint() {
  return (
    <p className={styles.hint}>
      <span><kbd className={styles.kbd}>J</kbd> <kbd className={styles.kbd}>K</kbd> move</span>
      <span><kbd className={styles.kbd}>A</kbd> accept</span>
      <span><kbd className={styles.kbd}>R</kbd> reject</span>
      <span><kbd className={styles.kbd}>{MOD_KEY}</kbd> <kbd className={styles.kbd}>Enter</kbd> apply</span>
    </p>
  );
}

interface ReviewShortcutsOptions {
  /** The editor: the keys work while focus is inside it. */
  scopeRef: RefObject<HTMLElement | null>;
  /** False turns every key off. Defaults to true. */
  enabled?: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onDecideCurrent: (decision: 'accepted' | 'rejected') => void;
  onApply: () => void;
  /** Cmd/Ctrl+Enter applies only while this holds. */
  canApply: boolean;
}

/**
 * J and K move, A and R decide the current change, Cmd/Ctrl+Enter applies.
 * Keys typed during IME composition are ignored; the letters are skipped with
 * any modifier or from a text field.
 */
export function useReviewShortcuts({
  scopeRef,
  enabled = true,
  onNext,
  onPrevious,
  onDecideCurrent,
  onApply,
  canApply,
}: ReviewShortcutsOptions): void {
  const onScopeKey = useEffectEvent((event: KeyboardEvent) => {
    if (!enabled || isImeComposing(event)) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      if (!canApply) return;
      event.preventDefault();
      onApply();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isTextField(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === 'j') {
      event.preventDefault();
      onNext();
    } else if (key === 'k') {
      event.preventDefault();
      onPrevious();
    } else if (key === 'a' || key === 'r') {
      event.preventDefault();
      onDecideCurrent(key === 'a' ? 'accepted' : 'rejected');
    }
  });

  useEffect(() => {
    const scope = scopeRef.current;
    if (scope === null) return undefined;
    const listener = (event: KeyboardEvent) => { onScopeKey(event); };
    scope.addEventListener('keydown', listener);
    return () => { scope.removeEventListener('keydown', listener); };
  }, [scopeRef]);
}
