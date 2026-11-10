import { runWhenReachable } from './focus';

/*
 * Keyboard focus after a feed removal. Archive, Dismiss, Cancel, Unpin, a move
 * out of the current scope and Undo all remove the node that holds focus;
 * without a successor the browser drops focus to <body> and the reader's
 * place in the feed is gone. The successor is chosen from the DOM the moment
 * the action starts, before the removal commits: the next tile in the same
 * grid, else the previous one, else the batch header, else the next batch
 * row, else the feed scroller itself.
 *
 * Tiles carry `data-feed-tile` (ImageTile, FailedTile, TilePlaceholder), rows
 * carry `data-batch-id` (Canvas rows and the Batch section inside them). A
 * tile whose removal is already under way carries `data-leaving` and is never
 * a successor: it stays in the DOM until the feed's snapshot commits.
 */

const FOCUSABLE = 'button:not([disabled]):not([aria-disabled="true"]), a[href], [tabindex]:not([tabindex="-1"])';
const SCROLLER = '[data-testid="canvas-scroller"]';

function firstFocusable(root: Element | null | undefined, except?: Element | null): HTMLElement | null {
  if (!root) return null;
  for (const candidate of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (except?.contains(candidate)) continue;
    return candidate;
  }
  return null;
}

function rowOf(element: Element): Element | null {
  // The Batch section carries the id; its parent is the Canvas virtual row.
  const section = element.closest('[data-batch-id]');
  return section?.parentElement?.hasAttribute('data-batch-id') ? section.parentElement : section;
}

function successorRow(row: Element | null): HTMLElement | null {
  if (!row) return null;
  return firstFocusable(row.nextElementSibling) ?? firstFocusable(row.previousElementSibling);
}

function isLiveTile(element: Element): boolean {
  return element.hasAttribute('data-feed-tile') && !element.hasAttribute('data-leaving');
}

function liveSiblingControl(tile: Element, direction: 'nextElementSibling' | 'previousElementSibling'): HTMLElement | null {
  for (let sibling = tile[direction]; sibling; sibling = sibling[direction]) {
    if (!isLiveTile(sibling)) continue;
    const control = firstFocusable(sibling);
    if (control) return control;
  }
  return null;
}

/** The control to focus once the tile holding `from` is removed. */
export function tileSuccessor(from: Element): HTMLElement | null {
  const tile = from.closest('[data-feed-tile]');
  if (!tile) return null;
  const next = liveSiblingControl(tile, 'nextElementSibling') ?? liveSiblingControl(tile, 'previousElementSibling');
  if (next) return next;
  const row = rowOf(tile);
  return firstFocusable(row, tile.parentElement) ?? successorRow(row) ?? document.querySelector<HTMLElement>(SCROLLER);
}

/**
 * The control to focus once the tile holding `from` is removed by an action
 * that drops an emptied batch with its last tile (Cancel, Dismiss): with no
 * other live tile in the grid the whole row leaves, header included, so focus
 * goes along the row chain instead.
 */
export function lastTileSuccessor(from: Element): HTMLElement | null {
  const tile = from.closest('[data-feed-tile]');
  if (!tile) return null;
  const others = Array.from(tile.parentElement?.children ?? []).some((sibling) => sibling !== tile && isLiveTile(sibling));
  return others ? tileSuccessor(from) : batchSuccessor(from);
}

/** The control to focus once the batch row holding `from` is removed. */
export function batchSuccessor(from: Element): HTMLElement | null {
  const row = rowOf(from);
  return successorRow(row) ?? document.querySelector<HTMLElement>(SCROLLER);
}

/** Focus `target` once it is reachable, without scrolling the feed to it. */
export function focusSuccessor(target: HTMLElement | null): void {
  if (!target) return;
  runWhenReachable(() => { target.focus({ preventScroll: true }); }, target);
}

/**
 * Focus the first control inside the element `selector` names once it exists,
 * polling the next frames: a restored tile (Undo) appears after its refetch
 * lands and the feed's deferred snapshot commits.
 */
export function focusWhenPresent(selector: string, frames = 40): void {
  if (typeof requestAnimationFrame !== 'function') return;
  const attempt = (remaining: number) => {
    const host = document.querySelector(selector);
    const target = host ? firstFocusable(host) ?? (host instanceof HTMLElement && host.tabIndex >= 0 ? host : null) : null;
    if (target) {
      focusSuccessor(target);
      return;
    }
    if (remaining > 0) requestAnimationFrame(() => { attempt(remaining - 1); });
  };
  attempt(frames);
}
