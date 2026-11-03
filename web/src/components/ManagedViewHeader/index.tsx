import type { ReactNode, Ref } from 'react';
import { useIsPhone } from '../../hooks/useIsPhone';
import { I } from '../icons/I';
import buttons from '../../styles/buttons.module.css';
import styles from './index.module.css';

/** Back navigation is optional (the feed header has none); when present it
 *  must say where it goes, so `backLabel` is required with `onBack`. */
type BackProps =
  | { onBack: () => void; backLabel: string }
  | { onBack?: undefined; backLabel?: undefined };

type ManagedViewHeaderProps = BackProps & {
  /** Visible <h2> title that anchors the heading hierarchy. It stands alone:
   *  no scope or count label renders beside it. */
  heading: string;
  /** Stable id so the host section can point aria-labelledby at the heading. */
  headingId: string;
  /** Given when the host lands focus on the heading (an arrival from another
   *  view); the heading then takes programmatic focus only (tabIndex -1). */
  headingRef?: Ref<HTMLHeadingElement> | undefined;
  /** Right-aligned action slot for managed-view actions such as Empty archive. */
  children?: ReactNode;
  /** One trailing control that stays on the title row on phones, where the
   *  `children` slot wraps to its own full-width row (the Prompt Library help
   *  button beside its tab strip). On desktop it follows `children`. */
  titleAction?: ReactNode;
};

export function ManagedViewHeader({
  heading,
  headingId,
  headingRef,
  backLabel,
  onBack,
  children,
  titleAction,
}: ManagedViewHeaderProps) {
  // The tip names the arrow-only phone button; on desktop the label is visible.
  const isPhone = useIsPhone();
  return (
    <header className={styles.header}>
      {onBack !== undefined && (
        <button className={`${buttons.secondary} ${styles.backButton}`} type="button" data-tip={isPhone ? backLabel : undefined} onClick={onBack}>
          <span className={styles.backIcon} aria-hidden="true"><I.arrow /></span>
          {/* Phones show the arrow alone (CSS); the label stays the name. */}
          <span className={styles.backLabel}>{backLabel}</span>
        </button>
      )}
      <div className={styles.titleGroup}>
        <h2 ref={headingRef} id={headingId} className={styles.title} tabIndex={headingRef === undefined ? undefined : -1}>{heading}</h2>
      </div>
      {children != null && <div className={styles.actions}>{children}</div>}
      {titleAction != null && <div className={styles.titleAction}>{titleAction}</div>}
    </header>
  );
}
