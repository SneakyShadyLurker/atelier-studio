import { useRef } from 'react';
import { useVerticalDragReorder, type UseVerticalDragReorderResult } from '../../hooks/useVerticalDragReorder';

export interface RowReorder {
  readonly draggingKey: string | null;
  readonly registerRow: (key: string) => (node: HTMLElement | null) => void;
  readonly gripHandlers: UseVerticalDragReorderResult['pointerHandlers'];
  /** Alt+ArrowUp/Down moves the row by one (shared keyboard reorder). */
  readonly keyboardHandlers: UseVerticalDragReorderResult['keyboardHandlers'];
}

export function useRowReorder(
  keys: readonly string[],
  onReorder: (from: number, to: number) => void,
): RowReorder {
  const rowsRef = useRef<Map<string, HTMLElement>>(new Map());
  const reorder = useVerticalDragReorder({
    ids: keys,
    onReorder: (nextKeys, movedKey) => {
      const from = keys.indexOf(movedKey);
      const to = nextKeys.indexOf(movedKey);
      if (from < 0 || to < 0 || from === to) return;
      onReorder(from, to);
    },
    getRowElement: (key) => rowsRef.current.get(key) ?? null,
    allowKeyboard: true,
  });

  const registerRow = (key: string) => (node: HTMLElement | null) => {
    if (node) rowsRef.current.set(key, node);
    else rowsRef.current.delete(key);
  };

  const draggingKey = reorder.isDragging
    ? keys.find((key) => reorder.suppressClick(key)) ?? null
    : null;

  return {
    draggingKey,
    registerRow,
    gripHandlers: reorder.pointerHandlers,
    keyboardHandlers: reorder.keyboardHandlers,
  };
}
