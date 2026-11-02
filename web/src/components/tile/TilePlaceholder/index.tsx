import { useQueryClient } from '@tanstack/react-query';
import type { Batch } from '@atelier/shared';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useCancel } from '../../../hooks/useCancel';
import { findTileInCache } from '../../../hooks/historyCache';
import { liveActiveScopeKey } from '../../../hooks/scopedHistoryMutation';
import { motionDurationMs } from '../../../lib/overlayDuration';
import { I } from '../../icons/I';
import LoadingTileBody from '../LoadingTile/body';
import loadingStyles from '../LoadingTile/index.module.css';
import QueuedTile from '../QueuedTile';
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
  const [canceling, setCanceling] = useState(false);
  // A cancel waits for its exit animation before the optimistic removal
  // unmounts the tile. The pending send lives in a ref so an unmount during
  // that beat (virtualized scroll-out, view switch) flushes it instead of
  // silently dropping the user's cancel.
  const pendingCancelRef = useRef<{ timer: number; send: () => void } | null>(null);
  const isQueued = batchStatus === 'queued';

  useEffect(() => () => {
    const pending = pendingCancelRef.current;
    if (pending === null) return;
    window.clearTimeout(pending.timer);
    pending.send();
  }, []);

  const triggerCancel = () => {
    if (canceling) return;
    setCanceling(true);
    const send = () => {
      pendingCancelRef.current = null;
      // Suppress the cancel only when the tile is DEFINITIVELY already
      // terminal in cache. A cache miss (undefined) means the scope lookup
      // was inconclusive — the live store scope can lag the deferred-q query
      // the tile is actually rendered from — so fall through and send the
      // DELETE anyway: it is server-idempotent (204 whether the row exists)
      // and cancel-intent is classified server-side.
      const cached = findTileInCache(queryClient, liveActiveScopeKey(), batchId, tileId);
      if (cached !== undefined && cached.status !== 'loading') return;
      // useCancel surfaces a failure itself; the rejection is handled there.
      cancelTile(batchId, tileId).catch(() => undefined);
    };
    pendingCancelRef.current = { timer: window.setTimeout(send, motionDurationMs('--dur-sheet', 240)), send };
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      triggerCancel();
    }
  };

  return (
    <div
      className={loadingStyles.tile}
      data-seen={seen ? 'true' : undefined}
      data-canceling={canceling ? 'true' : undefined}
    >
      <button
        type="button"
        className={loadingStyles.cancelBtn}
        aria-label="Cancel generation"
        data-tip="Cancel generation"
        data-tip-place="below-end"
        onClick={(event) => { event.stopPropagation(); triggerCancel(); }}
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
