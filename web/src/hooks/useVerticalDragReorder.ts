import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

export interface UseVerticalDragReorderOptions<TId extends string> {
  ids: readonly TId[];
  onReorder: (nextIds: TId[], movedId: TId) => void;
  getRowElement: (id: TId) => HTMLElement | null;
  thresholdPx?: number;
  dropIndicator?: boolean;
  onAnnounce?: (message: string) => void;
  allowKeyboard?: boolean;
  disabled?: boolean;
}

export interface UseVerticalDragReorderResult<TId extends string = string> {
  pointerHandlers: (id: TId) => {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  };
  keyboardHandlers: (id: TId) => { onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void } | undefined;
  dropIndicatorTop: number | null;
  isDragging: boolean;
  suppressClick: (id: TId) => boolean;
}

interface DragState<TId extends string> {
  id: TId;
  pointerId: number;
  startY: number;
  clientY: number;
  targetIndex: number;
  active: boolean;
}

const DEFAULT_THRESHOLD_PX = 6;
const SCROLL_EDGE_PX = 24;
const SCROLL_STEP_PX = 6;

function moveId<TId extends string>(ids: readonly TId[], id: TId, targetIndex: number): TId[] | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const dest = targetIndex > from ? targetIndex - 1 : targetIndex;
  if (dest === from || dest < 0 || dest >= ids.length) return null;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(dest, 0, id);
  return next;
}

function dropIndicatorOffset<TId extends string>(
  ids: readonly TId[],
  targetIndex: number,
  getRowElement: (id: TId) => HTMLElement | null,
): number | null {
  const firstElement = ids[0] ? getRowElement(ids[0]) : null;
  const parent = firstElement?.parentElement;
  if (!parent) return null;
  const parentRect = parent.getBoundingClientRect();
  if (targetIndex >= ids.length) {
    const lastId = ids[ids.length - 1];
    const lastElement = lastId ? getRowElement(lastId) : null;
    if (!lastElement) return null;
    return lastElement.getBoundingClientRect().bottom - parentRect.top + parent.scrollTop - parent.clientTop - 1;
  }
  const targetId = ids[targetIndex];
  const targetElement = targetId ? getRowElement(targetId) : null;
  if (!targetElement) return null;
  return targetElement.getBoundingClientRect().top - parentRect.top + parent.scrollTop - parent.clientTop - 1;
}

export function useVerticalDragReorder<TId extends string>({
  ids,
  onReorder,
  getRowElement,
  thresholdPx = DEFAULT_THRESHOLD_PX,
  dropIndicator = false,
  onAnnounce,
  allowKeyboard = false,
  disabled = false,
}: UseVerticalDragReorderOptions<TId>): UseVerticalDragReorderResult<TId> {
  const dragRef = useRef<DragState<TId> | null>(null);
  const [drag, setDrag] = useState<DragState<TId> | null>(null);
  const [suppressId, setSuppressId] = useState<TId | null>(null);

  const computeTargetIndex = useCallback((clientY: number): number => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) continue;
      const element = getRowElement(id);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return ids.length;
  }, [getRowElement, ids]);

  const commit = useCallback((id: TId, targetIndex: number) => {
    const next = moveId(ids, id, targetIndex);
    if (!next) return false;
    onReorder(next, id);
    return true;
  }, [ids, onReorder]);

  const handlePointerMove = useCallback((event: Pick<PointerEvent, 'pointerId' | 'clientY'>) => {
    const current = dragRef.current;
    if (current?.pointerId !== event.pointerId) return;
    if (!current.active && Math.abs(event.clientY - current.startY) < thresholdPx) return;
    const next: DragState<TId> = {
      ...current,
      active: true,
      clientY: event.clientY,
      targetIndex: computeTargetIndex(event.clientY),
    };
    dragRef.current = next;
    setSuppressId(next.id);
    setDrag(next);
  }, [computeTargetIndex, thresholdPx]);

  const finishPointer = useCallback((event: Pick<PointerEvent, 'pointerId' | 'clientY'>, canceled: boolean) => {
    const current = dragRef.current;
    if (current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (canceled) {
      setSuppressId(null);
      return;
    }
    if (!current.active) {
      setSuppressId(null);
      return;
    }
    if (!ids.includes(current.id)) {
      onAnnounce?.('Reorder cancelled: item no longer exists');
    } else {
      commit(current.id, computeTargetIndex(event.clientY));
    }
    window.setTimeout(() => { setSuppressId(null); }, 0);
  }, [commit, computeTargetIndex, ids, onAnnounce]);

  const pointerHandlers = (id: TId) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (disabled) return;
      if (event.button !== 0 || event.pointerType === 'touch' || event.pointerType === 'pen') return;
      if (!ids.includes(id)) return;
      const next: DragState<TId> = {
        id,
        pointerId: event.pointerId,
        startY: event.clientY,
        clientY: event.clientY,
        targetIndex: ids.indexOf(id),
        active: false,
      };
      dragRef.current = next;
      setDrag(next);
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* happy-dom and Safari can decline capture */ }
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => { handlePointerMove(event.nativeEvent); },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => { finishPointer(event.nativeEvent, false); },
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => {
      finishPointer({ pointerId: dragRef.current?.pointerId ?? event.nativeEvent.pointerId, clientY: event.nativeEvent.clientY }, true);
    },
  });

  useEffect(() => {
    if (!drag) return;

    const onPointerMove = (event: PointerEvent) => { handlePointerMove(event); };
    const onPointerUp = (event: PointerEvent) => { finishPointer(event, false); };
    const onPointerCancel = (event: PointerEvent) => { finishPointer(event, true); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      dragRef.current = null;
      setDrag(null);
      setSuppressId(null);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [drag, finishPointer, handlePointerMove]);

  useEffect(() => {
    if (!drag?.active) return;
    let ancestor = getRowElement(drag.id)?.parentElement ?? null;
    while (ancestor) {
      const overflowY = window.getComputedStyle(ancestor).overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && ancestor.scrollHeight > ancestor.clientHeight) break;
      ancestor = ancestor.parentElement;
    }
    if (!ancestor) return;
    const scrollContainer = ancestor;
    const refreshTarget = () => {
      const current = dragRef.current;
      if (!current?.active) return;
      const next = { ...current, targetIndex: computeTargetIndex(current.clientY) };
      dragRef.current = next;
      // A new drag snapshot also invalidates the indicator's geometry memo.
      setDrag(next);
    };
    scrollContainer.addEventListener('scroll', refreshTarget);

    const rect = scrollContainer.getBoundingClientRect();
    const top = rect.top + scrollContainer.clientTop;
    const bottom = top + scrollContainer.clientHeight;
    const direction = drag.clientY >= top && drag.clientY <= bottom
      ? drag.clientY < top + SCROLL_EDGE_PX ? -1 : drag.clientY > bottom - SCROLL_EDGE_PX ? 1 : 0
      : 0;
    let frame: number | undefined;
    if (direction !== 0) {
      frame = window.requestAnimationFrame(() => {
        if (!dragRef.current?.active) return;
        const previous = scrollContainer.scrollTop;
        scrollContainer.scrollTop = Math.max(0, Math.min(
          scrollContainer.scrollHeight - scrollContainer.clientHeight,
          previous + direction * SCROLL_STEP_PX,
        ));
        // Refreshing schedules the next frame while the pointer remains at an edge.
        if (scrollContainer.scrollTop !== previous) refreshTarget();
      });
    }
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      scrollContainer.removeEventListener('scroll', refreshTarget);
    };
  }, [computeTargetIndex, drag, getRowElement]);

  const keyboardHandlers = (id: TId) => {
    if (!allowKeyboard || disabled) return undefined;
    return {
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        event.stopPropagation();
        const from = ids.indexOf(id);
        if (from < 0) return;
        const targetIndex = event.key === 'ArrowUp' ? from - 1 : from + 2;
        const next = moveId(ids, id, targetIndex);
        if (!next) return;
        onReorder(next, id);
        const dest = next.indexOf(id);
        onAnnounce?.(`Moved item to position ${dest + 1} of ${ids.length}`);
      },
    };
  };

  const dropIndicatorTop = dropIndicator && drag?.active
    ? dropIndicatorOffset(ids, drag.targetIndex, getRowElement)
    : null;

  const suppressClick = (id: TId) => suppressId === id;

  return {
    pointerHandlers,
    keyboardHandlers,
    dropIndicatorTop,
    isDragging: drag?.active ?? false,
    suppressClick,
  };
}
