# Native anchor positioning and popovers

Every element-anchored overlay in the web client is placed by the browser's CSS anchor positioning. Eligible surfaces use native top-layer popovers; the picker, chip choices and the BatchPrompt card preserve the page's stacking order. Overlay placement never measures an anchor, computes a popup coordinate, or listens to scroll and resize to re-place a popup. This page records relationships, layers, CSS geometry, fallbacks, remaining layout measurements and browser evidence.

Verification: the real-browser lane (`bun run --cwd web test:browser`) runs the native-anchor matrix in Chromium and WebKit with native geometry exercised in both. Its first case records browser versions, user agents and feature reports as annotations and `[native-anchors]` console lines. Phone checks use browser emulation; they do not prove physical-device software-keyboard behavior, and the visual-viewport and keyboard-inset regressions stay in the unit lane. Vite's `es2022` target transforms syntax and supplies no CSS anchor polyfill, so native CSS support is established by the browser lane, separately from the build target.

## Contract

**CSS owns geometry.** Preferred side, alternate placements, edge clearance, trigger-width matching and the available-height budget are declared in stylesheets. Script owns only the relationship (which element is the anchor) and the interaction lifecycle (open, dismiss, focus, Escape, timers, hover intent).

**Two relationship mechanisms, chosen per surface by its layer.**

1. **Implicit anchor, top layer.** The panel is a manual popover shown with `showPopover({ source })`; the source is its implicit anchor and CSS reads it with an explicit `position-anchor: auto`. There is no anchor name to invent, bind or release, so repeated triggers (every batch header), nested overlays (More, then Move from the same button) and a panel still playing its exit cannot cross-bind. `web/src/hooks/useNativeAnchor.ts` (`useAnchoredPopover`) shows the mounted panel in a layout effect, re-shows it when the owner swaps the panel node (popover to sheet and back) or the anchor changes, hides it on deactivation, and reports a close the platform made on its own (entering fullscreen hides every popover) so the owner's state follows. Its own hides remove the `toggle` listener first, so a stale event from them is never read as a platform close. The hook writes `data-anchored="source"` itself, and only while a connected source is bound: a panel shown without one stays unanchored (centred, scrolling, usable). While a source is bound, one MutationObserver watches the document's child lists and reads nothing but `source.isConnected`; it is disconnected on loss, on hide and on unmount. A source removed while the panel is open, or while it plays its exit, drops `data-anchored`, so the panel takes the centred fallback rather than resolving against nothing (Chrome 156 otherwise draws it at the window's origin), and the loss is reported through the same native-close callback, so the owner closes with its exit and focus fallback. Native `anchors-valid` is not relied on: Chrome 156 reports `CSS.supports` false for it.
2. **Declared name, page layer.** Where the top layer would break the existing layer order, the owner declares a stable per-instance name from its `useId` on both ends in plain render output: no append or remove list, no computed-style read, no binding helper, and no dependence on the popover `source` member. ChipSelect declares `--named-anchor` on its chip and menu. The BatchPrompt card declares `--prompt-anchor` on the card and on its active source only (the prompt in element mode, the pointer stand-in in pointer mode), so an inactive prompt binds nothing.

**Manual, not auto, popovers.** Every owner keeps its own Escape order (useModalChrome, useNestedDialogEscape, the keyboard registry), outside-pointer rule (`useOutsidePointer`, off while a backdrop exists), focus trap and exit animation (`useExitTransition`). Auto popovers would add a second light-dismiss and Escape owner. `closedby`, `popover="hint"` and the `overlay` transition property are not available in every target engine (see the support table), so they cannot replace that ownership.

**Detecting `source`.** `popoverSourceSupported()` passes an options object whose `source` getter records being read to `showPopover()` on a detached element without a `popover` attribute. WebIDL converts the dictionary before the method's own checks, so an engine that supports the member reads it and then throws `NotSupportedError`; an engine without it reads nothing. No element is shown or measured, and the answer is cached per `showPopover` function. Neither the existence of `showPopover` nor `CSS.supports` alone is taken as proof. Panels only carry `data-anchored="source"` when the member was read and a connected source is bound; CSS anchors only panels that carry `data-anchored`.

## Layers and relationships

| Surface | Layer | Relationship | Why |
|---|---|---|---|
| OverflowMenu (desktop): BatchOverflowMenu, the text-model row's More | top layer, manual popover | implicit anchor: the More trigger | Toasts raised while it is open render inside its panel (`useModalChrome` toast host), so the top layer covers nothing they need. |
| MovePopover (desktop, from More or the collection chip) | top layer, manual popover | implicit anchor: whichever trigger opened it | As above. Manual mode is required: the 260ms pending single-click move (so a double-click can rename), the exit choreography, focus and Escape stay the owner's. |
| AxisDropdown (desktop popover) | top layer, manual popover, above PromptPicker | implicit anchor: the axis trigger | It portals nothing of its own and hosts the toast while open (`useModalToastHost`), so nothing is stranded beneath it. |
| BatchPrompt card | page layer, `z-index` popover + 1, portalled to `<body>` | declared name `--prompt-<useId>` in `--prompt-anchor`, as `anchor-name` on the active source (a zero-size pointer stand-in after a dwell, or the prompt after focus or a tap) and `position-anchor` on the card | The body portal escapes the feed scroller's clip and the `contain: strict` feed. Below the global toast stack (`--z-toast`, 200), so a tall card never covers an Undo, whichever opened first; a top-layer card did. |
| `[data-tip]` label | top layer, manual popover, one node | implicit anchor: the described host | Escapes every clipping, masking, filtered or transformed ancestor (glass tile actions, the picker's masked scroll body, the feed). See the tooltip section for its DOM owner. |
| ChipSelect menu (desktop) | page layer, `z-index` popover + 10 | declared name `--chip-<useId>` in `--named-anchor`, as `anchor-name` on the chip and `position-anchor` on the menu | It sits below the global toast stack (`--z-toast`, 200) and registers no toast host, so a top-layer chip menu could cover a global Undo. Inside PromptPicker it must stay above the picker's own page layer, which the shared z-index order already gives. |
| Desktop PromptPicker | page layer, `z-index` popover | one stable name, `--atelier-composer`, on the Composer `.wrap` | Exactly one Composer is ever mounted. Promoting the picker would strand its body-portalled ChipSelect menus below it. |
| Toast stack (app root, and the `viewport` host inside a native dialog) | page layer, `--z-toast` (inside the dialog's top-layer subtree for the `viewport` host) | `anchor()` against `--atelier-composer`, horizontally and vertically | Element-relative to the Composer: 16px above it, centred on it. The `contained` host is placed inside its panel instead (global.css; PromptPicker's separate toast row). |
| Phone sheets (all four owners), PromptPicker short-window sheet | page layer | none | Modal sheets with backdrops dismissed on click, `--keyboard-inset` and safe areas. A nonmodal popover does not replace them, and none of them carries `popover`. |
| Prompt Library help panel | page layer | none | Intentionally viewport-fixed (top 64px, right 36px). Its `triggerRef` only excludes the trigger from outside-pointer dismissal. |
| DialogShell dialogs, Lightbox viewer | native modal top layer / viewer | none | Unanchored modal and viewer owners. DialogShell keeps real `showModal()` modality and inerting. |

The Composer `.wrap` and the desktop picker are centred with auto margins between their insets. That is plain layout and pixel-equivalent to the earlier `left: 50%; transform: translateX(-50%)`. It is not required by anchoring: the anchor box includes transforms (CSS Anchor Positioning, "anchor box", axis-aligned bounding rect), and the virtualized feed rows still use `transform: translateY(...)`. The primary's earlier run of the feed More-menu checks on Chromium and WebKit confirmed menus land under their own translated rows.

## Geometry

### Popover panels (`web/src/styles/anchors.module.css`)

A desktop panel carries `anchors.panel`, a `data-anchor-place` and, when an anchor exists, `data-anchored`. Phone sheets carry none of them.

| Place | Owners | Preferred | Gap / edge clearance |
|---|---|---|---|
| `below-end` | OverflowMenu (BatchOverflowMenu, text-model rows), MovePopover | below, right edges aligned | 8px to the trigger, 12px from the left edge |
| `below-start` | AxisDropdown | below, left edges aligned | 8px, 12px from the right edge |
| `above-start` | ChipSelect | above, left edges aligned, at least trigger-wide (`anchor-size(width)`) | 8px, 12px from the top and right edges |

The preferred side stays content-sized up to its available height. Native `flip-block`, `flip-inline` and their combination try the opposite side and horizontal mirrors. Sizing stays in the normal style: a definite height from the chosen area's available space, capped by `max-height: max-content` so short menus keep their natural height. AxisDropdown keeps its additional 340px/60dvh cap. This matters in WebKit: native focus scrolling left the last collections clipped after asynchronous growth when sizing changed inside a `@position-try` override. The browser regression grows the collection cache while open, navigates to the last row, Tabs to New collection and clicks it. A 120px usable-height floor rejects cramped sides; in a very short window the floor shrinks to half the total free height, computed entirely in CSS with `anchor-size(height)` and the two gap/edge budgets. At least one side can then fit. Base plus three alternatives stays within CSSWG's guaranteed five-option minimum.

More and Move keep their scrolling contents inside the anchored shell. Scaling a pressed row then cannot reset the shell's scroll between pointer-down and click; the existing pressed animation is retained. Internal padding and scroll-padding preserve the existing 4px focus-outline extent, with compensating margins keeping row positions unchanged. Browser checks assert that keyboard focus stays inside the scroll clip.

CSSWG guarantees at least five total placement options; these panels use four. The 240px central-trigger regression asserts adjacency, edge clearance, scrolling and focus restoration on both sides of the window.

Each placement declares its preferred area and margins in CSS, so flip tactics apply to them. Every position re-resolves on scroll, resize and content change (collections loading, an inline row opening, filtering, a long model list) without script. When the natural preferred placement overflows, a usable preferred side may scroll before an opposite-side candidate is needed.

### Prompt Picker (`PromptPicker/index.module.css`)

`position-area: top span-all` against `--atelier-composer`: the panel's bottom sits 10px above the Composer and its height budget is the space above it less 24px of top clearance, as the Composer grows, wraps or moves. Horizontal centring stays on the content column (`--content-inset-left`, derived in CSS by `styles/global.css` from `--sidebar-width` and the sidebar's collapsed state). Phone and short-window sheets are unchanged.

### Toast stack (`Toast/index.module.css`)

`bottom: calc(anchor(top, 8px) + 16px)`, `left: anchor(left, ...)`, `right: anchor(right, 0px)` against `--atelier-composer`, with `width: fit-content` and auto margins: 16px above the Composer, centred on it, and following it as it grows, collapses or rides the soft keyboard. The stack never takes the pointer itself (`pointer-events: none`); actionable toasts do. The `contained` host keeps its own rule (`global.css`: bottom-centre of the panel, centred by the same width and margins; PromptPicker turns it into a separate row). Native Enter on a hosted Undo is unaffected. `--composer-top` is no longer read by any overlay.

### BatchPrompt card (`Batch/index.module.css`)

The card reads `position-anchor: var(--prompt-anchor)`, the name its active source declares. Pointer mode: 16px below and right of the pointer. Element mode: 8px under the prompt, left edges aligned, and hidden while the prompt is clipped out of the feed (`position-visibility: anchors-visible`; not applied to the pointer stand-in, which has no box to clip). Both keep 12px from the viewport edges, flip above, then to the other side; a card taller than either side uses the whole window's height, pins to its top edge and scrolls (`--prompt-tip-tall`). Native `anchor-center` alignment keeps that last resort near its source within the window margins. Base plus four alternatives stays within the guaranteed five-option budget. The card is `width: max-content`, capped at `min(46ch, 80vw)`, so a narrow side makes it flip rather than wrap into a sliver.

### `[data-tip]` labels (`styles/global.css`)

One label node, `[data-tip-label]`, with `data-tip-place` copied from its host.

| `data-tip-place` | Preferred | Gives way to |
|---|---|---|
| (none) | above, centred on the host (`top span-all`, `justify-self: anchor-center`) | above start-aligned, above end-aligned, capped below, capped above |
| `below` | below, centred | below start, below end, capped above, capped below |
| `above-end` / `above-start` | above, that edge aligned | above, other edge; below, same edge; capped below, capped above |
| `below-end` / `below-start` | below, that edge aligned | below, other edge; above, same edge; capped above, capped below |

A capped pair (`--tip-clamp-above`, `--tip-clamp-below`) keeps the label centred on its host, shifted by native alignment within the window's 8px side margins, and limits height to the chosen side so long and dynamically growing labels scroll. Each placement has four candidates, within the guaranteed option budget. Transparent 6px block borders preserve the hover bridge on either side; its presses hit the label and are swallowed too. The label is `width: max-content` up to `calc(100vw - 16px)` and wraps only beyond that. Reveal and motion are unchanged: hidden through a 360ms delay, then a 120ms fade and 2px slide toward the host side; reduced motion is an opacity fade with the same delay. A CSS animation with backwards fill owns the delay; Web Animations explicitly restarts it when the node switches hosts without a hidden frame, without a geometry read or a reveal timer. Browser regressions sample the reveal on the browser's pointer-event clock, avoiding driver latency, and cover first show and direct host changes. `position-visibility: anchors-visible` hides a label whose host scrolled out of its clip.

## Tooltip lifecycle (`web/src/hooks/useTooltipDismiss.ts`)

Hosts keep authoring `data-tip` and `data-tip-place`; `aria-label` stays the screen-reader contract and the label is `aria-hidden`, never a Tab stop. `useTooltipDismiss`, mounted once by App (and by the browser harnesses), is the only owner: one delegated set of window listeners, one lazily created label node, no per-host listeners, state or names.

- **Which host.** The hovered host, else the host with keyboard focus (`:focus-visible`). The innermost host wins, so the ChipSelect value span and its chip never show two labels. A host is skipped while it or an ancestor is `aria-expanded="true"` (quiet expanded hosts), inert, behind a modal dialog, or Escape-dismissed. With native modals open, the one holding focus (the innermost `dialog:modal` around `document.activeElement`) is the only one whose hosts qualify, so a label in an outer dialog never outlives a nested modal opened above it; with focus in none of them, any open modal's hosts do, as before. Touch pointers and `(hover: none)` devices show no label.
- **Clipped hosts.** While a host is the intended one (hovered or focused, eligible, on a hover device), one IntersectionObserver for it alone (no root, no thresholds; only `isIntersecting` is read) tracks whether it is wholly clipped. A wholly clipped host, such as a focused row scrolled out of its list, gives up its label: `data-open` is removed and the label leaves the top layer at once (CSS `position-visibility` already hides it, so no fade is cut short), so an invisible label never takes Escape or a press. The host is not marked dismissed; back in view, a host that is still hovered or focused shows its label again after the usual reveal delay. The observer is replaced when the intended host changes and disconnected when there is none (including after a change to a no-hover device) and on unmount; a report queued by a replaced observer is ignored. `checkVisibility()` and computed `visibility` both still report a strongly hidden label as visible in Chrome 156, so neither is used. Without IntersectionObserver, labels behave as before.
- **DOM owner.** The host's open `<dialog>` or popover, because everything outside a modal dialog is inert; otherwise the host's own top-level subtree under `<body>`, because a body-level label could carry the inert sweep of a custom modal opened since, and the host's subtree is the one that sweep spared. The label is then shown in the top layer with the host as its source, so top-layer interaction (hit testing above the dialog, the hover bridge) works in every owner.
- **Travel and persistence.** A shown label takes the pointer. Leaving a host for a non-host starts a 120ms grace; reaching the label cancels it, so the 6px gap is crossable and the label stays while read. Moving to another host re-points the same node at once.
- **Escape.** Window capture, ahead of every document-level and element-level owner. A label past its reveal delay is dismissed (`data-tip-dismissed` on the host) and the key is consumed; one still inside its delay, a `defaultPrevented` key or an IME composition is left alone. A dismissed host re-arms only after hover and focus have both left it.
- **Presses on the label.** `pointerdown`, `mousedown`, `click`, `dblclick` and `auxclick` whose target is inside the label are prevented and stopped in window capture: they never activate a control beneath, never reach an outside-pointer owner (a ChipSelect menu, PromptPicker), and never move focus.
- **Liveness.** While a host is intended, including one clipped out of view, one MutationObserver (attributes `aria-expanded`, `data-tip`, `data-tip-place`, `inert`, `open`, plus child lists) re-validates it: a host that expands, changes its text, becomes inert, is blocked by a newly opened modal, or is removed takes its label with it. A label hidden by leaving stays an open, invisible popover so its fade is never cut short; the next show re-raises it. A label whose host was removed has no source left to fade against, so it leaves the top layer at once.
- **Not on editable fields.** The PromptManager inline name field (`InlineFieldChrome`) carries no `data-tip`: it shows its own value, a label would only echo the typing, and its Escape dismissal would take the key from the field's blur. The old `::after` label never rendered on an input, so nothing visible is lost; the visually hidden `<label>` stays the accessible name.

## BatchPrompt lifecycle (`web/src/components/Batch/BatchPrompt.tsx`)

Truncation (`scrollWidth` against `clientWidth`, re-measured by ResizeObserver) decides whether a card can exist. A 400ms dwell opens the pointer card; while the pointer is over the prompt the stand-in follows it. Leaving the prompt or the card starts a 200ms grace, so the pointer can travel onto the card to read and scroll a long prompt; leaving both closes it. Escape closes the card wherever focus is (window capture, after the shared tooltip lifecycle that App mounts first; whichever runs first consumes the key and the other sees it `defaultPrevented`; IME composition is ignored). A pointer card dismissed while the pointer rests on the prompt does not reopen until the pointer leaves or a fresh focus re-arms it. Focus opens the element card (a pointer card keeps the pointer); blur closes an element card. A page scroll or resize dismisses a pointer card because its point is stale, except a scroll inside the card itself. While an element card is open, one IntersectionObserver on the prompt (no root, no thresholds; only `isIntersecting` is read) closes the card once the prompt is wholly clipped or out of view: a virtualized row can stay mounted and focused while CSS hides its card, and a hidden card must not keep owning Escape. Focus stays on the prompt and a fresh focus opens the card again. `checkVisibility()` and computed `visibility` both still report a strongly hidden card as visible in Chrome 156, so neither is used. Escape is also left alone when the prompt sits behind a modal opened since (inert, or outside the native modal dialog that holds focus; the same check the tooltip lifecycle uses), so a background card never pre-empts that modal. A visible card still takes Escape first. Unmounting (a virtualizer recycle) clears every timer and removes the stand-in and card with the portal.

If two cards coexist, the card describing the keyboard-focused prompt takes Escape before an older hovered card. The existing `aria-describedby` relationship establishes that priority; it needs no global owner registry. Unit and real-browser regressions exercise two separate feed rows and both successive Escape presses.

## Supported-browser boundary and fallback

Expected feature floors, from MDN and browser-compat-data. These are floors, not test results; a build target or `CSS.supports` is a gate, not proof of interoperability.

The conservative expected boundary for the complete native behavior is Chromium 137+, Firefox 147+ and Safari 26.2+. The browser lane exercises Chromium and WebKit only; Firefox behavior remains a verification gap.

| Feature | Chromium | Firefox | Safari |
|---|---|---|---|
| `anchor-name`, `anchor()`, `anchor-size()` | 125 | 147 | 26 |
| `position-area` | 129 | 147 | 26 |
| `position-try-fallbacks` | 128 | 147 | 26 |
| `anchor-scope` (no longer used) | 131 | 147 | 26 |
| `showPopover({ source })` implicit anchor | 133 | 147 | 26 |
| source focus-order fix | 137 | 144 | 26 |
| `position-visibility: anchors-visible` | 125 | 147 | 26.2 |
| `@starting-style` | 117 | 129 | 17.5 |
| `interestfor` | 142 | no | no |
| `overlay` transition property | supported | no | no |
| `closedby` | see BCD | see BCD | preview only |
| `popover="hint"` (full semantics) | 151 | 153 | preview only |

Firefox's `transition-behavior: allow-discrete` for `display` is partial.

`interestfor` cannot replace the tooltip lifecycle while Firefox and Safari lack it. Vite's build target does not polyfill any of these. `position-anchor` is always set explicitly (`auto` for implicit anchors, a name otherwise), never left to an initial value that has changed between engine versions.

Fallbacks, all keeping every interaction (focus traps, roving keys, Escape order, outside-pointer and backdrop dismissal, Undo reachability):

- **Missing a surface's CSS prerequisites**: menus become centred scrollable panels; the picker becomes centred in the content column with 24px clearance; the BatchPrompt card and tooltip label rest top-centre; the toast stack rests 16px from the top of the content column. Gates are per surface: panels and the card require `anchor-name`, `position-area` and `position-try-fallbacks`; labels also require `anchor-center`; the picker requires `anchor-name` and `position-area`; the toast uses `anchor-name` and `position-anchor`. Partial support can therefore retain some anchored surfaces.
- **Popover API without `source`** (for example Chromium 125 to 132): the implicit-anchor panels are centred and scroll, and labels use top-centre. The named ChipSelect, BatchPrompt card, picker and toast relationships do not need `source` and still use CSS anchoring when their own prerequisites exist. This branch is exercised in both installed engines with a source-ignoring native API wrapper, which also asserts the card stays anchored under its prompt.
- **No Popover API at all**: source-dependent surfaces use the same unanchored placements as ordinary fixed elements in their owner's stacking order; the named surfaces are unaffected. This older-engine presentation is structurally preserved but was not exercised on an actual legacy engine. Layout breakpoints use Media Queries Level 4 range syntax (`width < 768px`; Chromium 104, Firefox 63, Safari 16.4), so an engine older than that applies neither the phone nor the desktop `@media` rules.
- **A source that is missing or removed** (an engine with `source`): distinct from the engine fallbacks above. A panel shown without a connected source stays usable, unanchored, centred and scrolling. If its bound source leaves the document while it is open or exiting, the panel takes that fallback and its owner is told to close; it is never resolved against a removed box. A tooltip label whose host is removed leaves the top layer at once. The card cannot outlive its source: the prompt owns the card, and the stand-in is rendered with it.
- **No Composer mounted** (engines with anchoring): `anchor()` takes its fallback, so the toast stack rests 24px off the bottom of the content column; the picker's area does not apply and it rests 10px off the viewport bottom.
- **No `position-visibility`**: a card or label whose anchor is partly clipped stays drawn until the pointer leaves, focus moves or the row recycles; an element-mode card or a label whose source is wholly clipped is still closed by its IntersectionObserver where that exists.

## Remaining JavaScript geometry, and why

- `useComposerViewportInsets`: `--composer-top` reserves the feed's bottom padding (`Canvas`) and is layout, not overlay placement; no overlay reads it, including fallbacks. `--keyboard-inset` follows the visual viewport for the phone composer and sheets; CSS cannot read the visual viewport.
- BatchPrompt: the truncation measurement, and the pointer's client coordinates written to the stand-in's `left` and `top`. Its timers, listeners and the element-mode IntersectionObserver (whether the prompt intersects at all, never a rect) are interaction.
- `useAnchoredPopover`: no geometry. Its connection observer reads only `isConnected`.
- `useTooltipDismiss`: no geometry. It reads the label's computed `visibility` to tell a revealed label from one still inside its delay, and its IntersectionObserver reads only whether the intended host intersects at all, never a rect.
- Virtualization (`@tanstack/react-virtual`), image zoom and pan, textarea auto-height where `field-sizing` is unsupported, and drag reorder: their own layout, not overlay positioning.

## Inventory

| Surface | Before this change | Now |
|---|---|---|
| BatchOverflowMenu (desktop) | `useAnchoredPosition`, inline `top`/`left`, `-9999` until measured | top-layer popover, implicit anchor, `below-end` |
| MovePopover (desktop) | same, re-measured on `collections.length` and inline-edit changes | top-layer popover, implicit anchor, `below-end`, follows content on its own |
| ChipSelect (desktop) | same, viewport coordinates, measured width and height budget, hidden first frame | page layer, declared `useId` name, `above-start`, trigger width, capped stages |
| AxisDropdown (desktop popover) | same, re-measured on filter results | top-layer popover, implicit anchor, `below-start` |
| Prompt Picker (desktop) | `bottom` and `max-height` from the measured `--composer-top` | anchored to `--atelier-composer`; centred fallback |
| Toast stack | `bottom` from the measured `--composer-top`, `left: 50%` plus translate | `anchor()` against `--atelier-composer`; top-centre fallback |
| BatchPrompt, pointer mode | measured card size, flip and clamp in script, `transform` writes, closed on leaving the prompt | page-layer card under the toast stack, named anchor on a pointer stand-in; CSS flips and clamps; hoverable with a travel grace |
| BatchPrompt, keyboard and tap | anchor rect read on open, scroll and resize; Escape only on the focused prompt | page-layer card under the toast stack, named anchor on the prompt; Escape from anywhere while it is visible |
| `[data-tip]` labels, all six placements | `::after` pseudo-element absolutely positioned against the host, clipped by its ancestors, no flipping | one top-layer label node anchored to its host, with flips, clamping, wrapping and scrolling |

Removed: every `useAnchoredPosition` caller (the hook and its test are deleted), the inline geometry writes, the `-9999` and `visibility: hidden` pre-measure passes, the placement-only `recomputeKey` inputs and width constants, the scroll and resize listeners that only re-placed panels, the `[data-tip]::after` rules with their `anchor-scope` branch, and the `getClientRects` label hit test. The replacement has no anchor-name registry or binding helper.

## Visible differences to inspect

- A right-aligned panel that cannot fit against a trigger near the left edge mirrors to the trigger's left edge instead of clamping 12px off the edge. Production triggers sit at the right of their row; the overlay harness's `menu` case puts one at the left, so only `overlays.visual.spec.ts` `menu.png` was deliberately regenerated and inspected. Its surface, typography, spacing and height remain the same; the horizontal edge fallback moves from x=12px to the trigger's left edge (about 65px in this harness). The dialog baseline is unchanged.
- A panel that fits on neither side scrolls inside the window, including in very short windows.
- Tooltip labels escape ancestor clipping, flip and clamp at window edges, wrap past the window width, and show one label for nested hosts (the innermost) where both used to paint. The 6px bridge continues to shield pointer presses.
- The BatchPrompt card can be hovered, read and scrolled; leaving the prompt closes a pointer card after 200ms rather than at once.
- In engines without anchoring, the toast stack sits top-centre and the picker is centred, instead of both measuring the Composer.
- If an anchor disappears while its panel is open or plays its exit (the Move popover opened from a collection chip that the move removes), the panel drops its anchor and finishes at its centred nonanchored position.
- Labels on disabled controls depend on the engine delivering `pointerover` to disabled form controls, which current engines do; the browser lane covers one ("disabled controls retain their visual tooltip").
- The BatchPrompt card sits under toasts and under any top-layer menu or dialog; as a top-layer popover it could cover a toast's Undo.

## Tests

- Unit (happy-dom, no layout, no Popover API): `useNativeAnchor.test.tsx` installs a minimal Popover API to cover showing with the source, the `source` probe, platform close versus our own hide, the sheet path, a missing initial source, a source removed while open (reported once, observer released) and release before removal; `useTooltipDismiss.test.tsx` covers host choice, the DOM owner, the travel grace, quiet expanded hosts, removal (closing the popover at once, while a leave only fades), live text, Escape order and re-arming, a nested native modal owning Escape over an outer dialog's label, the clipped-host IntersectionObserver lifecycle (one observer for the intended host, released with it and on unmount; Escape passing on and no dismissal while clipped; leaving and re-entering the top layer; removal while clipped; stale reports; no IntersectionObserver), and swallowed presses; `BatchPrompt.test.tsx` covers the named page-layer contract (the active source alone declares the name, per instance), dwell, pointer following, travel onto the card, card scroll, Escape with focus elsewhere, after another owner and behind an inert sweep, re-arming, keyboard, blur, takeover, tap, unmount, and the element-mode IntersectionObserver lifecycle; `InlineFieldChrome.test.tsx` asserts the name field has no tooltip and its first Escape reaches the field; the owner tests assert the anchoring contract and the absence of script geometry; `src/tooltip-placement-invariant.test.ts` locks the placement vocabulary against the label rules; `test/designSystemDrift.test.ts` guards against geometry reads in the owners and against overlays reading `--composer-top`.
- Real browser: `web/e2e/native-anchors.spec.ts` with production owners in `web/e2e/harness/anchors.tsx` (StrictMode, production `global.css`, the keyboard dispatcher, the tooltip lifecycle and the single Toast): engine evidence; repeated anchors in the virtualized `contain: strict` feed, scroll, row recycling, the Move popover from both triggers with an inline row; the very short window regression with a central trigger; every corner for the chip menu, the More menu, the card and a long label in four placements; trigger width; Tab, Shift+Tab, arrows, Escape order and focus restoration; touch backdrops; the picker and toast following the Composer; a global Undo above an open chip menu; a picker-hosted Undo through a nested axis choice; the toast without a Composer; every label placement in both themes with and without reduced motion, clipping and masking ancestors, glass tile actions, nested hosts, a chip menu option, the label bridge and presses, keyboard focus and a native modal dialog; desktop, tablet, and phone portrait and landscape. The prompt card regression includes travel back to its trigger through React's portal event ancestry. Review regressions: a More trigger removed while its menu is open (sampled on the next frames: never at the origin, centred, then closed) and the menu shown with no trigger; a tooltip host removed while described (no painted or open label on the next frames); a global Undo above an overlapping tall prompt card in both opening orders, with the card's hover and reading kept; a focused feed prompt clipped out of its retained row passing Escape to the document; a focused `?case=tips` list row scrolled wholly out of its scroller giving up its label (not open, out of the top layer, Escape reaching the document, not dismissed) and showing it again after the reveal delay once back in view; a second native modal opened above the tips dialog while its label shows, whose Escape is not pre-empted by that label and closes only the inner dialog; and the production TemplateEditor name field (`?case=editor`) showing no label while typed in, with its first Escape blurring it. `web/e2e/frontend-audit.spec.ts` keeps the picker's label travel, press and Escape cases against the label node.
- Engines: the `chromium` and `webkit-anchors` projects always run; `firefox-anchors` joins automatically when Playwright's Firefox build is installed and the config prints one warning when it is not.

## Sources

- Vite production compatibility: https://vite.dev/guide/build
- Vite build and CSS targets: https://vite.dev/config/build-options
- Rolldown chunk groups: https://rolldown.rs/reference/OutputOptions.codeSplitting
- TypeScript JSX runtime: https://www.typescriptlang.org/docs/handbook/jsx.html
- IntersectionObserver lifecycle: https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver/disconnect
- React 19.3.1 release: https://github.com/react/react/releases/tag/v19.3.1
- React 19.3 release notes: https://react.dev/blog/2026/09/09/react-19-3
- React versions: https://react.dev/versions
- Fresh callbacks for native event listeners: https://react.dev/reference/react/useEffectEvent
- ViewTransition: https://react.dev/reference/react/ViewTransition
- Fragment refs: https://react.dev/reference/react/Fragment
- CSS anchor positioning: https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_anchor_positioning
- `anchor-name`: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/anchor-name
- `position-anchor`: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/position-anchor
- `position-area`: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/position-area
- `position-try-fallbacks`: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/position-try-fallbacks
- `anchor-scope`: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/anchor-scope
- `showPopover()`: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/showPopover
- Intrinsic height caps: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/max-height
- CSS animation access: https://developer.mozilla.org/en-US/docs/Web/API/Element/getAnimations
- Animation restart: https://developer.mozilla.org/en-US/docs/Web/API/Animation/currentTime
- Animation fill: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation-fill-mode
- Popover API: https://developer.mozilla.org/en-US/docs/Web/API/Popover_API
- Interest invokers: https://developer.mozilla.org/en-US/docs/Web/API/Popover_API/Using_interest_invokers
- Browser compatibility data: https://github.com/mdn/browser-compat-data
- Anchor box includes transforms: https://drafts.csswg.org/css-anchor-position-1/#anchor-box
- Placement-option limits: https://drafts.csswg.org/css-anchor-position-1/#fallback-apply
