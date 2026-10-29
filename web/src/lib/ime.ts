interface KeyEventLike {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly nativeEvent?: { readonly isComposing?: boolean };
}

/**
 * True while an IME composition owns the key: Enter confirms a candidate and
 * Escape dismisses the candidate window, so neither may commit or close the
 * surrounding control. `keyCode` 229 covers WebKit, which fires
 * `compositionend` before the confirming keydown (isComposing already false).
 * Accepts native and React keyboard events.
 */
export function isImeComposing(event: KeyEventLike): boolean {
  return event.isComposing === true
    || event.nativeEvent?.isComposing === true
    || event.keyCode === 229;
}
