import { memo, type Ref } from 'react';
import { I } from '../icons/I';
import buttons from '../../styles/buttons.module.css';
import styles from './EnhanceControl.module.css';

interface EnhanceControlProps {
  /** An Enhance press is still being rewritten. The button stays pressable. */
  working: boolean;
  /** The composer-level gate Generate uses (offline, empty prompt, refs). */
  disabled: boolean;
  needsTextModel?: boolean;
  /** Sparkle only, same accessible name (the phone collapsed bar). */
  iconOnly?: boolean;
  onEnhance: () => void;
  /** The Enhance button, which anchors the no-text-model note. */
  enhanceRef?: Ref<HTMLButtonElement> | undefined;
}

/**
 * Enhance and generate: every press rewrites the composer prompt as it stands
 * (tokens resolved with a fresh roll) and generates from the rewrite. The
 * prompt itself is never changed. Repeated presses are the point, so the
 * button never blocks on its own work: it is never natively disabled, and a
 * closed gate is `aria-disabled` with a click guard, keeping focus.
 */
function EnhanceControl({ working, disabled, needsTextModel = false, iconOnly = false, onEnhance, enhanceRef }: EnhanceControlProps) {
  return (
    <>
      <span className="srOnly" role="status" aria-live="polite" aria-atomic="true">{working ? 'Enhancing prompt…' : ''}</span>
      <button
        ref={enhanceRef}
        type="button"
        className={`${buttons.secondary} ${styles.enhance}`}
        aria-label="Enhance and generate"
        aria-disabled={disabled || undefined}
        aria-busy={working || undefined}
        data-icon-only={iconOnly ? '' : undefined}
        data-tip={needsTextModel ? 'Needs a text model' : 'Rewrite and generate'}
        onClick={() => {
          if (disabled) return;
          onEnhance();
        }}
      >
        <span className={styles.glyph} aria-hidden="true">
          {working ? <span className={styles.spinner} /> : <I.sparkle aria-hidden="true" />}
        </span>
        {iconOnly ? null : <span className={styles.label}>Enhance</span>}
      </button>
    </>
  );
}

export default memo(EnhanceControl);
