import { I } from '../icons/I';
import buttons from '../../styles/buttons.module.css';
import styles from './index.module.css';

interface JumpToLatestProps {
  /** Shown while the reader is more than one viewport from the newest end. */
  visible: boolean;
  /** A batch arrived or finished below since the reader left the end. */
  marker: boolean;
  onJump: () => void;
}

/**
 * The feed's one way back to the newest work for a reader scrolled into
 * history (the feed follows new work only from the end). It stays mounted so
 * it can leave on the same transition it enters with; hidden, it is
 * `display: none` and out of the tab order and accessibility tree.
 */
export function JumpToLatest({ visible, marker, onJump }: JumpToLatestProps) {
  return (
    <button
      type="button"
      className={`${buttons.iconAction} ${styles.jump}`}
      data-visible={visible ? 'true' : undefined}
      data-marker={marker ? 'true' : undefined}
      aria-label="Jump to latest"
      data-tip="Jump to latest"
      data-testid="jump-to-latest"
      onClick={onJump}
    >
      <I.arrow className={styles.glyph} />
      {marker ? <span className={styles.marker} aria-hidden="true" /> : null}
    </button>
  );
}
