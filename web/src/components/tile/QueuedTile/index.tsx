import { queueLabel } from '../../../lib/queueLabel';
import { I } from '../../icons/I';
import styles from './index.module.css';

interface QueuedTileProps {
  queueLengthAhead?: number | undefined;
}

function QueuedTile({ queueLengthAhead }: QueuedTileProps) {
  const label = queueLabel(queueLengthAhead);
  // role="img" + a concise label = a single static announcement. The model is
  // already in the batch header's a11y tree, so it isn't repeated here.
  return (
    <div
      className={styles.queued}
      role="img"
      aria-label={label}
    >
      <div className={styles.sheen} aria-hidden="true" />
      <div className={styles.text}>
        <I.clock />
        <span>{label}</span>
      </div>
    </div>
  );
}

export default QueuedTile;
