import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { batches, installOfflineResponses } from './fixture';
import { historyKeys } from '../../src/api/history';
import { updateBatchStatus, updateBatchTile, upsertNewBatch } from '../../src/hooks/historyCache';
import { useAtelierStore } from '../../src/store/atelier';
import '../../src/styles/global.css';

if (!import.meta.env.DEV) throw new Error('Studio preview is dev-only');
installOfflineResponses();
const studioParams = new URLSearchParams(window.location.search);
if (studioParams.get('toast') === '1') {
  // `toastMs` shortens the Undo toast's life for the timer-pause specs.
  const toastMs = Number(studioParams.get('toastMs') ?? 60_000);
  useAtelierStore.getState().addToast('Preview ready', 'success', toastMs, { label: 'Undo', onClick: () => undefined });
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing preview root');
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
// On-demand SSE-equivalent cache writes, isolated to the modal motion fixture.
// Unlike generateFinish's timer, these can land precisely while a modal is open.
declare global {
  interface Window {
    __studioMotion?: { insert: (id: string) => void; complete: (id: string) => void };
  }
}
if (studioParams.get('modalMotion') === '1') {
  const source = batches[3];
  const image = source?.tiles[0];
  if (!source || image?.status !== 'done') throw new Error('Missing motion fixture batch');
  window.__studioMotion = {
    insert(id) {
      upsertNewBatch(queryClient, historyKeys.list(), {
        ...source, id, createdAt: Date.now(), status: 'running',
        tiles: [{ id: `${id}-tile`, status: 'loading', seed: 1 }],
      });
    },
    complete(id) {
      updateBatchTile(queryClient, historyKeys.list(), id, {
        ...image, id: `${id}-tile`, status: 'done', completedAt: Date.now(),
      });
      updateBatchStatus(queryClient, historyKeys.list(), id, { status: 'done' });
    },
  };
}
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
