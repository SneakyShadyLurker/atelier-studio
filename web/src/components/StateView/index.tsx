import type { ReactNode } from 'react';
import { I } from '../icons/I';
import buttons from '../../styles/buttons.module.css';
import styles from './index.module.css';

export interface StateViewAction {
  label: string;
  onClick: () => void;
}

interface StateViewProps {
  glyph: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  action?: StateViewAction;
  // Loading and static error pages should be passive; transient inline errors
  // can opt into alert semantics at their own call sites.
  role?: 'alert' | 'status';
}

// Single source of truth for the empty / error / loading presentation across
// every full-screen view (Canvas, Archive, PromptManager). Structure + styling
// live here; per-screen copy and the (contextual) empty glyph stay as props.
// Loading and error glyphs are baked into the wrappers below so those two
// states are pixel-identical on every screen.
export function StateView({ glyph, title, body, action, role }: StateViewProps) {
  return (
    <div className={styles.state} {...(role ? { role } : {})}>
      <div className={styles.glyph}>{glyph}</div>
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

// Loading/error glyphs are drawn through the shared icon set (14×14 grid,
// 2px stroke) and scaled up — so empty-state glyphs read at the same weight
// as every other icon in the product.
export function LoadingState({ label }: { label: string }) {
  return <StateView glyph={<I.sun width={22} height={22} />} title={label} role="status" />;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <StateView
      glyph={<I.alert width={22} height={22} />}
      title={message}
      {...(onRetry ? { action: { label: 'Retry', onClick: onRetry } } : {})}
    />
  );
}
