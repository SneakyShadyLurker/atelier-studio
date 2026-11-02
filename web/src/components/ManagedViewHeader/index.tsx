import type { ReactNode } from 'react';
import { I } from '../icons/I';
import buttons from '../../styles/buttons.module.css';
import styles from './index.module.css';

interface ManagedViewHeaderProps {
  /** Optional scope beside the title, as a small-caps label in sentence-case
   *  source text, e.g. "12 items". Omit it when the title says it all. */
  label?: string;
  /** Visible <h2> title that anchors the heading hierarchy. */
  heading: string;
  /** Stable id so the host section can point aria-labelledby at the heading. */
  headingId: string;
  backLabel?: string;
  onBack: () => void;
  /** Right-aligned action slot for managed-view actions such as Empty Archive. */
  children?: ReactNode;
}

export function ManagedViewHeader({
  label,
  heading,
  headingId,
  backLabel,
  onBack,
  children,
}: ManagedViewHeaderProps) {
  return (
    <header className={styles.header}>
      <button className={`${buttons.secondary} ${styles.backButton}`} type="button" onClick={onBack}>
        <span className={styles.backIcon} aria-hidden="true"><I.arrow /></span>
        <span>{backLabel ?? 'Back to feed'}</span>
      </button>
      <div className={styles.titleGroup}>
        <h2 id={headingId} className={styles.title}>{heading}</h2>
        {label !== undefined && label !== '' ? <span className={styles.label}>{label}</span> : null}
      </div>
      {children != null && <div className={styles.actions}>{children}</div>}
    </header>
  );
}
