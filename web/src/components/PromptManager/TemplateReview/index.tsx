import { Fragment, useEffect, useEffectEvent, useId, useMemo, useRef, useState, type RefObject } from 'react';
import type { TemplateChange, UnplacedReason, WordRun } from '@atelier/shared/template-rework';
import { isReducedMotionPreferred } from '../../../hooks/useReducedMotion';
import { runWhenReachable } from '../../../lib/focus';
import { isImeComposing } from '../../../lib/ime';
import { segmentTemplate, type Segment } from '../../../lib/trackedTemplate';
import btn from '../../../styles/buttons.module.css';
import { Disclosure } from '../../Disclosure';
import { I } from '../../icons/I';
import { acceptedIds, setAllDecisions, setDecision, type TemplateReview as Review } from '../templateReview';
import styles from './index.module.css';

/*
 * The tracked-changes review of a template rework (spec template-rework-review
 * R4 to R6, R9 to R11): the body as a proof sheet, each placed change marked
 * in it and tied by its number to a note row with its reason and its
 * decision. Decisions only repaint: nothing moves when a change flips. Model
 * text reaches the DOM only as React text nodes.
 */

/** Unchanged runs longer than this many words fold away (R4.3). */
const COLLAPSE_WORDS = 60;
/** A block's removed text hides behind "Show removed" past this length or with a line break (R4.2). */
const REMOVED_INLINE_MAX_CHARS = 160;

const CAUSES: Record<UnplacedReason, string> = {
  missing: 'The passage it quotes is not in the template',
  ambiguous: 'The passage it quotes appears more than once',
  overlap: 'It overlaps another change',
  splits_token: 'It would cut through a token',
  too_long: 'It would make the template too long',
};

const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

const plural = (count: number, one: string, many: string) => `${String(count)} ${count === 1 ? one : many}`;

function countAnnouncement(review: Review): string {
  return `${plural(acceptedIds(review).length, 'change', 'changes')} to apply, ${String(review.rejected.length)} rejected`;
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
}

/** One painted run. The painted span stays put across decisions, so its tint
 *  eases; only while accepted does it hold the semantic del/ins. */
function Mark({ kind, accepted, text }: { kind: 'del' | 'ins'; accepted: boolean; text: string }) {
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

interface NoteRowProps {
  change: TemplateChange;
  accepted: boolean;
  current: boolean;
  reasonId: string;
  onToggle: () => void;
}

function NoteRow({ change, accepted, current, reasonId, onToggle }: NoteRowProps) {
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

interface TemplateReviewProps {
  review: Review;
  onChange: (next: Review) => void;
  /** Writes the accepted changes; called only while at least one is accepted. */
  onApply: () => void;
  /** The editor: J, K, A, R and Cmd/Ctrl+Enter work while focus is inside it. */
  scopeRef: RefObject<HTMLElement | null>;
}

export default function TemplateReview({ review, onChange, onApply, scopeRef }: TemplateReviewProps) {
  // Segmentation reads only the base and the changes, never the decisions.
  const segments = useMemo(
    () => segmentTemplate(review.base, review.changes, { collapseWords: COLLAPSE_WORDS }),
    [review.base, review.changes],
  );
  const changesById = new Map(review.changes.map((change) => [change.id, change]));
  const rejected = new Set(review.rejected);
  const total = review.changes.length;
  const acceptedCount = total - review.changes.filter((change) => rejected.has(change.id)).length;
  const [current, setCurrent] = useState(0);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<number>>(() => new Set());
  const [openRemoved, setOpenRemoved] = useState<ReadonlySet<number>>(() => new Set());
  const [unplacedOpen, setUnplacedOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const acceptAllRef = useRef<HTMLButtonElement | null>(null);
  const rejectAllRef = useRef<HTMLButtonElement | null>(null);
  const idBase = useId();
  const reasonId = (id: number) => `${idBase}-why-${String(id)}`;
  const removedId = (id: number) => `${idBase}-removed-${String(id)}`;
  const unplacedId = `${idBase}-unplaced`;
  const currentId = review.changes[current]?.id;

  const groupOf = (id: number) => sheetRef.current?.querySelector<HTMLElement>(`[data-change-id="${String(id)}"]`) ?? null;

  const focusChange = (index: number, scroll: boolean) => {
    const change = review.changes[index];
    if (change === undefined) return;
    runWhenReachable(() => {
      const group = groupOf(change.id);
      if (group === null) return;
      if (scroll) group.scrollIntoView({ block: 'center', behavior: isReducedMotionPreferred() ? 'instant' : 'smooth' });
      group.focus({ preventScroll: scroll });
    });
  };

  const focusFirst = useEffectEvent(() => { focusChange(0, false); });
  // After the dialog's own focus restore, so the review keeps focus.
  useEffect(() => { focusFirst(); }, []);

  const navigate = (index: number, lead = '') => {
    if (index < 0 || index >= total) return;
    setCurrent(index);
    setAnnouncement(`${lead}Change ${String(index + 1)} of ${String(total)}`);
    focusChange(index, true);
  };

  const decide = (id: number, decision: 'accepted' | 'rejected') => {
    const next = setDecision(review, id, decision);
    onChange(next);
    setAnnouncement(countAnnouncement(next));
    return next;
  };

  const decideAll = (decision: 'accepted' | 'rejected') => {
    const next = setAllDecisions(review, decision);
    onChange(next);
    setAnnouncement(countAnnouncement(next));
    // The pressed action leaves with the state it changed; its opposite takes focus.
    runWhenReachable(() => { (decision === 'rejected' ? acceptAllRef : rejectAllRef).current?.focus(); });
  };

  const onScopeKey = useEffectEvent((event: KeyboardEvent) => {
    if (isImeComposing(event)) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      if (acceptedCount === 0) return;
      event.preventDefault();
      onApply();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isTextField(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === 'j') {
      event.preventDefault();
      navigate(current + 1);
    } else if (key === 'k') {
      event.preventDefault();
      navigate(current - 1);
    } else if ((key === 'a' || key === 'r') && currentId !== undefined) {
      event.preventDefault();
      const next = decide(currentId, key === 'a' ? 'accepted' : 'rejected');
      if (current + 1 < total) navigate(current + 1, `${countAnnouncement(next)}. `);
    }
  });

  useEffect(() => {
    const scope = scopeRef.current;
    if (scope === null) return undefined;
    const listener = (event: KeyboardEvent) => { onScopeKey(event); };
    scope.addEventListener('keydown', listener);
    return () => { scope.removeEventListener('keydown', listener); };
  }, [scopeRef]);

  const revealFold = (start: number) => {
    setOpenFolds((open) => new Set(open).add(start));
    runWhenReachable(() => {
      sheetRef.current?.querySelector<HTMLElement>(`[data-fold-start="${String(start)}"]`)?.focus();
    });
  };

  const toggleRemoved = (id: number) => {
    setOpenRemoved((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const noteFor = (change: TemplateChange) => {
    const accepted = !rejected.has(change.id);
    const index = review.changes.indexOf(change);
    return (
      <NoteRow
        key={change.id}
        change={change}
        accepted={accepted}
        current={change.id === currentId}
        reasonId={reasonId(change.id)}
        onToggle={() => {
          setCurrent(index);
          decide(change.id, accepted ? 'rejected' : 'accepted');
        }}
      />
    );
  };

  const groupProps = (change: TemplateChange) => ({
    role: 'group',
    tabIndex: -1,
    'aria-label': `Change ${String(change.id + 1)} of ${String(total)}`,
    'aria-describedby': reasonId(change.id),
    'data-change-id': change.id,
    'data-decision': rejected.has(change.id) ? 'rejected' : 'accepted',
    'data-current': change.id === currentId ? 'true' : undefined,
  });

  // A hair of space where a struck word meets its replacement. Its own
  // element: a margin on the insertion would repeat on every wrapped line.
  const renderRuns = (runs: readonly WordRun[], accepted: boolean) => runs.map((run, index) => (run.kind === 'same'
    ? <Fragment key={index}>{run.text}</Fragment>
    : (
      <Fragment key={index}>
        {run.kind === 'ins' && runs[index - 1]?.kind === 'del' && <span className={styles.gap} aria-hidden="true" />}
        <Mark kind={run.kind} accepted={accepted} text={run.text} />
      </Fragment>
    )));

  // A note row, a fold and a block change each end the line themselves, so the
  // line break that follows one in the template would show as an empty line.
  const endsLine = (segment: Segment | undefined): boolean => segment !== undefined && (
    (segment.kind === 'notes' && segment.ids.length > 0)
    || (segment.kind === 'fold' && !openFolds.has(segment.start))
    || (segment.kind === 'change' && segment.mode === 'block'));
  const afterBlock = (text: string, index: number): string => (
    endsLine(segments[index - 1]) ? text.replace(/^\r?\n/, '') : text);

  return (
    <div className={styles.review}>
      <div className={styles.head}>
        <span className={styles.label}>Review</span>
        {review.summary !== null && review.summary !== '' && <p className={styles.summary}>{review.summary}</p>}
        <div className={styles.tools}>
          {acceptedCount < total && (
            <button type="button" ref={acceptAllRef} className={styles.textAction} onClick={() => { decideAll('accepted'); }}>
              Accept all
            </button>
          )}
          {acceptedCount > 0 && (
            <button type="button" ref={rejectAllRef} className={styles.textAction} onClick={() => { decideAll('rejected'); }}>
              Reject all
            </button>
          )}
          <button
            type="button"
            className={`${btn.iconAction} ${styles.nav}`}
            aria-label="Previous change"
            aria-disabled={current === 0}
            data-tip="Previous change"
            onClick={() => { navigate(current - 1); }}
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
            onClick={() => { navigate(current + 1); }}
          >
            <I.caret />
          </button>
        </div>
      </div>

      <div ref={sheetRef} role="group" aria-label="Body, under review" className={styles.sheet}>
        {segments.map((segment, index) => {
          switch (segment.kind) {
            case 'same':
              return <Fragment key={index}>{afterBlock(segment.text, index)}</Fragment>;
            case 'fold':
              return openFolds.has(segment.start) ? (
                <span key={index} tabIndex={-1} data-fold-start={segment.start} className={styles.revealed}>{afterBlock(segment.text, index)}</span>
              ) : (
                <button key={index} type="button" className={styles.fold} onClick={() => { revealFold(segment.start); }}>
                  <I.chevronRight />
                  {`Show ${String(segment.words)} unchanged words`}
                </button>
              );
            case 'notes':
              return (
                <Fragment key={index}>
                  {segment.ids.map((id) => {
                    const change = changesById.get(id);
                    return change === undefined ? null : noteFor(change);
                  })}
                </Fragment>
              );
            case 'change': {
              const { change } = segment;
              const accepted = !rejected.has(change.id);
              if (segment.mode === 'inline') {
                return (
                  <span key={index} className={styles.change} {...groupProps(change)}>
                    {renderRuns(segment.runs, accepted)}
                    <sup className={styles.key} aria-hidden="true">{change.id + 1}</sup>
                  </span>
                );
              }
              const removedHidden = segment.find.length > REMOVED_INLINE_MAX_CHARS || segment.find.includes('\n');
              const removedOpen = openRemoved.has(change.id);
              return (
                <div key={index} className={`${styles.change} ${styles.block}`} {...groupProps(change)}>
                  <span className={styles.blockLabel}>Removed</span>
                  {removedHidden ? (
                    <>
                      <button
                        type="button"
                        className={styles.textAction}
                        aria-expanded={removedOpen}
                        aria-controls={removedId(change.id)}
                        onClick={() => { toggleRemoved(change.id); }}
                      >
                        {removedOpen ? 'Hide removed' : 'Show removed'}
                      </button>
                      <Disclosure id={removedId(change.id)} open={removedOpen} contentClassName={styles.blockText}>
                        <Mark kind="del" accepted={accepted} text={segment.find} />
                      </Disclosure>
                    </>
                  ) : (
                    <div className={styles.blockText}><Mark kind="del" accepted={accepted} text={segment.find} /></div>
                  )}
                  <span className={styles.blockLabel}>Proposed</span>
                  <div className={styles.blockText}><Mark kind="ins" accepted={accepted} text={change.replace} /></div>
                  {noteFor(change)}
                </div>
              );
            }
          }
        })}
      </div>

      {review.unplaced.length > 0 && (
        <div className={styles.unplaced}>
          <button
            type="button"
            className={styles.unplacedToggle}
            aria-expanded={unplacedOpen}
            aria-controls={unplacedId}
            onClick={() => { setUnplacedOpen((open) => !open); }}
          >
            <span className={styles.caret} data-open={unplacedOpen ? 'true' : 'false'}><I.caret /></span>
            {`${plural(review.unplaced.length, 'suggestion', 'suggestions')} could not be placed`}
          </button>
          <Disclosure id={unplacedId} open={unplacedOpen}>
            <ul className={styles.unplacedList}>
              {review.unplaced.map((item, index) => (
                <li key={index} className={styles.unplacedItem}>
                  {item.why !== '' && <p className={styles.unplacedWhy}>{item.why}</p>}
                  {item.replace !== '' && <p className={styles.proposed}>{item.replace}</p>}
                  <p className={styles.cause}>{CAUSES[item.reason]}</p>
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}

      <p className={styles.hint}>
        <span><kbd className={styles.kbd}>J</kbd> <kbd className={styles.kbd}>K</kbd> move</span>
        <span><kbd className={styles.kbd}>A</kbd> accept</span>
        <span><kbd className={styles.kbd}>R</kbd> reject</span>
        <span><kbd className={styles.kbd}>{MOD_KEY}</kbd> <kbd className={styles.kbd}>Enter</kbd> apply</span>
      </p>

      <div role="status" aria-live="polite" aria-atomic="true" className="srOnly">{announcement}</div>
    </div>
  );
}
