export type ConflictState =
  | { kind: 'unresolved' }
  | { kind: 'skipped' }
  | { kind: 'rescuing' }
  | { kind: 'rescued'; rescueBundleKey: string }
  | { kind: 'rescue-failed'; reason: string }
  | { kind: 'acceptedUnsat' };

export type ConflictAction =
  | { type: 'init' }
  | { type: 'skip' }
  | { type: 'acceptUnsat' }
  | { type: 'startRescue' }
  | { type: 'rescueSuccess'; bundleKey: string }
  | { type: 'rescueFail'; reason: string }
  | { type: 'reset' };

export function conflictReducer(state: ConflictState, action: ConflictAction): ConflictState {
  switch (action.type) {
    case 'init':
      return { kind: 'unresolved' };
    case 'skip':
      // Once cap is spent (rescued / rescue-failed), Skip remains a UI option
      // but does not transition state - caller handles bundle deselection directly.
      if (state.kind === 'rescued' || state.kind === 'rescue-failed') return state;
      return { kind: 'skipped' };
    case 'acceptUnsat':
      if (state.kind === 'rescued' || state.kind === 'rescue-failed') return state;
      return { kind: 'acceptedUnsat' };
    case 'startRescue':
      // Cap is one-shot - once entering rescued or rescue-failed, no more rescues.
      if (state.kind === 'rescued' || state.kind === 'rescue-failed') return state;
      return { kind: 'rescuing' };
    case 'rescueSuccess':
      return { kind: 'rescued', rescueBundleKey: action.bundleKey };
    case 'rescueFail':
      return { kind: 'rescue-failed', reason: action.reason };
    case 'reset':
      return { kind: 'unresolved' };
  }
}

/**
 * Sideways effects of a transition: the bundle-pick state and the
 * acceptUnsatisfiableTemplates list must follow the conflict state. The
 * reducer returns the NEW state; the intent describes what the caller (the
 * component) must do alongside that state change.
 */
export interface ConflictTransitionIntent {
  readonly recheckCulpritsInPickedSet: boolean; // skipped -> rescuing: undo the Skip's bundle uncheck
  readonly removeFromAcceptUnsat: boolean; // acceptedUnsat -> rescuing: undo the Apply anyway
  readonly addToAcceptUnsat: boolean; // -> acceptedUnsat: opt in
  readonly removeCulpritsFromPickedSet: boolean; // -> skipped: locally uncheck culprits
}

export function intentFor(prev: ConflictState, next: ConflictState): ConflictTransitionIntent {
  return {
    recheckCulpritsInPickedSet: prev.kind === 'skipped' && next.kind === 'rescuing',
    removeFromAcceptUnsat: prev.kind === 'acceptedUnsat' && next.kind === 'rescuing',
    addToAcceptUnsat: next.kind === 'acceptedUnsat' && prev.kind !== 'acceptedUnsat',
    removeCulpritsFromPickedSet: next.kind === 'skipped' && prev.kind !== 'skipped',
  };
}
