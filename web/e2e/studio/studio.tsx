import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { installOfflineResponses } from './fixture';
import { useAtelierStore } from '../../src/store/atelier';
import '../../src/styles/global.css';

if (!import.meta.env.DEV) throw new Error('Studio preview is dev-only');
installOfflineResponses();
if (new URLSearchParams(window.location.search).get('toast') === '1') {
  useAtelierStore.getState().addToast('Preview ready', 'success', 60_000, { label: 'Undo', onClick: () => undefined });
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing preview root');
createRoot(root).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <App />
  </QueryClientProvider>,
);
