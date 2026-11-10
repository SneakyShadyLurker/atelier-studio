import type { Batch, Model } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Canvas from '../../src/components/Canvas';
import { APP_VIEW_UNSORTED } from '../../src/store/atelier';
import '../../src/styles/global.css';

/*
 * The real feed (Canvas, virtualized) under StrictMode, as src/main.tsx
 * renders it, with authenticated-style media URLs. media-session-cache.spec.ts
 * serves `/api/img/*` through page.route and counts the requests per URL.
 * Dev-server only, like the other harness entries.
 */
const MODEL: Model = {
  id: 'gpt-image-2.6-sunburst',
  name: 'GPT Image',
  backend: 'cloud',
  tag: 'cloud',
  latency: 'slow',
  supportedRatios: ['1:1'],
  concurrencyCapPerUser: 4,
  maxCountPerBatch: 4,
  pool: 'shared',
  supportsReferenceImages: true,
};

const count = Number(new URLSearchParams(window.location.search).get('count') ?? '40');
const batches: Batch[] = Array.from({ length: count }, (_, index) => ({
  id: `batch-${index}`,
  prompt: `Media prompt ${index}`,
  ratio: '1:1',
  modelId: MODEL.id,
  modelLabel: MODEL.name,
  createdAt: index + 1,
  collectionId: null,
  pinned: false,
  status: 'done',
  tiles: [{
    id: `tile-${index}`,
    status: 'done',
    url: `/api/img/tile-${index}?media=2`,
    thumbUrl: `/api/img/tile-${index}/thumb?media=2`,
    ext: 'png',
    mime: 'image/png',
    seed: index,
    completedAt: index + 1,
  }],
}));
const modelById = new Map([[MODEL.id, MODEL]]);
const noop = () => undefined;

function MediaCase() {
  return (
    <div style={{ position: 'fixed', inset: 0, paddingLeft: 248, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Canvas
          batches={batches}
          modelById={modelById}
          collections={[]}
          activeView={APP_VIEW_UNSORTED}
          hasNextPage={false}
          isFetchingNextPage={false}
          onLoadMore={noop}
          onBatchAction={noop}
          promptsEnabled={false}
          onTileAction={noop}
          onOpenTile={noop}
          q=""
        />
      </div>
      <div style={{ height: 120 }} />
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <MediaCase />
      </QueryClientProvider>
    </StrictMode>,
  );
}
