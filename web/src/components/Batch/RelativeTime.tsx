import { useNowTick } from '../../hooks/useNowTick';

function format(timestamp: number, now: number): string {
  const diff = (now - timestamp) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

// Isolating the 30s clock here means a tick re-renders only this label, not
// the whole BatchView header subtree (one leaf per visible batch).
export function RelativeTime({ timestamp }: { timestamp: number }) {
  const now = useNowTick(30_000);
  return <>{format(timestamp, now)}</>;
}
