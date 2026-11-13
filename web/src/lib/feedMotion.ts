import { startTransition, useEffect, useState } from 'react';

/**
 * Which feed changes run as a view transition.
 *
 * A document view transition suspends hit-testing and React's event handling
 * while it is prepared and, in engines without nested groups, captures the
 * Composer dock while it animates (lib/viewTransitionGuard). That price is
 * worth paying for a change the reader watches reflow: a batch or tile
 * leaving, one coming back, a pin. It is not for work arriving in the
 * background, which lands many times a second while the reader types: a new
 * batch at the newest end plays its own CSS entrance and moves no other row,
 * and a tile finishing in place develops in place.
 *
 * So a surface renders from a snapshot that follows the live value at once
 * when the change is plain (`plain(shown, live)`), and through a Transition,
 * which is what activates its view-transition boundaries, when it reshapes
 * the list. The comparison is against what is shown, not against a lagging
 * deferred copy: React holds a Transition while a view transition runs, and
 * a reshape arriving meanwhile must start from the rows on screen.
 *
 * The snapshot is for rendering; handlers read the live value.
 */
export function useMotionSnapshot<T>(live: T, plain: (shown: T, live: T) => boolean): T {
  const [shown, setShown] = useState(live);
  const next = shown !== live && plain(shown, live) ? live : shown;
  // Adopt a plain change in this render (React re-renders at once, before
  // children, and commits urgently): no Transition, so no view transition.
  if (next !== shown) setShown(next);
  useEffect(() => {
    if (next === live) return;
    startTransition(() => { setShown(live); });
  }, [next, live]);
  return next;
}

interface Identified {
  readonly id: string;
}

/**
 * The list only grew at its newest end, by rows this surface has not shown
 * before. A row it has shown (an Undo, a failed write rolling back) fades
 * back in through its boundary, so it counts as a reshape; so does anything
 * leaving, moving, or arriving elsewhere (an older page above the reader).
 */
export function grewOnlyAtEnd(shown: readonly Identified[], live: readonly Identified[], seen: ReadonlySet<string>): boolean {
  if (live.length < shown.length) return false;
  for (let index = 0; index < shown.length; index += 1) {
    if (shown[index]?.id !== live[index]?.id) return false;
  }
  for (let index = shown.length; index < live.length; index += 1) {
    const added = live[index];
    if (!added || seen.has(added.id)) return false;
  }
  return true;
}

/** Same rows in the same order: only their content changed. */
export function sameRows(shown: readonly Identified[], live: readonly Identified[]): boolean {
  if (shown.length !== live.length) return false;
  for (let index = 0; index < shown.length; index += 1) {
    if (shown[index]?.id !== live[index]?.id) return false;
  }
  return true;
}
