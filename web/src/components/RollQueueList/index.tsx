import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import { useVerticalDragReorder } from '../../hooks/useVerticalDragReorder';
import { holdSubmissionUploads, useAtelierStore } from '../../store/atelier';
import type { QueuedRoll } from '../../store/atelier';
import { I } from '../icons/I';
import styles from './index.module.css';

interface RollQueueListProps {
  rolls: readonly QueuedRoll[];
  onRemove: (id: string) => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
  onClear: () => void;
  pinnedHeaderRow?: ReactNode;
  targetContextLine?: ReactNode;
  variant: 'inline' | 'panel';
  ariaLabel?: string;
}

export default function RollQueueList({
  rolls,
  onRemove,
  onReorder,
  onClear,
  pinnedHeaderRow,
  targetContextLine,
  variant,
  ariaLabel,
}: RollQueueListProps) {
  const addToast = useAtelierStore((state) => state.addToast);
  const restoreRollQueue = useAtelierStore((state) => state.restoreRollQueue);
  const queueRowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const [moveMessage, setMoveMessage] = useState('');
  const queueIds = rolls.map((roll) => roll.id);
  const queueReorder = useVerticalDragReorder<string>({
    ids: queueIds,
    onReorder: (nextIds, movedId) => {
      const fromIdx = rolls.findIndex((roll) => roll.id === movedId);
      const toIdx = nextIds.indexOf(movedId);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
      onReorder(fromIdx, toIdx);
    },
    getRowElement: (id) => queueRowRefs.current.get(id) ?? null,
    onAnnounce: setMoveMessage,
    thresholdPx: 4,
    dropIndicator: true,
    allowKeyboard: true,
  });
  const clear = () => {
    const snapshot = [...rolls];
    // Hold the snapshot's media before the queue lets go of it, until Undo
    // restores it or the toast leaves (its lifetime respects pause).
    const release = holdSubmissionUploads(snapshot.map((roll) => roll.submission));
    onClear();
    addToast('Queue cleared', 'soft', 5000, {
      label: 'Undo',
      onClick: () => {
        restoreRollQueue(snapshot);
        release();
      },
    }, release);
  };
  const statusText = `${rolls.length} roll${rolls.length === 1 ? '' : 's'} queued`;

  return (
    <section
      className={`${styles.block} ${variant === 'panel' ? styles.panel : styles.inline}`}
      role="region"
      aria-label={ariaLabel ?? `Roll-queue · ${rolls.length}`}
    >
      <span className="srOnly" role="status" aria-live="polite">{statusText}</span>
      <span className="srOnly" aria-live="polite">{moveMessage}</span>
      <div className={styles.meta}>
        <span>Queue · {rolls.length}</span>
        <button
          type="button"
          className={styles.clear}
          data-tip="Clear queued rolls"
          onClick={clear}
        >
          Clear
        </button>
      </div>
      {targetContextLine ? <div className={styles.target}>{targetContextLine}</div> : null}
      {pinnedHeaderRow ? <div className={styles.pinned}>{pinnedHeaderRow}</div> : null}
      <ul className={styles.list} role="list">
        {rolls.map((roll, index) => (
          <li
            key={roll.id}
            className={styles.row}
            ref={(el) => { if (el) queueRowRefs.current.set(roll.id, el); else queueRowRefs.current.delete(roll.id); }}
            tabIndex={0}
            aria-roledescription="Draggable queued roll"
            aria-label={`Queued roll ${index + 1} of ${rolls.length}: ${roll.text}`}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            {...queueReorder.pointerHandlers(roll.id)}
            {...(queueReorder.keyboardHandlers(roll.id) ?? {})}
          >
            <span className={styles.drag} aria-hidden="true"><I.grip /></span>
            <span className={styles.prompt}>{roll.text}</span>
            <span className={styles.seed}>Seed {roll.seed}</span>
            <button
              type="button"
              className={styles.remove}
              aria-label={`Remove queued roll · ${roll.text.slice(0, 32)}`}
              data-tip="Remove from queue"
              onClick={() => { onRemove(roll.id); }}
            >
              <I.close />
            </button>
          </li>
        ))}
        {queueReorder.dropIndicatorTop !== null ? (
          <li
            aria-hidden="true"
            className={styles.dropIndicator}
            style={{ transform: `translateY(${queueReorder.dropIndicatorTop}px)` }}
          />
        ) : null}
      </ul>
    </section>
  );
}
