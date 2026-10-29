import { useId, useState } from 'react';
import type { LibraryCoverageResponse } from '@atelier/shared';
import { useExitTransition } from '../../../hooks/useExitTransition';
import { DialogShell } from '../../DialogShell';
import { I } from '../../icons/I';
import styles from './index.module.css';
import btn from '../../../styles/buttons.module.css';

export interface CoverageCardProps {
  open: boolean;
  report: LibraryCoverageResponse;
  onJumpToList: (listId: string) => void;
  onCancel: () => void;
}

export function CoverageCard({ open, report, onJumpToList, onCancel }: CoverageCardProps) {
  const { closing, requestClose } = useExitTransition(onCancel, open);
  const titleId = useId();
  const [lowOpen, setLowOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);

  const cleanupCount = report.orphanTags.length + report.missingDimensions.length;

  return (
    <DialogShell open={open} onCancel={requestClose} closing={closing} labelledBy={titleId}>
      <section className={styles.card} data-zone="head" aria-labelledby={titleId}>
        <header className={styles.head}>
          <I.check />
          <h3 id={titleId} className={styles.title}>Library coverage</h3>
        </header>

        <div className={styles.body} data-zone="body">
          {/* (1) Untagged — primary, always expanded */}
          <div className={styles.section} data-section="untagged">
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>Untagged options</span>
            </div>
            <div className={styles.rows}>
              {report.untaggedByList.length === 0 ? (
                <span className={styles.low}>Every name-implied list is fully tagged.</span>
              ) : (
                report.untaggedByList.map((g) => (
                  <button
                    key={`${g.listId}-${g.dim}`}
                    type="button"
                    className={styles.jumpRow}
                    onClick={() => { onJumpToList(g.listId); }}
                    aria-label={`${g.untaggedCount} options untagged on ${g.dim} in ${g.listName} — jump to list`}
                    data-tip="Jump to list"
                  >
                    <span>{g.listName} · {g.dim}</span>
                    <span className={styles.count}>{g.untaggedCount} untagged</span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* (2) Low coverage — collapsed, calm */}
          <div className={styles.section} data-section="low">
            <button
              type="button"
              className={styles.sectionHead}
              aria-expanded={lowOpen}
              onClick={() => { setLowOpen((s) => !s); }}
            >
              <span className={styles.sectionLabel}>Low-coverage lists ({report.lowCoverageLists.length})</span>
              <I.caret />
            </button>
            {lowOpen && (
              <div className={styles.rows}>
                {report.lowCoverageLists.map((l) => (
                  <span key={`${l.listName}-${l.dim}`} className={styles.low}>
                    {l.listName} × {l.dim} · {l.taggedCount}/{l.totalCount} ({Math.round(l.coverage * 100)}%)
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* (3) Cleanup — collapsed, --danger */}
          <div className={styles.section} data-section="cleanup">
            <button
              type="button"
              className={styles.sectionHead}
              aria-expanded={cleanupOpen}
              onClick={() => { setCleanupOpen((s) => !s); }}
            >
              <span className={styles.sectionLabel}>Cleanup ({cleanupCount})</span>
              <I.caret />
            </button>
            {cleanupOpen && (
              <div className={styles.rows}>
                {report.orphanTags.map((o) => (
                  <span key={`orphan-${o.dim}-${o.label}`} className={styles.cleanupRow}>
                    <I.warn />Orphan tag: {o.label} on {o.dim}
                  </span>
                ))}
                {report.missingDimensions.map((m) => (
                  <span key={`missing-${m.listName}-${m.dim}`} className={styles.cleanupRow}>
                    <I.warn />Missing dimension: {m.dim} (implied by {m.listName})
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <footer className={styles.actions} data-zone="foot">
          <button type="button" className={btn.secondary} onClick={requestClose}>Close</button>
        </footer>
      </section>
    </DialogShell>
  );
}
