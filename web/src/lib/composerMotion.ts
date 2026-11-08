/**
 * The Transition type the Composer's conditional parts commit under. The
 * Composer frame (App.tsx) and mode body animate their footprint only for it.
 * A view-transition capture takes the live element out of hit testing until
 * the animation ends, and React captures an update boundary in any Transition
 * to measure it, so an untyped frame would swallow Generate presses each time
 * a batch enters the feed.
 */
export const COMPOSER_PARTS_TRANSITION = 'composer-parts';

/** The frame boundary's update classes: footprint on part changes only. */
export const COMPOSER_FRAME_UPDATE = { [COMPOSER_PARTS_TRANSITION]: 'composer-frame', default: 'none' };

/** The mode body boundary's update classes: cross-fade on part changes only. */
export const COMPOSER_BODY_UPDATE = { [COMPOSER_PARTS_TRANSITION]: 'composer-body', default: 'none' };

/** The Composer's parts snapshot, as far as its footprint is concerned. */
export interface ComposerPartsShape {
  readonly banner: string | null;
  readonly error: string | null | undefined;
  readonly rollQueue: readonly unknown[];
  readonly refImages: readonly { readonly clientId: string }[];
  readonly isI2VMode: boolean;
}

/**
 * Whether a parts commit should carry COMPOSER_PARTS_TRANSITION: only when a
 * part appears or leaves (or the mode body swaps), never when a shown part's
 * content changes. A Generate press while a queue exists only bumps its count,
 * and capturing the frame for that would swallow the next press. While a drain
 * runs, the queue's own appear/leave is ignored too: each pass takes every
 * queued roll and restores the unsent ones moments later, every few seconds
 * while the server is at capacity.
 */
export function composerPartsReshaped(previous: ComposerPartsShape, next: ComposerPartsShape, draining: boolean): boolean {
  if ((previous.banner === null) !== (next.banner === null)) return true;
  if (Boolean(previous.error) !== Boolean(next.error)) return true;
  if (previous.isI2VMode !== next.isI2VMode) return true;
  if (!draining && (previous.rollQueue.length > 0) !== (next.rollQueue.length > 0)) return true;
  return previous.refImages.length !== next.refImages.length
    || previous.refImages.some((ref, index) => ref.clientId !== next.refImages[index]?.clientId);
}
