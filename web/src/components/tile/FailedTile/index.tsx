import type { Tile, TileErrorCategory } from '@atelier/shared';
import { I } from '../../icons/I';
import { moderationCopy, useModerationNotice } from '../../../lib/moderationNotice';
import styles from './index.module.css';

interface FailedTileProps {
  tile: Extract<Tile, { status: 'failed' }>;
  aspectRatio: string;
  seen?: boolean;
  disabled?: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}

type FailureBucket = 'content-policy' | 'rejected' | 'connection' | 'server' | 'unavailable';

function classifyFailure(error: TileErrorCategory): FailureBucket {
  switch (error) {
    case 'content-policy violation':
      return 'content-policy';
    case 'upstream rejected':
      return 'rejected';
    case 'connection lost':
    case 'client disconnected':
    case 'timed out':
    case 'interrupted':
      return 'connection';
    case 'internal error':
    case 'unsupported format':
      return 'server';
    case 'service unavailable':
      return 'unavailable';
    default: {
      const _exhaustive: never = error;
      return 'server';
    }
  }
}

function failureMessage(bucket: FailureBucket): string {
  switch (bucket) {
    case 'content-policy':
      return 'Your prompt was flagged by content safety. Reword it in the composer and run a new generation.';
    case 'rejected':
      return 'The image service rejected this request. Try a different prompt or try again in a moment.';
    case 'connection':
      return 'The connection to the image service dropped before the image arrived. Please try again.';
    case 'server':
      return 'Something went wrong on our end. Please try again.';
    case 'unavailable':
      return 'The image service is temporarily unavailable. Please try again in a moment.';
  }
}

function FailedTile({ tile, aspectRatio, seen = false, disabled = false, onRetry, onDismiss }: FailedTileProps) {
  const bucket = classifyFailure(tile.error);
  const showRetry = bucket !== 'content-policy';
  const moderation = tile.moderation;
  const copy = moderation ? moderationCopy(moderation) : null;
  return (
    <div className={styles.tile} data-seen={seen ? 'true' : undefined} data-moderation={moderation ? 'true' : undefined}>
      <div className={styles.frame} style={{ aspectRatio }}>
        <div className={styles.body}>
          <div className={styles.icon}>
            <I.alert />
          </div>
          <div className={styles.title}>{copy?.title ?? 'Generation failed'}</div>
          <div className={styles.message}>{copy ? `${copy.label}. ${copy.delivery}.` : failureMessage(bucket)}</div>
          <div className={styles.actions}>
            {moderation ? (
              <button className={styles.mini} type="button" onClick={() => { useModerationNotice.getState().show(moderation); }}>
                Details
              </button>
            ) : null}
            {showRetry ? (
              <button className={styles.mini} type="button" aria-label="Retry failed tile" disabled={disabled} onClick={onRetry}>
                <I.reroll />
                Retry
              </button>
            ) : null}
            <button className={styles.mini} type="button" aria-label="Dismiss failed tile" disabled={disabled} onClick={onDismiss}>
              <I.close />
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default FailedTile;
