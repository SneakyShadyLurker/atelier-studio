import type { ReactNode } from 'react';
import typeStyles from '../../styles/type.module.css';

interface MetaProps {
  /** Fields in reading order; null, undefined, false and '' are dropped. */
  items: readonly ReactNode[];
  /** Give the first field the stronger meta ink (e.g. a model name). */
  lead?: boolean;
  /** Accepts a CSS-module lookup directly (typed string | undefined). */
  className?: string | undefined;
}

function isPresent(item: ReactNode): boolean {
  return item !== null && item !== undefined && item !== false && item !== '';
}

/** A meta line as a list: structure separates the fields, not punctuation. */
export function Meta({ items, lead = false, className }: MetaProps) {
  const fields = items.filter(isPresent);
  if (fields.length === 0) return null;
  const classes = [typeStyles.meta, lead && typeStyles.metaLead, className].filter(Boolean).join(' ');
  return (
    <ul className={classes}>
      {/* Fields are positional and rebuilt from props on every render. */}
      {fields.map((field, index) => <li key={index}>{field}</li>)}
    </ul>
  );
}
