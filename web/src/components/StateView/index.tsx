import type { ReactNode } from 'react';
import { Etching, type EtchingId } from '../Etching';
import buttons from '../../styles/buttons.module.css';
import styles from './index.module.css';

export interface StateViewAction {
  label: string;
  onClick: () => void;
}

interface StateViewProps {
  // Art surfaces show their etching in the plate; `restPlate` shows the
  // empty plate at rest (loading); `glyph` stays for the few icon-only
  // states (the scoped view error fallbacks).
  art?: EtchingId;
  restPlate?: boolean;
  glyph?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  action?: StateViewAction;
  // Loading and static error pages should be passive; transient inline errors
  // can opt into alert semantics at their own call sites.
  role?: 'alert' | 'status';
  // Host sizing only (a dialog body or card sets its own min-height).
  className?: string | undefined;
}

// Single source of truth for the empty / error / loading presentation across
// every full-screen view (Canvas, Archive, PromptManager). Structure + styling
// live here; per-screen copy and the (contextual) art stay as props.
// Loading and error states are baked into the wrappers below so those two
// states are pixel-identical on every screen.
export function StateView({ art, restPlate = false, glyph, title, body, action, role, className }: StateViewProps) {
  return (
    <div className={className ? `${styles.state} ${className}` : styles.state} {...(role ? { role } : {})}>
      {art !== undefined ? (
        <div className={styles.plate}>
          <Etching id={art} />
        </div>
      ) : restPlate ? (
        <div className={styles.restPlate} aria-hidden="true" />
      ) : glyph != null ? (
        <div className={styles.glyph}>{glyph}</div>
      ) : null}
      <h2>{title}</h2>
      {body != null ? <p>{body}</p> : null}
      {action ? (
        <button className={buttons.secondary} type="button" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

// Loading shows the plate at rest, the same mat LazyFallback shows: loading,
// empty and error speak one language (design 5, State views).
export function LoadingState({ label }: { label: string }) {
  return <StateView restPlate title={label} role="status" />;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <StateView
      art="state-error"
      title={message}
      {...(onRetry ? { action: { label: 'Retry', onClick: onRetry } } : {})}
    />
  );
}
