import { Fragment, useEffect, useEffectEvent, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ListChange } from '@atelier/shared';
import type { UnplacedListReason } from '@atelier/shared/list-draft';
import type { WordRun } from '@atelier/shared/template-rework';
import { isReducedMotionPreferred } from '../../../hooks/useReducedMotion';
import { runWhenReachable } from '../../../lib/focus';
import { I } from '../../icons/I';
import { segmentList, type ListBaseRow, type ListReview as Review, type ListRow } from '../listReview';
import { acceptedIds, setAllDecisions, setDecision } from '../reviewDecisions';
import { countAnnouncement as announceCounts, Mark, NoteRow, ReviewHead, ReviewHint, UnplacedList, useReviewShortcuts } from '../reviewParts';
import shared from '../TemplateReview/index.module.css';
import styles from './index.module.css';

/*
 * The review of a variable-list draft (spec list-draft-review R5): the options
 * as a sheet of rows, the base rows in order and then the added ones, each
 * proposed change marked in its row and followed by its note with its reason
 * and decision. The template review's chrome and marks; decisions only
 * repaint, so no row moves when a change flips. Model text reaches the DOM
 * only as React text nodes.
 */

const CAUSES: Record<UnplacedListReason, string> = {
  missing: 'The option it names is not in the list',
  ambiguous: 'The option it names appears more than once',
  overlap: 'Another change already covers that option',
  duplicate: 'Another option already has that value',
};

function countAnnouncement(review: Review): string {
  return announceCounts(acceptedIds(review).length, review.rejected.length);
}

/** "weight 3", or nothing at the default weight of 1. */
function Weight({ weight }: { weight: number }) {
  return weight === 1 ? null : <span className={styles.weight}>{`weight ${String(weight)}`}</span>;
}

/** A reweight, "weight 1 to 5": the old weight struck, the new one marked, both repainting with the decision. */
function WeightChange({ from, to }: { from: number; to: number }) {
  return (
    <span className={styles.weight}>
      {'weight '}
      <span className={shared.del}>{String(from)}</span>
      {' to '}
      <span className={shared.ins}>{String(to)}</span>
    </span>
  );
}

// A hair of space where a struck word meets its replacement.
function Runs({ runs, accepted }: { runs: readonly WordRun[]; accepted: boolean }) {
  return runs.map((run, index) => (run.kind === 'same'
    ? <Fragment key={index}>{run.text}</Fragment>
    : (
      <Fragment key={index}>
        {run.kind === 'ins' && runs[index - 1]?.kind === 'del' && <span className={shared.gap} aria-hidden="true" />}
        <Mark kind={run.kind} accepted={accepted} text={run.text} />
      </Fragment>
    )));
}

function Line({ value, weight }: { value: ReactNode; weight: ReactNode }) {
  return (
    <div className={styles.line}>
      <span className={styles.value}>{value}</span>
      {weight}
    </div>
  );
}

function SameRow({ row }: { row: ListBaseRow }) {
  return (
    <div className={styles.row}>
      <Line value={row.value} weight={<Weight weight={row.weight} />} />
    </div>
  );
}

interface ListReviewProps {
  review: Review;
  onChange: (next: Review) => void;
  /** Writes the accepted changes; called only while at least one is accepted. */
  onApply: () => void;
  /** The editor: J, K, A, R and Cmd/Ctrl+Enter work while focus is inside it. */
  scopeRef: RefObject<HTMLElement | null>;
  /** False while a dialog is open over the editor: its keys are its own. */
  shortcutsEnabled: boolean;
}

export default function ListReview({ review, onChange, onApply, scopeRef, shortcutsEnabled }: ListReviewProps) {
  // Segmentation reads only the base and the changes, never the decisions.
  const segments = useMemo(
    () => segmentList({ base: review.base, changes: review.changes }),
    [review.base, review.changes],
  );
  const rejected = new Set(review.rejected);
  const total = review.changes.length;
  const acceptedCount = total - review.changes.filter((change) => rejected.has(change.id)).length;
  const [current, setCurrent] = useState(0);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<number>>(() => new Set());
  const [announcement, setAnnouncement] = useState('');
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const acceptAllRef = useRef<HTMLButtonElement | null>(null);
  const rejectAllRef = useRef<HTMLButtonElement | null>(null);
  const idBase = useId();
  const reasonId = (id: number) => `${idBase}-why-${String(id)}`;
  const currentId = review.changes[current]?.id;

  const focusChange = (index: number, scroll: boolean) => {
    const change = review.changes[index];
    if (change === undefined) return;
    runWhenReachable(() => {
      const group = sheetRef.current?.querySelector<HTMLElement>(`[data-change-id="${String(change.id)}"]`) ?? null;
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
    enabled: shortcutsEnabled,
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

  const changeRow = (line: ReactNode, change: ListChange) => {
    const accepted = !rejected.has(change.id);
    const index = review.changes.indexOf(change);
    return (
      <div
        key={`change-${String(change.id)}`}
        className={`${shared.change} ${styles.row}`}
        role="group"
        tabIndex={-1}
        aria-label={`Change ${String(change.id + 1)} of ${String(total)}`}
        aria-describedby={reasonId(change.id)}
        data-change-id={change.id}
        data-decision={accepted ? 'accepted' : 'rejected'}
        data-current={change.id === currentId ? 'true' : undefined}
      >
        {line}
        <NoteRow
          change={change}
          accepted={accepted}
          current={change.id === currentId}
          reasonId={reasonId(change.id)}
          onToggle={() => {
            setCurrent(index);
            decide(change.id, accepted ? 'rejected' : 'accepted');
          }}
        />
      </div>
    );
  };

  const renderRow = (row: ListRow) => {
    switch (row.kind) {
      case 'same':
        return <SameRow key={`same-${String(row.index)}`} row={row.row} />;
      case 'edit': {
        const accepted = !rejected.has(row.change.id);
        const weight = row.change.weight === row.row.weight
          ? <Weight weight={row.row.weight} />
          : <WeightChange from={row.row.weight} to={row.change.weight} />;
        const value = row.runs === null ? row.row.value : <Runs runs={row.runs} accepted={accepted} />;
        return changeRow(<Line value={value} weight={weight} />, row.change);
      }
      case 'remove': {
        const accepted = !rejected.has(row.change.id);
        return changeRow(<Line value={<Mark kind="del" accepted={accepted} text={row.row.value} />} weight={<Weight weight={row.row.weight} />} />, row.change);
      }
      case 'add': {
        const accepted = !rejected.has(row.change.id);
        return changeRow(<Line value={<Mark kind="ins" accepted={accepted} text={row.change.value} />} weight={<Weight weight={row.change.weight} />} />, row.change);
      }
    }
  };

  return (
    <div className={shared.review}>
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

      <div ref={sheetRef} role="group" aria-label="Options, under review" className={`${shared.sheet} ${styles.sheet}`}>
        <div className={styles.rows}>
          {segments.map((segment) => {
            if (segment.kind !== 'fold') return renderRow(segment);
            return openFolds.has(segment.start) ? (
              <div key={`fold-${String(segment.start)}`} tabIndex={-1} data-fold-start={segment.start} className={`${shared.revealed} ${styles.revealed}`}>
                {segment.rows.map(renderRow)}
              </div>
            ) : (
              <button key={`fold-${String(segment.start)}`} type="button" className={shared.fold} onClick={() => { revealFold(segment.start); }}>
                <I.chevronRight />
                {`Show ${String(segment.rows.length)} unchanged options`}
              </button>
            );
          })}
        </div>
      </div>

      <UnplacedList count={review.unplaced.length}>
        {review.unplaced.map((item, index) => (
          <li key={index} className={shared.unplacedItem}>
            {item.why !== '' && <p className={shared.unplacedWhy}>{item.why}</p>}
            {/* What it proposed, in the sheet's marks: the option it names
                struck, and an edit's new value and weight beside it. */}
            <p className={styles.proposed}>
              {item.op === 'remove' || item.value !== null ? <span className={shared.del}>{item.find}</span> : item.find}
              {item.value !== null && <>{' '}<span className={shared.ins}>{item.value}</span></>}
              {item.weight !== null && <span className={styles.weight}>{`weight ${String(item.weight)}`}</span>}
            </p>
            <p className={shared.cause}>{CAUSES[item.reason]}</p>
          </li>
        ))}
      </UnplacedList>

      <ReviewHint />

      <div role="status" aria-live="polite" aria-atomic="true" className="srOnly">{announcement}</div>
    </div>
  );
}
