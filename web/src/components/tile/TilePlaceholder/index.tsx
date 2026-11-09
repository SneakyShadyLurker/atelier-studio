import { useQueryClient } from '@tanstack/react-query';
import type { Batch } from '@atelier/shared';
import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useCancel } from '../../../hooks/useCancel';
import { findTileInCache } from '../../../hooks/historyCache';
import { liveActiveScopeKey } from '../../../hooks/scopedHistoryMutation';
import { I } from '../../icons/I';
import LoadingTileBody from '../LoadingTile/body';
import loadingStyles from '../LoadingTile/index.module.css';
import QueuedTile from '../QueuedTile';
import { focusSuccessor, tileSuccessor } from '../../../lib/focusSuccessor';
import styles from './index.module.css';

interface TilePlaceholderProps {
  tileId: string;
  batchId: string;
  batchStatus: Batch['status'];
  aspectRatio: string;
  modelName: string;
  startedAt: number;
  queueLengthAhead?: number | undefined;
  seen?: boolean;
  isVideo?: boolean;
  sourceStillUrl?: string | undefined;
}

function TilePlaceholder({
  tileId,
  batchId,
  batchStatus,
  aspectRatio,
  modelName,
  startedAt,
  queueLengthAhead,
  seen = false,
  isVideo = false,
  sourceStillUrl,
}: TilePlaceholderProps) {
  const { cancelTile } = useCancel();
  const queryClient = useQueryClient();
  // Guards a second click or Escape while the optimistic removal is on its
  // way. The tile's exit is the Batch tile boundary's (motion.css
  // .tile-exit), so the cancel leaves at once and nothing is pending.
  const [canceling, setCanceling] = useState(false);
  const isQueued = batchStatus === 'queued';

  const triggerCancel = (from: HTMLElement) => {
    if (canceling) return;
    setCanceling(true);
    // The tile leaves with the cancel; the keyboard moves on before it does.
    focusSuccessor(tileSuccessor(from));
    // Suppress the cancel only when the tile is DEFINITIVELY already
    // terminal in cache (the feed renders a deferred snapshot, so the button
    // can outlive the tile's completion by a frame). A cache miss (undefined)
    // means the scope lookup was inconclusive — the live store scope can lag
    // the deferred-q query the tile is actually rendered from — so fall
    // through and send the DELETE anyway: it is server-idempotent (204
    // whether the row exists) and cancel-intent is classified server-side.
    const cached = findTileInCache(queryClient, liveActiveScopeKey(), batchId, tileId);
    if (cached !== undefined && cached.status !== 'loading') return;
    // useCancel surfaces a failure itself; the rejection is handled there.
    cancelTile(batchId, tileId).catch(() => undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      triggerCancel(event.currentTarget);
    }
  };

  return (
    <div className={loadingStyles.tile} data-feed-tile={tileId} data-seen={seen ? 'true' : undefined}>
      <button
        type="button"
        className={loadingStyles.cancelBtn}
        aria-label="Cancel generation"
        data-tip={canceling ? 'Canceling…' : 'Cancel generation'}
        data-tip-place="below-end"
        aria-busy={canceling || undefined}
        onClick={(event) => { event.stopPropagation(); triggerCancel(event.currentTarget); }}
        onKeyDown={onKeyDown}
      >
        <I.close />
      </button>
      <div className={loadingStyles.frame} style={{ aspectRatio }}>
        <div className={styles.layer} data-visible={isQueued ? 'true' : 'false'} aria-hidden={isQueued ? undefined : 'true'}>
          <QueuedTile queueLengthAhead={queueLengthAhead} />
        </div>
        <div className={styles.layer} data-visible={isQueued ? 'false' : 'true'} aria-hidden={isQueued ? 'true' : undefined}>
          {/* Mounted only once running: a queued tile has no progress to show,
              and its elapsed clock would tick invisibly behind the queued layer. */}
          {!isQueued && <LoadingTileBody tileId={tileId} batchId={batchId} modelName={modelName} startedAt={startedAt} isVideo={isVideo} sourceStillUrl={sourceStillUrl} />}
        </div>
      </div>
    </div>
  );
}

export default TilePlaceholder;
