import type { ArchivedTile } from '@atelier/shared';
import { createRoot } from 'react-dom/client';
import Archive from '../../src/components/Archive';
import styles from '../../src/App.module.css';
import '../../src/styles/global.css';

// Exercise the production layout with local fixtures and no API mutations.
const params = new URLSearchParams(window.location.search);
const count = Number(params.get('count') ?? '80');
const image = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="260" height="260"%3E%3Crect width="260" height="260" fill="%236b7771"/%3E%3C/svg%3E';
const items: ArchivedTile[] = Array.from({ length: count }, (_, index) => ({
  id: `archive-${index}`,
  batchId: `batch-${index}`,
  prompt: `Archive fixture ${index + 1}`,
  modelLabel: 'Archive fixture',
  status: 'done',
  url: image,
  ext: 'png',
  mime: 'image/png',
  ratio: '1:1',
  seed: index,
  completedAt: 1,
  archivedAt: 1,
}));
const noop = () => undefined;

// `?failFirst=<ms>` scripts Restore and Delete in memory: each tile's first
// attempt rejects after that delay and later attempts resolve after it. Every
// settlement is appended to `data-archive-settled` on <body> for the spec.
const failFirst = params.get('failFirst');
const attempts = new Map<string, number>();
const settled: string[] = [];
function scriptedAction(kind: 'restore' | 'delete'): (tileId: string) => unknown {
  if (failFirst === null) return noop;
  const delayMs = Number(failFirst);
  return (tileId) => {
    const key = `${kind}:${tileId}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    return new Promise<void>((resolve, reject) => {
      window.setTimeout(() => {
        settled.push(`${key}:${attempt === 1 ? 'rejected' : 'resolved'}`);
        document.body.dataset.archiveSettled = settled.join(',');
        if (attempt === 1) reject(new Error('scripted failure'));
        else resolve();
      }, delayMs);
    });
  };
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <div className={styles.app}>
      <main className={styles.main} style={{ gridColumn: '-2 / -1', gridRow: 1 }}>
        <div className={styles.viewSwap}>
          <Archive
            items={items}
            total={items.length}
            isLoading={false}
            isError={false}
            onRetry={noop}
            onRestore={scriptedAction('restore')}
            onPermanentDelete={scriptedAction('delete')}
            onPurgeAll={noop}
            onBack={noop}
            onOpenTile={noop}
          />
        </div>
      </main>
    </div>,
  );
}
