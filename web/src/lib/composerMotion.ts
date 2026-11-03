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
