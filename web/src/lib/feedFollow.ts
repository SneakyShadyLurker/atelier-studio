/**
 * The feed following new work, eased.
 *
 * A batch entering at the newest end makes the feed follow it: the scroller
 * moves down by the batch's height and every row on screen jumps up by as
 * much. That commit runs outside a Transition (lib/feedMotion), so no view
 * transition interpolates the rows. The jump is eased here instead: the
 * row window is offset back by the distance it just travelled and released to rest
 * on the view tokens, a transform on one element, on the compositor, with
 * nothing captured and no input suspended.
 *
 * Offsets add up (`composite: 'add'`), so a second follow scroll arriving
 * while the first still eases continues the same motion instead of
 * restarting it. That includes the corrections the virtualizer makes in
 * either direction as the new row measures against its estimate: each is
 * offset by its own distance, so the rows never jump back.
 */

/** Longer than any single follow: past this the list would fly in from off screen. */
const MAX_EASED_DISTANCE_PX = 1600;

function milliseconds(value: string): number {
  const trimmed = value.trim();
  if (trimmed.endsWith('ms')) return Number.parseFloat(trimmed);
  if (trimmed.endsWith('s')) return Number.parseFloat(trimmed) * 1000;
  return Number.NaN;
}

/** Ease `list` over the `distance` its scroller just moved (down is positive). */
export function easeFeedFollow(list: HTMLElement | null, distance: number): void {
  if (!list || typeof list.animate !== 'function' || Math.abs(distance) < 1 || Math.abs(distance) > MAX_EASED_DISTANCE_PX) return;
  const style = getComputedStyle(list);
  const duration = milliseconds(style.getPropertyValue('--dur-view'));
  if (!(duration > 0)) return;
  const frames = [{ transform: `translateY(${String(distance)}px)` }, { transform: 'translateY(0px)' }];
  const easing = style.getPropertyValue('--ease-view').trim();
  try {
    list.animate(frames, { duration, easing: easing === '' ? 'ease-out' : easing, composite: 'add' });
  } catch {
    // An easing the engine cannot parse: the row jump is the fallback.
  }
}
