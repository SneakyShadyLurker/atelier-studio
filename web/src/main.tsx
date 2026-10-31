import React, { useEffect, useState } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { createRoot } from 'react-dom/client';
import { prepareQueueLiveRegion } from './lib/queueLiveAnnouncer';
import { flushSync } from 'react-dom';
import App from './App';
import { bootstrapSession, fetchSession } from './api/session';
import { collectionKeys } from './api/collections';
import { historyKeys } from './api/history';
import { modelKeys } from './api/models';
import { promptKeys } from './api/prompts';
import { ErrorBoundary } from './components/ErrorBoundary';
import { createIDBPersister, PERSIST_CACHE_VERSION, preparePersistenceScope, shouldDehydrateQuery } from './lib/persister';
import { createPreloadErrorHandler } from './lib/preloadRecovery';
import { loadComposerPrefs, setComposerPrefsScope } from './lib/composerPrefs';
import { loadRollQueue, persistRollQueue, setRollQueueScope } from './lib/rollQueuePersist';
import { useAtelierStore } from './store/atelier';
import { isSessionLocked, onSessionScopeInvalidated } from './lib/sessionScope';
import './styles/global.css';

// Lazy so web-vitals (and its reporting code) splits off the entry chunk and
// loads only once the app is idle.
const loadWebVitals = () => { void import('./lib/webVitals').then((m) => { m.startWebVitals(); }); };

const root = document.getElementById('root');
// Mutations must never auto-retry: a retried /generate or /uploads would
// double-charge the upstream provider and double-reserve server concurrency
// slots. Make the no-retry contract explicit rather than relying on the
// TanStack v5 library default (matches all test harnesses).
// A failed lazy chunk (redeploy skew or a dropped network) reloads only when no
// in-memory draft would be lost; otherwise it offers the reload. See
// lib/preloadRecovery.ts.
window.addEventListener('vite:preloadError', createPreloadErrorHandler());

if (!root) {
  throw new Error('Missing #root mount node');
}

interface ReadyRuntime {
  readonly queryClient: QueryClient;
  readonly persister: ReturnType<typeof createIDBPersister>;
}

function SessionScopedApp() {
  const [attempt, setAttempt] = useState(0);
  const [runtime, setRuntime] = useState<ReadyRuntime | null>(null);
  const [error, setError] = useState(false);
  const retry = () => {
    if (isSessionLocked()) {
      window.location.reload();
      return;
    }
    setRuntime(null);
    setError(false);
    setAttempt((value) => value + 1);
  };

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let ready: ReadyRuntime | undefined;
    const unsubscribe = onSessionScopeInvalidated(() => {
      active = false;
      controller.abort();
      // Locking already stopped network and persistence. Remove the rendered
      // account before clearing its cache, then reload discards all singletons.
      flushSync(() => { setRuntime(null); setError(true); });
      ready?.queryClient.clear();
    });
    const checkSession = () => {
      if (ready && !isSessionLocked()) void fetchSession(controller.signal).catch(() => undefined);
    };
    window.addEventListener('focus', checkSession);
    void bootstrapSession(controller.signal).then(async ({ cacheScope }) => {
      await preparePersistenceScope(cacheScope);
      if (!active || isSessionLocked()) return;
      setRollQueueScope(cacheScope);
      useAtelierStore.getState().hydrateRollQueue(loadRollQueue());
      persistRollQueue(useAtelierStore.getState().draft.rollQueue);
      setComposerPrefsScope(cacheScope);
      useAtelierStore.getState().hydrateComposerPrefs(loadComposerPrefs());
      ready = {
        queryClient: new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
        persister: createIDBPersister(cacheScope),
      };
      setRuntime(ready);
    }).catch(() => { if (active) setError(true); });
    return () => {
      active = false;
      controller.abort();
      unsubscribe();
      window.removeEventListener('focus', checkSession);
    };
  }, [attempt]);

  if (!runtime) {
    return (
      <main className="bootstrapState" role="status" aria-live="polite">
        <span className="bootstrapMark" aria-hidden="true" />
        <h1>{error ? (isSessionLocked() ? 'Session changed' : 'Atelier unavailable') : 'Opening Atelier…'}</h1>
        {error && <button type="button" onClick={retry}>{isSessionLocked() ? 'Reload' : 'Retry'}</button>}
      </main>
    );
  }

  const { queryClient, persister } = runtime;
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 5 * 60 * 1000,
        buster: PERSIST_CACHE_VERSION,
        dehydrateOptions: { shouldDehydrateQuery },
      }}
      onSuccess={() => {
        void queryClient.invalidateQueries({ queryKey: historyKeys.all() });
        void queryClient.invalidateQueries({ queryKey: collectionKeys.all() });
        void queryClient.invalidateQueries({ queryKey: modelKeys.all() });
        void queryClient.invalidateQueries({ queryKey: promptKeys.all() });
      }}
    >
      <App />
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </PersistQueryClientProvider>
  );
}

prepareQueueLiveRegion();
createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SessionScopedApp />
    </ErrorBoundary>
  </React.StrictMode>,
);

if ('requestIdleCallback' in window) {
  window.requestIdleCallback(() => { loadWebVitals(); });
} else {
  setTimeout(loadWebVitals, 0);
}
