import { ViewTransition, type KeyboardEvent, type Ref } from 'react';
import { isImeComposing } from '../../lib/ime';
import EnhanceControl from './EnhanceControl';
import styles from './index.module.css';

interface CollapsedBarProps {
  prompt: string;
  placeholder?: string | undefined;
  refCount: number;
  queueLength?: number;
  canSubmit: boolean;
  /** Admission is stoppable: the bar offers Stop beside Generate. */
  draining?: boolean;
  onStop?: () => void;
  dangerTint: boolean;
  onExpand: () => void;
  onSubmit: () => void;
  /** A printable character typed on the focused bar: expand and insert it. */
  onType?: (character: string) => void;
  ref?: Ref<HTMLButtonElement>;
  generateRef?: Ref<HTMLButtonElement>;
  stopRef?: Ref<HTMLButtonElement>;
  /**
   * Enhance and generate beside Generate (image mode only), so a fire that
   * collapses the Composer leaves the button in reach. Absent: no button.
   */
  enhance?: {
    readonly working: boolean;
    readonly needsTextModel: boolean;
    /** Phones: the sparkle alone, same accessible name. */
    readonly iconOnly: boolean;
    readonly onEnhance: () => void;
    readonly ref: Ref<HTMLButtonElement>;
  } | undefined;
}

/**
 * The printable text a key press types, with no command chord and no IME
 * composition. Named keys (Enter, Tab, F1, Dead, Unidentified) are one
 * capitalised word; Space stays the button's own activation key.
 */
function typedCharacter(event: KeyboardEvent): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey || isImeComposing(event)) return null;
  if (event.key === '' || event.key === ' ' || /^[A-Z][A-Za-z0-9]+$/.test(event.key)) return null;
  return event.key;
}

export function CollapsedBar({
  prompt,
  placeholder = 'Describe an image…',
  refCount,
  queueLength = 0,
  canSubmit,
  draining = false,
  onStop,
  dangerTint,
  onExpand,
  onSubmit,
  onType,
  ref,
  generateRef,
  stopRef,
  enhance,
}: CollapsedBarProps) {
  return (
    <div className={styles.collapsedBar} {...(dangerTint ? { 'data-tone': 'danger' } : {})}>
      <button
        type="button"
        ref={ref}
        className={styles.collapsedExpand}
        aria-expanded={false}
        aria-label={
          refCount > 0
            ? `Expand composer, ${refCount} reference image${refCount === 1 ? '' : 's'} attached`
            : 'Expand composer'
        }
        onClick={onExpand}
        onKeyDown={(event) => {
          const character = onType ? typedCharacter(event) : null;
          if (character === null) return;
          event.preventDefault();
          onType?.(character);
        }}
      >
        <span className={styles.collapsedPrompt} data-empty={prompt.trim() ? undefined : 'true'}>
          {prompt.trim() || placeholder}
        </span>
        {/* Badges are part boundaries fed by the Composer's snapshot. */}
        {refCount > 0 && (
          <ViewTransition default="none" enter="part-enter" exit="part-exit">
            <span className={styles.collapsedRefBadge} aria-hidden="true">
              {refCount}
            </span>
          </ViewTransition>
        )}
        {queueLength > 0 && (
          <ViewTransition default="none" enter={draining ? 'none' : 'part-enter'} exit={draining ? 'none' : 'part-exit'}>
            <span className={styles.collapsedQueueBadge} data-tip={`${queueLength} queued roll${queueLength === 1 ? '' : 's'}`}>
              {queueLength} queued
            </span>
          </ViewTransition>
        )}
      </button>
      {draining && (
        <button
          ref={stopRef}
          type="button"
          className={styles.go}
          data-stop=""
          aria-label="Stop working through the queue"
          onClick={onStop}
        >
          Stop
          <span className={styles.spinner} aria-hidden="true" />
        </button>
      )}
      {canSubmit && enhance ? (
        <EnhanceControl
          working={enhance.working}
          disabled={false}
          needsTextModel={enhance.needsTextModel}
          iconOnly={enhance.iconOnly}
          onEnhance={enhance.onEnhance}
          enhanceRef={enhance.ref}
        />
      ) : null}
      {canSubmit && (
        <button ref={generateRef} type="button" className={styles.go} onClick={onSubmit}>
          Generate
        </button>
      )}
    </div>
  );
}
