// Animate, Edit and Extend hand a tile into the composer after an async fetch
// or upload, from separate hook instances (grid tiles, each batch view, the
// Lightbox). The last source intent wins: starting a newer handoff, or a
// composer-side source change (source upload, source clear, Clear all, a model
// switch), supersedes every handoff still in flight, so a slow earlier one
// cannot land over the newer state.
let generation = 0;

/** Start a handoff; the returned check is false once a newer intent exists. */
export function beginSourceHandoff(): () => boolean {
  generation += 1;
  const ticket = generation;
  return () => ticket === generation;
}

export function supersedeSourceHandoffs(): void {
  generation += 1;
}
