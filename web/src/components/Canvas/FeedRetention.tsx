import { useQueryClient } from '@tanstack/react-query';
import { useEffect, type RefObject } from 'react';
import { historyKeys } from '../../api/history';
import { trimHistoryPages } from '../../hooks/historyRetention';
import type { AppView } from '../../store/atelier';

/** How long a reader rests at the newest end before older pages are let go, and the re-check cadence while they stay. */
export const FEED_RETENTION_REST_MS = 20_000;

interface FeedRetentionProps {
  view: AppView;
  q: string;
  /** The reader is at the newest end (a state change starts the rest timer). */
  atEnd: boolean;
  /** The live at-end flag, read when a timer or the visibility change fires. */
  atEndRef: RefObject<boolean>;
}

/**
 * The reader-position half of bounded retention (R7): trims the active scope
 * to its newest pages when the document hides while the reader is at the
 * newest end, and after the reader has rested there for 20 s, re-checking
 * every 20 s while they stay, so a trim blocked by a fetch or a pending
 * history write is retried. Mounted only with live rows (it needs the
 * QueryClient, and placeholder rows belong to another scope).
 */
export function FeedRetention({ view, q, atEnd, atEndRef }: FeedRetentionProps) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const key = historyKeys.scoped(view, q);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && atEndRef.current) trimHistoryPages(queryClient, key);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); };
  }, [queryClient, view, q, atEndRef]);

  useEffect(() => {
    if (!atEnd) return;
    const key = historyKeys.scoped(view, q);
    const timer = setInterval(() => {
      if (atEndRef.current) trimHistoryPages(queryClient, key);
    }, FEED_RETENTION_REST_MS);
    return () => { clearInterval(timer); };
  }, [queryClient, view, q, atEnd, atEndRef]);

  return null;
}
