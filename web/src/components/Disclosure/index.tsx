import { useState, type AriaRole, type ReactNode } from 'react';
import styles from '../../styles/disclosure.module.css';

export interface DisclosureProps {
  /** Drives the reveal; the owner keeps its own toggle (aria-expanded, aria-controls → `id`). */
  open: boolean;
  children: ReactNode;
  /** The panel id, for the toggle's aria-controls. */
  id?: string | undefined;
  /** Panel class for the owner's layout (grid placement, gap cancel). */
  className?: string | undefined;
  /** Content class for the owner's inner spacing; it is clipped with the content. */
  contentClassName?: string | undefined;
  role?: AriaRole | undefined;
  'aria-label'?: string | undefined;
  /** Mount the content on first open (then keep it), for heavy closed content. */
  lazy?: boolean | undefined;
}

/**
 * A height-auto reveal (styles/disclosure.module.css): the panel stays
 * mounted and interpolates its grid track, so opening and closing pass
 * through intermediate heights and reverse mid-way without a remount. The
 * closed panel is inert and aria-hidden.
 */
export function Disclosure({ open, children, id, className, contentClassName, role, 'aria-label': ariaLabel, lazy = false }: DisclosureProps) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return (
    <div
      id={id}
      role={role}
      aria-label={ariaLabel}
      className={className === undefined ? styles.panel : `${styles.panel} ${className}`}
      data-open={open ? 'true' : undefined}
      inert={!open}
      aria-hidden={!open}
    >
      <div className={styles.clip}>
        <div className={contentClassName === undefined ? styles.content : `${styles.content} ${contentClassName}`}>
          {!lazy || opened ? children : null}
        </div>
      </div>
    </div>
  );
}
