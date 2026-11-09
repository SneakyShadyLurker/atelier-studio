import { useNowTick } from '../../hooks/useNowTick';

// One formatter for every row; constructing Intl.DateTimeFormat per render is
// the expensive part of toLocaleDateString.
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'short' });

function format(timestamp: number, now: number): string {
  const diff = (now - timestamp) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return DATE_FORMAT.format(timestamp);
}

// Isolating the 30s clock here means a tick re-renders only this label, not
// the whole BatchView header subtree (one leaf per visible batch). A bare
// text node on purpose: an inline wrapper changed the rail row's line box by
// a fraction of a pixel, which the virtualizer then measured.
export function RelativeTime({ timestamp }: { timestamp: number }) {
  const now = useNowTick(30_000);
  return <>{format(timestamp, now)}</>;
}
