import { useInfiniteQuery } from '@tanstack/react-query';
import type { Batch, Model } from '@atelier/shared';
import { memo, useDeferredValue, useMemo, ViewTransition } from 'react';
import { historyOpts } from '../../api/history';
import type { ActiveModelCounts } from '../../lib/historyAggregation';
import styles from './index.module.css';

interface InFlightIndicatorProps {
  pool: Model['pool'];
  cap: number;
  modelById: ReadonlyMap<string, Model>;
  // Count of individual prompts still being resolved (ai-fill + format) before
  // their generate() fires. Rendered as a "Preparing N more…" chip that persists
  // alongside running/queued tiles as the pipeline drains; the at-capacity badge
  // still takes precedence.
  preparing?: number;
  // In-flight ai-fill count per text model id; names come from `labelById`.
  aiFillActive: Readonly<Record<string, number>>;
  labelById: ReadonlyMap<string, string>;
}

const UNKNOWN_TEXT_MODEL = 'a text model';

function InFlightIndicator({
  pool,
  cap,
  modelById,
  preparing = 0,
  aiFillActive,
  labelById,
}: InFlightIndicatorProps) {
  const historyQuery = useInfiniteQuery(historyOpts({ kind: 'unsorted' }, '', false));
  const activeByModel = historyQuery.data?.activeByModel;
  const { count, queueDepth } = activeByModel
    ? countFromActiveByModel(activeByModel, modelById, pool)
    : countFromBatches(historyQuery.data?.pages.flatMap((page) => page.items) ?? [], modelById, pool);

  const atCap = cap > 0 && count >= cap;
  const queueText = queueDepth > 0 ? `${queueDepth} queued` : null;
  const label = `${atCap ? 'All slots busy — new batches will queue — ' : ''}${count} of ${cap} tile slots in use${queueText ? `, ${queueText}` : ''}`;
  // Labels derive from whichever models are actually in flight — no
  // combinatorial table. Pill keeps a short form; the live region spells names.
  // Distinct names, so two unknown ids don't read "a text model + a text model".
  const activeNames = [...new Set(Object.entries(aiFillActive)
    .filter(([, active]) => active > 0)
    .map(([modelId]) => labelById.get(modelId) ?? UNKNOWN_TEXT_MODEL))];
  const backendLabel = activeNames.length > 0 ? activeNames.join(' + ') : null;
  const fullNames = activeNames.length > 0 ? joinNames(activeNames) : null;
  const verb = activeNames.length > 1 ? 'are' : 'is';
  // "Preparing N more…" persists alongside tiles as the pipeline resolves the
  // rest of the burst (it takes the slot over the plain tile count). At-capacity
  // still wins both the chip and the live region so preparing never masks the
  // server-owned capacity state.
  const tileVisible = !(count <= 0 && queueDepth <= 0) && cap > 0;
  const showPreparing = !atCap && (preparing > 0 || backendLabel !== null);
  const preparingLabel = sentenceCase(preparing > 0
    ? fullNames !== null
      ? `${fullNames} ${verb} preparing ${preparing} more…`
      : `Preparing ${preparing} more…`
    : `${fullNames ?? ''} ${verb} filling the prompt…`);
  const liveText = atCap ? label : showPreparing ? preparingLabel : '';
  // The pill renders from a deferred snapshot so it mounts, swaps and
  // unmounts in a Transition through its part boundary; the live region
  // above stays urgent so announcements are never delayed.
  const liveChip = useMemo(() => (showPreparing
    ? { kind: 'preparing' as const, label: preparingLabel, preparing, backendLabel }
    : tileVisible
      ? { kind: 'tile' as const, label, count, cap, queueText, atCap }
      : null), [showPreparing, preparingLabel, preparing, backendLabel, tileVisible, label, count, cap, queueText, atCap]);
  const chip = useDeferredValue(liveChip);
  return (
    <>
      <span className="srOnly" aria-live="polite">{liveText}</span>
      {chip?.kind === 'preparing' ? (
        <ViewTransition key="preparing" default="none" enter="part-enter" exit="part-exit">
          <span className={`${styles.inFlight} ${styles.inFlightPreparing}`} aria-label={chip.label}>
            {chip.preparing > 0 ? <span aria-hidden="true">{chip.preparing}</span> : null}
            <span aria-hidden="true" className={styles.inFlightQueue}>
              {chip.preparing > 0 ? chip.backendLabel ?? 'preparing' : chip.backendLabel}
            </span>
          </span>
        </ViewTransition>
      ) : chip?.kind === 'tile' ? (
        <ViewTransition key="tile" default="none" enter="part-enter" exit="part-exit">
          <span className={`${styles.inFlight} ${chip.atCap ? styles.inFlightAtCap : ''}`} aria-label={chip.label}>
            <span aria-hidden="true">{chip.count}/{chip.cap}</span>
            {chip.queueText ? <span aria-hidden="true" className={styles.inFlightQueue}>{chip.queueText}</span> : null}
          </span>
        </ViewTransition>
      ) : null}
    </>
  );
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "A", "A and B", "A, B and C" — no combinatorial table as models grow. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function countFromActiveByModel(
  activeByModel: Readonly<Record<string, ActiveModelCounts>>,
  modelById: ReadonlyMap<string, Model>,
  pool: Model['pool'],
): { count: number; queueDepth: number } {
  let runningTiles = 0;
  let queuedBatches = 0;
  for (const [modelId, model] of modelById) {
    if (model.pool !== pool) continue;
    const counts = activeByModel[modelId];
    if (!counts) continue;
    runningTiles += counts.runningTiles;
    queuedBatches += counts.queuedBatches;
  }
  return { count: runningTiles, queueDepth: queuedBatches };
}

function countFromBatches(
  batches: readonly Batch[],
  modelById: ReadonlyMap<string, Model>,
  pool: Model['pool'],
): { count: number; queueDepth: number } {
  let runningTiles = 0;
  let queuedBatches = 0;
  for (const batch of batches) {
    if (modelById.get(batch.modelId)?.pool !== pool) continue;
    if (batch.status === 'running') runningTiles += batch.tiles.filter((tile) => tile.status === 'loading').length;
    else if (batch.status === 'queued') queuedBatches += 1;
  }
  return { count: runningTiles, queueDepth: queuedBatches };
}

export default memo(InFlightIndicator);
