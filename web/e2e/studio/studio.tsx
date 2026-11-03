import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { installOfflineResponses } from './fixture';
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
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <App />
  </QueryClientProvider>,
);
