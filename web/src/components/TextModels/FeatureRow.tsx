import { useId, type ReactNode } from 'react';
import type { ChipValue } from '../../lib/textModelPick';
import styles from './index.module.css';

// Presentation shared by Shared setup and Your picks, so the two tabs read as
// two layers of one table. Each tab passes its own options and eligibility.

interface FeaturePanelProps {
  readonly label: string;
  /** One sentence under the label. */
  readonly note: string;
  readonly children?: ReactNode;
}

/** A `--bg-elev` sheet: a small-caps label head with one note, then the rows. */
export function FeaturePanel({ label, note, children }: FeaturePanelProps) {
  const headingId = useId();
  return (
    <section className={`${styles.panel} ${styles.featurePanel}`} aria-labelledby={headingId}>
      <div className={styles.panelHead}>
        <h3 id={headingId} className={styles.panelLabel}>{label}</h3>
        <p className={styles.panelNote}>{note}</p>
      </div>
      {children !== undefined && <div className={styles.panelBody}>{children}</div>}
    </section>
  );
}

interface FeatureGroupProps {
  readonly label: string;
  readonly children: ReactNode;
}

/** Group name inside a panel body: a small-caps label with space above, no hairline. */
export function FeatureGroup({ label, children }: FeatureGroupProps) {
  const labelId = useId();
  return (
    <div className={styles.featureGroup} role="group" aria-labelledby={labelId}>
      <h4 id={labelId} className={styles.groupLabel}>{label}</h4>
      {children}
    </div>
  );
}

interface FeatureRowProps {
  readonly label: string;
  readonly description?: ReactNode;
  /** A line under the description (offline pick, own pick). */
  readonly note?: ReactNode;
  /** The model chip. */
  readonly model: ReactNode;
  /** The effort slot: a chip, the fixed-effort text, a hidden reserve or nothing. */
  readonly effort?: ReactNode;
  /** Under the controls (a writer's mode choice). */
  readonly below?: ReactNode;
}

/**
 * Label, description and note on the left; two fixed slots on the right
 * (model chip, effort) so chips align down the column of every row.
 */
export function FeatureRow({ label, description, note, model, effort, below }: FeatureRowProps) {
  return (
    <div className={styles.featureRow}>
      <div className={styles.featureMain}>
        <p className={styles.featureLabel}>{label}</p>
        {description !== undefined && <p className={styles.featureDescription}>{description}</p>}
        {note}
      </div>
      <div className={styles.featureControls}>
        <div className={styles.slot}>{model}</div>
        <div className={styles.slot}>{effort}</div>
        {below}
      </div>
    </div>
  );
}

/** A chip value: quiet when inherited or unset; the ↳ is decorative. */
export function ChipText({ value }: { readonly value: ChipValue }) {
  if (!value.quiet) return value.text;
  return (
    <span className={styles.unsetValue}>
      {value.inherited && <span aria-hidden="true">↳ </span>}
      {value.text}
    </span>
  );
}
