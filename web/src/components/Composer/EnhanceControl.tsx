import { memo } from 'react';
import { I } from '../icons/I';
import buttons from '../../styles/buttons.module.css';
import styles from './EnhanceControl.module.css';

interface EnhanceControlProps {
  /** True while an enhance stream is open. */
  enhancing: boolean;
  /** True when the composer differs from the anchored user prompt and can revert to it. */
  canUndo: boolean;
  /** Composer-level gate (offline / empty prompt). Combined with `enhancing`. */
  disabled: boolean;
  onEnhance: () => void;
  onUndo: () => void;
}

function EnhanceControl({ enhancing, canUndo, disabled, onEnhance, onUndo }: EnhanceControlProps) {
  // Announce the async enhance lifecycle to assistive tech: the textarea is
  // disabled mid-stream and its value is swapped on completion, neither of
  // which a screen reader picks up on its own. Derived from props (no extra
  // state) — the transition through "Enhancing…" makes the completion message
  // a content change the live region will announce.
  const liveMessage = enhancing ? 'Enhancing prompt…' : canUndo ? 'Prompt rewritten.' : '';
  return (
    <div
      className={`${styles.seg} ${canUndo ? styles.segActive : ''}`}
      role="group"
      aria-label="Prompt enhancement"
    >
      <div className="srOnly" role="status" aria-live="polite" aria-atomic="true">{liveMessage}</div>
      <button
        type="button"
        className={`${buttons.ai} ${styles.enhance}`}
        aria-label="Enhance"
        data-tip="Rewrite prompt"
        disabled={disabled || enhancing}
        onClick={onEnhance}
      >
        <I.sparkle aria-hidden="true" />
        <span className={styles.enhanceLabel}>{enhancing ? 'Enhancing…' : 'Enhance'}</span>
      </button>
      <span className={styles.sep} aria-hidden="true" />
      <button
        type="button"
        className={`${buttons.secondary} ${styles.revert}`}
        aria-label="Undo enhance"
        data-tip="Restore the original prompt"
        disabled={!canUndo}
        onClick={onUndo}
      >
        <I.reroll />
      </button>
    </div>
  );
}

export default memo(EnhanceControl);
