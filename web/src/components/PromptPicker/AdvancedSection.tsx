import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Disclosure } from '../Disclosure';
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
      <Disclosure
        id={panelId}
        role="group"
        aria-label="Advanced variables"
        open={open}
        contentClassName={styles.advancedContent}
      >
        {children}
      </Disclosure>
    </div>
  );
}
