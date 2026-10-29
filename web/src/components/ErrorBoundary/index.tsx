import { METRICS_LIMITS } from '@atelier/shared';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { sendMetricBeacon } from '../../lib/metricsBeacon';
import styles from './index.module.css';

// Render-time exceptions otherwise unmount the SPA via React's default
// recovery path — the user sees a blank page until they manually reload.
// componentDidCatch + getDerivedStateFromError keep the tree mounted, log
// the failure to the existing console transport, and surface a one-button
// recovery panel. No third-party library: the React 18 docs canonical
// pattern.

// Every bounded field is truncated to the api schema cap so a long message
// cannot 400 the beacon and silently drop the report.
export function renderErrorMetricPayload(error: Error, errorInfo: ErrorInfo) {
  return {
    kind: 'error',
    name: error.name.slice(0, METRICS_LIMITS.name),
    message: error.message.slice(0, METRICS_LIMITS.message),
    ...(error.stack !== undefined ? { stack: error.stack.slice(0, METRICS_LIMITS.stack) } : {}),
    ...(typeof errorInfo.componentStack === 'string'
      ? { componentStack: errorInfo.componentStack.slice(0, METRICS_LIMITS.stack) }
      : {}),
    userAgent: navigator.userAgent.slice(0, METRICS_LIMITS.userAgent),
    href: window.location.href.slice(0, METRICS_LIMITS.href),
  };
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
  readonly error: Error | null;
}

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  // When provided, a caught error renders this scoped fallback instead of the
  // full-page reload panel — keeps a failure in one lazy view from taking the
  // whole SPA down. The host clears it by remounting the boundary (e.g. a
  // route/view-key change).
  readonly fallback?: ReactNode;
  readonly resetKeys?: readonly unknown[];
}

function resetKeysChanged(previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  if (previous === undefined || next === undefined) return false;
  if (previous.length !== next.length) return true;
  return next.some((key, index) => !Object.is(key, previous[index]));
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Atelier render error', error, errorInfo);
    if (import.meta.env.DEV) return;
    sendMetricBeacon(renderErrorMetricPayload(error, errorInfo));
  }

  override componentDidUpdate(previousProps: ErrorBoundaryProps): void {
    if (this.state.hasError && resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)) {
      this.setState({ hasError: false, error: null });
    }
  }

  private readonly reload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <div className={styles.root} role="status">
          <div className={styles.panel}>
            <h1 className={styles.title}>Something went wrong</h1>
            <p className={styles.message}>The page hit an unexpected error and stopped responding.</p>
            {import.meta.env.DEV && this.state.error?.message ? (
              <pre className={styles.detail}>{this.state.error.message}</pre>
            ) : null}
            <button type="button" className={styles.reload} onClick={this.reload}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
