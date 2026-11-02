import { useCallback, useEffect, useRef } from 'react';

const COMPLETION_MARKER = '✓ ';

export function useBackgroundCompletionTitle(): () => void {
  const originalTitleRef = useRef(typeof document === 'undefined' ? 'Atelier' : document.title);
  const markedRef = useRef(false);

  const restore = useCallback(() => {
    if (typeof document === 'undefined' || !markedRef.current) return;
    document.title = originalTitleRef.current;
    markedRef.current = false;
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden) restore();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      restore();
    };
  }, [restore]);

  return () => {
    if (typeof document === 'undefined' || !document.hidden) return;
    if (!markedRef.current) originalTitleRef.current = document.title;
    document.title = `${COMPLETION_MARKER}${originalTitleRef.current}`;
    markedRef.current = true;
  };
}
