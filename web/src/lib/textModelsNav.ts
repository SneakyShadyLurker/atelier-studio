import { APP_VIEW_TEXT_MODELS, useAtelierStore } from '../store/atelier';

// One-shot arrival intent: the Text models heading mounts a deferred render
// after the view switch, so the focus is handed to its owner (TextModels),
// which consumes it on mount and focuses through `runWhenReachable`.
let focusHeadingOnArrival = false;

/**
 * "Set up text models" from a TextModelNote: the same store view action App's
 * `selectView` runs, with focus landing on the Text models heading. Hosts
 * that sit inside an overlay close it through its exit first.
 */
export function goToTextModels(): void {
  focusHeadingOnArrival = true;
  useAtelierStore.getState().setView(APP_VIEW_TEXT_MODELS);
}

/** True once per `goToTextModels`; TextModels reads it on mount. */
export function takeTextModelsArrivalFocus(): boolean {
  const pending = focusHeadingOnArrival;
  focusHeadingOnArrival = false;
  return pending;
}
