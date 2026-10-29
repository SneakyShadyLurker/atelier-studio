import type { ReactNode } from 'react';
import { I } from '../icons/I';
import styles from './index.module.css';

interface ManagedViewHeaderProps {
  /** Mono uppercase scope label, e.g. "ARCHIVE · 12 ITEMS" or "PROMPT LIBRARY". */
  label: string;
  /** Text of the visually-hidden <h2> that anchors the heading hierarchy. */
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
      <button className={styles.backButton} type="button" onClick={onBack}>
        <span className={styles.backIcon} aria-hidden="true"><I.arrow /></span>
        <span>{backLabel ?? 'Back to feed'}</span>
      </button>
      <h2 id={headingId} className="srOnly">{heading}</h2>
      <div className={styles.label}>{label}</div>
      {children != null && <div className={styles.actions}>{children}</div>}
    </header>
  );
}
