import { useEffect, useReducer } from 'react';
import { flushSync } from 'react-dom';
import { installViewTransitionGuard, registerCommitFlush } from '../../lib/viewTransitionGuard';

/**
 * Mounts the input guard (lib/viewTransitionGuard) on the app's root. It
 * renders nothing; its one piece of state exists so the guard can hand React
 * a synchronous update, which is what makes React commit a Transition that is
 * still waiting on a view transition's preparation.
 */
export function ViewTransitionGuard() {
  const [, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const uninstall = installViewTransitionGuard();
    const unregister = registerCommitFlush(() => {
      flushSync(() => { bump(); });
    });
    return () => {
      unregister();
      uninstall();
    };
  }, []);
  return null;
}
