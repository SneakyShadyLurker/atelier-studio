import { useId, useState, type Ref } from 'react';
import type { LibraryDiagnosisEntry, LibraryDiagnosisResponse } from '@atelier/shared';
import { Disclosure } from '../../Disclosure';
import { I } from '../../icons/I';
import styles from './index.module.css';
import btn from '../../../styles/buttons.module.css';

type Mode = { mode: 'library' } | { mode: 'template'; templateName: string };

export type DiagnosisCardProps = Mode & {
  diagnosis: LibraryDiagnosisResponse;
  /** `actionLabel` is the AI button's visible label, for the host's no-text-model note. */
  onFixWithAi: (diagnosis: LibraryDiagnosisResponse, actionLabel: string) => void;
  onCancel: () => void;
  /** The AI button, which anchors the host's no-text-model note. */
  fixButtonRef?: Ref<HTMLButtonElement> | undefined;
};

export function DiagnosisCard(props: DiagnosisCardProps) {
  const { diagnosis, onFixWithAi, onCancel, fixButtonRef } = props;
  const titleId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();

  const visible = props.mode === 'library'
    ? diagnosis.templates
    : diagnosis.templates.filter((t) => t.templateName === props.templateName);
  const broken: readonly LibraryDiagnosisEntry[] = visible.filter((t) => t.satisfiable === false);
  const incomplete = visible.filter((t) => t.satisfiable === null);
  const fixLabel = broken.length === 0 ? 'Continue with AI' : props.mode === 'template' ? 'Fix Template' : 'Fix Library';

  if (broken.length === 0 && incomplete.length === 0) return null;

  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <header className={styles.head}>
        <I.warn />
        <h3 id={titleId} className={styles.title}>
          {broken.length > 0
            ? `${broken.length === 1 ? '1 template' : `${broken.length} templates`} currently unsatisfiable`
            : 'Diagnosis incomplete'}
        </h3>
      </header>

      {broken.length > 0 && <ul className={styles.list}>
        {broken.map((t) => (
          <li key={t.templateName} className={styles.item}>
            <span className={styles.name}>{t.templateName}</span>
            {t.reason && <span className={styles.reason}>{t.reason}</span>}
          </li>
        ))}
      </ul>}

      {incomplete.length > 0 && (
        <div className={styles.details}>
          {broken.length > 0 && <strong>Diagnosis incomplete</strong>}
          <div className={styles.reason}>
            The check reached its work limit. Coherence is unknown for these templates.
            You can continue with AI; no conflict has been established for them.
          </div>
          <ul className={styles.list}>
            {incomplete.map((t) => <li key={t.templateName} className={styles.item}><span className={styles.name}>{t.templateName}</span></li>)}
          </ul>
        </div>
      )}

      {broken.length > 0 && (
        <Disclosure
          id={detailsId}
          open={detailsOpen}
          className={styles.detailsDisclosure}
          contentClassName={styles.detailsDisclosureContent}
        >
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
        </Disclosure>
      )}

      <footer className={styles.actions}>
        <button
          ref={fixButtonRef}
          type="button"
          className={btn.ai}
          onClick={() => { onFixWithAi(diagnosis, fixLabel); }}
        >
          <I.sparkle aria-hidden="true" />
          {fixLabel}
        </button>
        {broken.length > 0 && <button
          type="button"
          className={btn.secondary}
          onClick={() => { setDetailsOpen((s) => !s); }}
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
        >
          {detailsOpen ? 'Hide details' : 'Show details'}
        </button>}
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
