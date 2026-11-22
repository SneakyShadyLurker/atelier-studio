import { Fragment, useEffect, useEffectEvent, useId, useMemo, useRef, useState, type RefObject } from 'react';
import type { TemplateChange, UnplacedReason, WordRun } from '@atelier/shared/template-rework';
import { isReducedMotionPreferred } from '../../../hooks/useReducedMotion';
import { runWhenReachable } from '../../../lib/focus';
import { segmentTemplate, type Segment } from '../../../lib/trackedTemplate';
import { Disclosure } from '../../Disclosure';
import { I } from '../../icons/I';
import { countAnnouncement as announceCounts, Mark, NoteRow, ReviewHead, ReviewHint, UnplacedList, useReviewShortcuts } from '../reviewParts';
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

function countAnnouncement(review: Review): string {
  return announceCounts(acceptedIds(review).length, review.rejected.length);
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
  const [announcement, setAnnouncement] = useState('');
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const acceptAllRef = useRef<HTMLButtonElement | null>(null);
  const rejectAllRef = useRef<HTMLButtonElement | null>(null);
  const idBase = useId();
  const reasonId = (id: number) => `${idBase}-why-${String(id)}`;
  const removedId = (id: number) => `${idBase}-removed-${String(id)}`;
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

  useReviewShortcuts({
    scopeRef,
    onNext: () => { navigate(current + 1); },
    onPrevious: () => { navigate(current - 1); },
    onDecideCurrent: (decision) => {
      if (currentId === undefined) return;
      const next = decide(currentId, decision);
      if (current + 1 < total) navigate(current + 1, `${countAnnouncement(next)}. `);
    },
    onApply,
    canApply: acceptedCount > 0,
  });

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
      <ReviewHead
        summary={review.summary}
        total={total}
        acceptedCount={acceptedCount}
        current={current}
        onAcceptAll={() => { decideAll('accepted'); }}
        onRejectAll={() => { decideAll('rejected'); }}
        onPrevious={() => { navigate(current - 1); }}
        onNext={() => { navigate(current + 1); }}
        acceptAllRef={acceptAllRef}
        rejectAllRef={rejectAllRef}
      />

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

      <UnplacedList count={review.unplaced.length}>
        {review.unplaced.map((item, index) => (
          <li key={index} className={styles.unplacedItem}>
            {item.why !== '' && <p className={styles.unplacedWhy}>{item.why}</p>}
            {item.replace !== '' && <p className={styles.proposed}>{item.replace}</p>}
            <p className={styles.cause}>{CAUSES[item.reason]}</p>
          </li>
        ))}
      </UnplacedList>

      <ReviewHint />

      <div role="status" aria-live="polite" aria-atomic="true" className="srOnly">{announcement}</div>
    </div>
  );
}
