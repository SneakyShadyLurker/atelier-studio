import { useId, useState } from 'react';
import type { LibraryDiagnosisEntry, LibraryDiagnosisResponse } from '@atelier/shared';
import { I } from '../../icons/I';
import styles from './index.module.css';
import btn from '../../../styles/buttons.module.css';

type Mode = { mode: 'library' } | { mode: 'template'; templateName: string };

export type DiagnosisCardProps = Mode & {
  diagnosis: LibraryDiagnosisResponse;
  onFixWithAi: (diagnosis: LibraryDiagnosisResponse) => void;
  onCancel: () => void;
};

export function DiagnosisCard(props: DiagnosisCardProps) {
  const { diagnosis, onFixWithAi, onCancel } = props;
  const titleId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);

  const failing = diagnosis.templates.filter((t) => !t.satisfiable);
  const broken: readonly LibraryDiagnosisEntry[] = props.mode === 'library'
    ? failing
    : failing.filter((t) => t.templateName === props.templateName);

  if (broken.length === 0) return null;

  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <header className={styles.head}>
        <I.warn />
        <h3 id={titleId} className={styles.title}>
          {broken.length === 1 ? '1 template' : `${broken.length} templates`} currently unsatisfiable
        </h3>
      </header>

      <ul className={styles.list}>
        {broken.map((t) => (
          <li key={t.templateName} className={styles.item}>
            <span className={styles.name}>{t.templateName}</span>
            {t.reason && <span className={styles.reason}>{t.reason}</span>}
          </li>
        ))}
      </ul>

      {detailsOpen && (
        <div className={styles.details}>
          {broken.map((t) =>
            (t.conflictingPairs ?? []).map((p) => (
              <div
                key={`${t.templateName}-${p.listA}-${p.listB}-${p.dimensionName}`}
                className={styles.pair}
              >
                <span className={styles.detailTemplate}>{t.templateName}</span>
                <span className={styles.detailList}>{p.listA}</span>
                <span className={styles.sep}>↔</span>
                <span className={styles.detailList}>{p.listB}</span>
                <span className={styles.sep}>on</span>
                <span className={styles.dimension}>{p.dimensionName}</span>
              </div>
            )),
          )}
        </div>
      )}

      <footer className={styles.actions}>
        <button
          type="button"
          className={btn.ai}
          onClick={() => { onFixWithAi(diagnosis); }}
        >
          <I.sparkle aria-hidden="true" />
          {props.mode === 'template' ? 'Fix Template' : 'Fix Library'}
        </button>
        <button
          type="button"
          className={btn.secondary}
          onClick={() => { setDetailsOpen((s) => !s); }}
          aria-expanded={detailsOpen}
        >
          {detailsOpen ? 'Hide details' : 'Show details'}
        </button>
        <button
          type="button"
          className={btn.secondary}
          onClick={onCancel}
        >
          Cancel
        </button>
      </footer>
    </section>
  );
}
