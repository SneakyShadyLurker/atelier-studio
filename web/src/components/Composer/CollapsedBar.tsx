import type { Ref } from 'react';
import { I } from '../icons/I';
import styles from './index.module.css';

interface CollapsedBarProps {
  prompt: string;
  placeholder?: string | undefined;
  refCount: number;
  queueLength?: number;
  canSubmit: boolean;
  /** Admission is stoppable: the bar offers Stop, never Generate. */
  draining?: boolean;
  onStop?: () => void;
  dangerTint: boolean;
  onExpand: () => void;
  onSubmit: () => void;
  ref?: Ref<HTMLButtonElement>;
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
  ref,
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
      >
        <span className={styles.collapsedPrompt} data-empty={prompt.trim() ? undefined : 'true'}>
          {prompt.trim() || placeholder}
        </span>
        {refCount > 0 && (
          <span className={styles.collapsedRefBadge} aria-hidden="true">
            {refCount}
          </span>
        )}
        {queueLength > 0 && (
          <span className={styles.collapsedQueueBadge} data-tip={`${queueLength} queued roll${queueLength === 1 ? '' : 's'}`}>
            · {queueLength} queued
          </span>
        )}
      </button>
      {draining ? (
        <button
          type="button"
          className={styles.go}
          data-stop=""
          aria-label="Stop working through the queue"
          onClick={onStop}
        >
          Stop
          <span className={styles.spinner} aria-hidden="true" />
        </button>
      ) : canSubmit && (
        <button type="button" className={styles.go} onClick={onSubmit}>
          Generate
          <I.arrow />
        </button>
      )}
    </div>
  );
}
