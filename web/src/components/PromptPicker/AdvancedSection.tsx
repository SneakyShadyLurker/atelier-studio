import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { I } from '../icons/I';
import styles from './index.module.css';

interface AdvancedSectionProps {
  count: number;
  children: ReactNode;
}

export default function AdvancedSection({ count, children }: AdvancedSectionProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.advanced}>
      <button
        type="button"
        className={styles.advancedToggle}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => { setOpen((value) => !value); }}
      >
        <span>Advanced, {count} variable{count === 1 ? '' : 's'}</span>
        <I.caret className={styles.advancedCaret} />
      </button>
      <div
        id={panelId}
        role="group"
        aria-label="Advanced variables"
        className={styles.advancedPanel}
        data-open={open ? 'true' : undefined}
        inert={!open}
        aria-hidden={!open}
      >
        <div className={styles.advancedClip}>
          <div className={styles.advancedContent}>{children}</div>
        </div>
      </div>
    </div>
  );
}
