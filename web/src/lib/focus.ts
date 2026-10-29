export function runWhenReachable(fn: () => void, target?: HTMLElement | null): void {
  const task = () => {
    if (target && (!target.isConnected || hasInertAncestor(target))) return;
    fn();
  };
  queueMicrotask(task);
}

/**
 * Roving Arrow/Home/End focus across the enabled `selector` items inside
 * `panel` (the ARIA menu keyboard contract; Tab and Esc stay with the caller).
 * `skipTextInputs` leaves caret/selection keys to an inline text field.
 */
export function focusRovingItem(
  event: Pick<KeyboardEvent, 'key' | 'target' | 'preventDefault'>,
  panel: HTMLElement | null,
  selector: string,
  { skipTextInputs = false }: { skipTextInputs?: boolean } = {},
): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
  const target = event.target;
  if (skipTextInputs && target instanceof HTMLElement
    && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  if (!panel) return;
  const items = Array.from(panel.querySelectorAll<HTMLElement>(`${selector}:not([disabled])`));
  if (items.length === 0) return;
  event.preventDefault();
  const currentIndex = items.findIndex((element) => element === document.activeElement);
  const lastIndex = items.length - 1;
  let nextIndex: number;
  if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = lastIndex;
  else if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
  else nextIndex = currentIndex <= 0 ? lastIndex : currentIndex - 1;
  items[nextIndex]?.focus();
}

function hasInertAncestor(el: HTMLElement): boolean {
  let cursor: HTMLElement | null = el;
  while (cursor) {
    if (cursor.inert) return true;
    cursor = cursor.parentElement;
  }
  return false;
}
