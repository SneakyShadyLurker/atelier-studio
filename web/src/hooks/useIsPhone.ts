import { createMediaQueryStore } from '../lib/mediaQueryStore';

// Shared phone-breakpoint media query — the one place outside CSS where the
// phone threshold is allowed to live. Range syntax (`width < 768px`, desktop
// `width >= 768px`) leaves no gap at fractional viewport widths. Imported by
// useGenerate for at-cap toast timing on phones. Per docs/web-conventions.md,
// the breakpoint exists in three places only: the CSS @media queries, this
// constant, and the documentation-only `--bp-phone` token (767px, the widest
// integer phone width) in tokens.css + handoff prototype.
export const PHONE_MEDIA_QUERY = '(width < 768px)';
const PROMPT_PICKER_SHEET_MEDIA_QUERY = `${PHONE_MEDIA_QUERY}, (max-height: 620px)`;

/**
 * Does this device put a SOFT keyboard on screen when a field takes focus?
 * A different axis from the phone breakpoint, and the honest one for deciding
 * whether to auto-focus a text input: a short desktop window is not a phone,
 * and a tablet is wider than one. Geometry answers "how do we lay out"; this
 * answers "will focusing this field cover the thing they came to read".
 */
const TOUCH_MEDIA_QUERY = '(hover: none)';

const touchStore = createMediaQueryStore(TOUCH_MEDIA_QUERY);
const phoneStore = createMediaQueryStore(PHONE_MEDIA_QUERY);
const promptPickerSheetStore = createMediaQueryStore(PROMPT_PICKER_SHEET_MEDIA_QUERY);

export const isTouchViewport = touchStore.matches;
export const isPhoneViewport = phoneStore.matches;
export const useIsPhone = phoneStore.useMatches;
export const useIsPromptPickerSheet = promptPickerSheetStore.useMatches;
