# Handoff: Atelier — Unified AI Image Generation Frontend

## Overview

**Atelier** is a minimalist single-pane web interface for generating images via AI models. The defining product idea is **backend agnosticism**: the user picks a model from a unified list and writes a prompt — they don't need to know or care whether that model runs on a local GPU or a remote cloud API. The frontend is a single point of entry; the backend routes to the appropriate provider transparently.

Core flow: user types a prompt → picks a model + aspect ratio + count → presses Generate → animated placeholder tiles appear → tiles resolve to images (or to a dismissable failure state) → user can click any image to expand fullscreen, download, or delete.

## About the Design Files

The `design/` folder contains an HTML/JSX prototype (`index.html` + `app.js`) created as a **design reference**. It is not production code — the image-generation backend is mocked (it returns deterministic SVG placeholders after a simulated delay, with a 6% random failure rate to exercise the failure state). The prototype demonstrates intended visual design, layout, animation, and interaction patterns.

**Your task is to recreate this design in the target codebase's existing environment** (React + your styling solution, Vue, SvelteKit, etc.), wiring it to the real image-generation backends. If no frontend environment exists yet, React + Vite + a CSS-in-JS or CSS-modules approach is a reasonable default — the design is light enough that any modern component framework works.

## Fidelity

**High-fidelity.** Final colors, typography, spacing, and motion are all in the prototype. Reproduce it pixel-faithfully. The animations (the plate wipe while a tile renders, tile entrance, image develop, lightbox expand, hover overlays, toast) are part of the design, not decoration — keep them. Where this document and the prototype disagree on a shipped surface, this document and `web/src` win.

## Architecture

The UI is one page with three regions:

```
┌─────────────┬───────────────────────────────────────────┐
│             │                                           │
│  Sidebar    │           Canvas (scrollable)             │
│  (history)  │                                           │
│  240px      │           Batches stacked                 │
│             │                                           │
│             ├───────────────────────────────────────────┤
│             │           Composer (floating)             │
└─────────────┴───────────────────────────────────────────┘
```

- **Sidebar** (left, fixed 240px): brand mark and title, generation history list, clear-all action, footer status line.
- **Canvas** (main): vertically stacked **batches**. Each batch is one prompt+model+settings+timestamp + a grid of **tiles**.
- **Composer** (floating, anchored bottom-center, max-width 920px, 24px from bottom): prompt textarea + model/ratio/count chips + Generate button.

When the canvas is empty, the canvas region shows a centered empty state: an etched still life in a plate, a serif heading and a one-line hint about ⌘+Enter.

## Backend Contract

The frontend should call a backend that exposes:

1. **`GET /models`** — returns the unified model list. Each entry:
   ```ts
   {
     id: string,            // stable id, e.g. "sdxl-local"
     name: string,          // human label, e.g. "SDXL 1.0"
     backend: 'local' | 'cloud',
     tag: string,           // freeform locator: "GPU-0", "us-central1", "azure", etc.
     latency: 'instant' | 'fast' | 'medium' | 'slow',  // for UX hints
     size?: string,         // optional, displayed in tooltips
   }
   ```
   The frontend groups by `backend` in the dropdown (`<optgroup label="Local">`, `<optgroup label="Cloud">`).

2. **`POST /generate`** — body `{ prompt, modelId, ratio, seed, count }`. Returns either streamed per-image results (preferred — SSE or websocket so each tile resolves independently) or a job id you poll. Each per-image result is `{ tileIndex, status: 'done'|'failed', url?, error? }`.

The prototype fans out **N independent generation calls in parallel** (one per requested image), so each tile loads/fails on its own timeline. Preserve this — it's why you see staggered resolution and why one failure doesn't take down the batch.

## Screens / Views

There is one screen with overlay states. Below, every visible component documented.

### Sidebar

**Container:** `border-right: 1px solid var(--line)`, `background: var(--bg-elev)`, flex column.

The sidebar is a sheet laid on the table: `var(--bg-elev)` on `var(--bg)` with a 1px `var(--line)` edge.

**Header** — `min-height: var(--app-header-h)` (56px), 18px sides; flex row with gap 10; bottom border `1px solid var(--line)`.
- **Brand mark**: the engraved capital A in its plate (`web/src/assets/atelier-mark.png`, 128×128 source) shown at 22×22 with `--radius-control`. See Brand mark.
- **Title** "Atelier": sans `--text-md`, weight 500, letter-spacing -0.01em, margin-right auto. The brand stands alone: no version or other label beside it.

**Section header**: padding 14px 18px 8px, the small-caps label: sans `--text-xs` 500, `font-variant-caps: all-small-caps`, `letter-spacing: 0.04em`, `var(--ink-3)`, from sentence-case text ("Library", or the history section's scope title). Right side hosts an "Archive all" archive icon (only shown when batches exist) — clearing history archives every live item rather than hard-deleting it.

**History list**: flex 1, vertically scrollable, with the 14px scroll-edge fade (top edge open at rest, see Canvas). Rows drop in once per batch id (`seenBatches`), never on a virtual remount. Empty state: `--text-xs` copy in `var(--ink-3)` reading "Nothing here yet. Your generations will appear here."

**History item**: 10px padding, `--radius-control`, grid `32px 1fr` with 10px gap, 1px transparent border. Hover: `background: var(--bg-sunk)`. Active (the current batch: the one last generated or chosen on the rail, not the one in view): same bg plus the 2px `--ink` selected bar (`railActiveBar`), `aria-current="true"` and a "Current batch" tip.
- **Thumbnail**: 32×32, `--radius-tile`, overflow hidden. Shows the first ready image of the batch, `object-fit: cover`. With no image ready it shows the plate at rest: `var(--bg-sunk)` with `box-shadow: var(--plate-mark)`.
- **Prompt text**: `--text-xs`, `-webkit-line-clamp: 2`, line-height 1.35.
- **Meta line**: a `Meta` list (`{count}×`, `{ratio}`, `{modelLabel}`): sans `--text-xs`, `var(--ink-3)`, tabular figures, fields separated by a 10px gap, no punctuation.

**Footer**: top border `1px solid var(--line)`, 10px 14px padding, `var(--ink-3)`. Contains a 6×6 green dot (`var(--good)`) with a 3px ring of `--good` at 18%, then a `Meta` list "{N} models", "{M} backends", then the API keys and theme icon buttons (26×26 `buttons.iconAction`, 44px under the touch gate).

**Limited-height fallback**: the sidebar header stays fixed so Collapse or Close remains reachable. Everything below it, through the footer, shares one flex-column rail body with vertical overflow only when needed. The history list keeps its own scrolling and a one-row content minimum (`--rail-history-min-h: 73px`, matching its virtual row estimate), plus the unchanged host bottom padding (18px in production, 80px in the prototype); scrolling can chain to the rail body. Managed views may shrink their empty spacer to zero. When content fits, the rail body does not scroll and the footer keeps its usual position. In a short window or with many collections, navigation and footer controls scroll with the body, retaining their order, touch targets, keyboard navigation, focus restoration, reorder behavior and phone safe-area padding. Collapse and drawer motion are unchanged; no automatic scroll-follow is added. The prototype demonstrates this with its existing history and footer content.

#### Library rail

A second section above the history section. Main, Archive, and Prompt Library all keep the same Library rail *chrome* (position, row geometry, section header, active-bar, keyboard model); full-screen managed views hide the feed list below the rail, but the rail itself remains present. Collapsing, restructuring, or jumping the rail chrome between modes is not an option in v1. The rail *content* adapts to context: in Archive, rows route to archive-scoped views and use archived counts, collection rows with no archived content are hidden (gated like Pinned), and New collection is omitted — Archive is a terminal 30-day deletion bin, not a place to organize live work.

**Library section header** — the same small-caps label as the history section. Right side hosts the **search icon-toggle** (lucide `search`, 14×14, 2px stroke). Click expands an inline search input below the section header on desktop; mobile shows a full-width search row that is always expanded.

**Library row**: 36px tall, 44px on touch devices (HIG/MD touch target). 10px horizontal padding, `--radius-control`, 1px transparent border. Layout: leading 14×14 folder glyph in `var(--ink-3)`, name, trailing count as a sans tabular numeral (`--text-xs`, `var(--ink-3)`).
- **Hover**: `background: var(--bg-sunk)`, no accent.
- **Active**: 2px left accent bar in `var(--ink)` via `::before` pseudo-element (absolutely positioned; **no layout shift** between active and inactive states — Linear/VS Code pattern). `aria-current="page"` + `aria-pressed="true"`.

**Conditional rows** (driven by `LibrarySummary` returned by `GET /api/collections`):

| Row | Shown when |
|---|---|
| `Unsorted` | Always (main: the default scope; Archive: the archived-unsorted scope) |
| `Pinned` | Main: `summary.pinnedCount > 0`; Archive: `summary.archivedPinnedCount > 0` |
| `<name>` | Main: one per user collection, sorted by `sort_order, name`. Archive: only collections with `archivedCount > 0` |
| New collection (plus glyph) | Main only (dashed `var(--line-2)` border); omitted in Archive |

**Inline create + rename + delete** (no modal, no context menu):
- New collection row (plus glyph and label): click → swaps in place to `<input>` with visually-hidden `<label>Collection name</label>`. Enter or blur commits; Esc cancels.
- Double-click on a collection row name → swaps to inline rename input (same pattern). Enter/blur commits; Esc cancels.
- Hover on a collection row reveals a right-side `╳` (lucide `x`). Click → `ConfirmDialog` with title **Delete “{name}”?** (fallback "Delete collection?" only when the name is unavailable), body "Batches will return to Unsorted.", and unchanged Cancel / Delete collection actions, without a count. Names render as text and wrap anywhere, including unbroken names, without truncation. Confirmation → idempotent DELETE; batches' `collection_id` is set NULL by FK cascade.

**Per-scope history label** (the history section title changes per active scope): it is the scope title, `scopeTitle(view, collections)` in `web/src/lib/viewChrome.ts`, the same words as the active rail row and the Canvas title.

Labels are sentence-case source text rendered in small caps.

| view | Section label | Empty-state copy |
|---|---|---|
| `unsorted` | `Unsorted` | "Nothing here yet. Your generations will appear here." with no batches at all, otherwise "No unsorted batches." |
| `pinned` | `Pinned` | "No pinned batches yet. Click the star on any generation to pin it." |
| `collection: <name>` | `<Name>` | "No generations in `<Name>` yet. Move batches here from the Move menu." |
| any + `q !== ''` and no matches | (unchanged) | `"No prompts match \"<q>\"."` |

When `useCollections()` returns `items: []`, the rail renders only `Unsorted` + New collection plus a one-line microcopy in `var(--ink-3)`, sans `--text-xs`: *"Group related batches into collections."*

**Pin star on history items**: A 14×14 lucide `star` button in the top-right of each history item card. Hover-revealed when unpinned (opacity 0 default; 1 on item-card hover or star focus); always visible when pinned (filled via `data-pinned="true"` → CSS `fill: currentColor`). Click stops propagation and toggles `pinned` server-side.

**Keyboard**: roving tabindex within the rail. Tab enters at the active row; ↑/↓ navigates within the rail (wraps); Home/End jumps to first/last; Enter activates. Inline-input states (rename, create, search) pause the model and restore focus to the triggering row on commit/cancel.

**Live region**: a single rail-level `aria-live="polite"` region announces count changes (e.g. "Logo concepts, 13 batches"), debounced 300ms so rapid changes don't spam screen readers.

**Mobile (≤767px)**: search is always-expanded as a full-width row with 16px font (avoids iOS auto-zoom). The drawer header gains a `Cancel` text button in non-idle inline-input states (creating / renaming / searching) — clears the active state and returns to idle.

### Template Editor

At widths of 768px and above, the Template Editor panel scrolls vertically only when its content exhausts the available height, with overscroll contained in the panel. The body, field and textarea grow without shrinking; the textarea keeps at least six lines plus its existing padding and border (`--template-body-min-h: calc(6lh + 22px)`) and cannot be manually resized. Labels, help text, the Referenced lists disclosure and actions remain in normal flow without overlap. In ordinary tall layouts the body fills the available space and the header and footer retain their usual positions. When exhausted, the complete panel scrolls, so the header and Save can scroll away and the footer remains reachable. Phone scrolling, touch and keyboard behavior, disclosure motion and reduced motion remain unchanged. Opening the disclosure grows downward; closing may naturally clamp the scroll position. The prototype has no Template Editor; its CSS records this scoped size and behavior without adding a new surface.

### Variable List and Dimension editors

At widths of 768px and above, only these two editor panels gain an overflow-only fallback with contained overscroll. The header, Save and toolbar stay in normal flow and scroll with the panel when fixed chrome plus the usable body minimum cannot fit. Their existing list body remains the ordinary scroller and keeps flex shrinking, so long content does not force the entire panel to scroll in normal-height layouts. The body minimum (`--list-dimension-body-min-h: 72px`) reserves one complete 44px control row plus its existing 14px top and bottom padding and mask clearance. Matching 14px body scroll padding keeps native scrolling and focus reveals clear of the retained fade. Header and toolbar positions in normal-height layouts, phone geometry and scrolling, touch targets, keyboard and reorder behavior, local drafts and motion remain unchanged. The prototype has neither editor; its CSS records this scoped fallback without adding surfaces.

### Canvas

**Container (`.canvas`)**: the table (`var(--bg)`), vertical scroll with a 14px fade at both edges; where scroll-driven animations exist the top fade opens at scroll 0 and returns over the first 28px of scroll, padding `28px 36px 180px` (the bottom 180 reserves space under the floating composer).

**Empty state**: `StateView` (`web/src/components/StateView`), a flex column with gap 18px. Passive Canvas states centre above a stable bottom reserve: 241px on desktop and 77px plus the safe-area inset on phone. Composer resizing and view remounts leave the artwork in place. Populated feeds and actionable history errors retain the live Composer reserve so their controls remain reachable by scrolling. When the Canvas is at least 560px wide but shorter than 440px above that reserve, an actionable etched state becomes one centred row: a 64px plate (the etching at 48px with 8px padding), the heading over the body (4px apart, start-aligned, type unchanged), then the action, with 18px between columns, starting at the top of the content box. Passive states, narrower Canvases and taller ones keep the stacked state. Without body text, the heading centres beside the plate. Long error text can grow the row and remains scrollable. The plate, heading and body fade in together over `--dur-overlay`; the navigation stage owns spatial motion.
- **Plate**: the `empty-canvas` etching (360px wide on desktop, 240px on phone) inside `.plate`: `var(--bg-sunk)`, `box-shadow: var(--plate-mark)`, `--radius-tile`, 24px padding (16px on phone). See The plate and etched art.
- **Heading** "What would you like to make?": serif `--text-display`, weight 400, line-height 1.15, `text-wrap: balance`, color `var(--ink)`, max-width 520px.
- **Body** "Write a prompt, pick a model, press ⌘ ↵.": sans `--text-sm`, line-height 1.55, max-width 420px, color `var(--ink-3)`. Under exactly `(hover: none) and (pointer: coarse)`, first-run and empty-collection Canvas instead show "Write a prompt, pick a model, tap Generate.", matching Composer help. CSS selects one visible, accessible variant. The keys are `<kbd>` caps: mono `--text-2xs`, `var(--bg-elev)` background, `1px solid var(--line)` border with a 2px bottom border, `--radius-control`.
- A search with no matches shows `empty-search` art, "No results found" and a one-line suggestion; a history error shows `state-error` art with a Retry secondary button; loading shows the plate at rest (`restPlate`: a 96px 3:2 empty plate breathing with `atelier-pulse`).

### Batch

**Container (`.batch`)**: a sheet laid on the table: `var(--bg-elev)`, `var(--shadow-1)`, `--radius-panel`, 16px padding and a 28px top margin between batches (12px and 20px on phone; no margin on the first batch). The sheet's edge marks the break between batches; there is no divider rule. Entrance once per batch id (`seenBatches`), never replayed.

**Header**: flex row, baseline-aligned, 14px gap, 8px bottom margin; no rule under it. Below 768px the prompt takes the first row alone and the meta line and actions share the second, centred on each other.
- **Prompt**: the batch heading is data, so it sets in the sans: `--text-md`, weight 500, line-height 1.45, color `var(--ink)`, flex 1, single-line ellipsis. The full prompt opens in the `BatchPrompt` prose card (`--bg`, 1px `--line-2`, `--radius-panel`, `--shadow-photo`).
- **Meta cluster**: a `Meta` list with `lead` (sans `--text-xs`, `var(--ink-3)`, tabular figures, 10px gaps, no separators): model name (first field in `var(--ink-2)`), ratio, an optional sequence or story chip (`Part 2 of 3, 0:10`, `Part 2 of 3, stitching…`, `Story failed`; 1px `--line`, `--radius-control`, `var(--ink-2)`), the queue state while queued (`Queued, 3 ahead`, `Queued, next`), relative time ("just now", "5m ago", "2h ago", or locale date), then, when `batch.collectionId` is set, a borderless folder-glyph + collection-name button that opens the Move popover, and the template provenance (sparkle + template name, seed in its tooltip). The relative-time field is hidden below 768px to prevent meta wrap on phones.
- **Actions**: 28×28 `buttons.iconAction` buttons (44×44 under the touch gate; transparent at rest in `var(--ink-3)`; hover `var(--bg-sunk)` fill and `var(--ink)`), 4px apart, in order: a filled pin star only while pinned (`aria-pressed`, "Unpin batch"), Play master on a sequence tail with a ready master, Copy prompt (below 768px it moves into More), Re-roll, Move to collection (folder-plus, filled while the batch is in a collection; opens the Move popover anchored to itself), Archive batch, and More (⋯) with the remaining actions, omitted when empty. None uses `--accent`. At viewport widths at least 768px, the one-line prompt reserves `max(240px, 50% of the header)` before meta and actions wrap below, with actions end-aligned. The intrinsic flex layout keeps one row when the cluster fits; below 768px the meta list keeps 96px before the actions wrap. Re-roll and Move honor read-only actions; Copy stays enabled. More retains Reopen in picker, sequence/story actions, Save to templates and Pin with their existing availability. The archive button uses the archive (box-with-slot) icon; main-feed removals are soft deletes that move tiles to the Archive view for 30 days before permanent deletion.

**Grid (`.grid`)**: CSS grid `repeat(auto-fill, minmax(260px, 1fr))`, 14px gap.

### Move popover

Anchored to the batch-header Move icon. Opens on Move-icon click or collection-meta-token click; each anchors to the trigger that opened it.

**Desktop (≥768px)** — popover layer:
- The shared menu panel (`styles/menuShell.module.css`): 220px wide, `--radius-panel`, `var(--bg-elev)` background, `1px solid var(--line)`, `--shadow-2`, 6px padding; rows `--radius-control`, 36px, `var(--bg-sunk)` on hover and focus.
- Placed by native anchor positioning (`hooks/useNativeAnchor.ts`, `styles/anchors.module.css`; see [Native anchors](../native-anchors.md)): below the trigger by default, flipping above when there isn't enough room.
- Enter: opacity and `translateY(var(--m-shift))` → 0 over `--dur-overlay` `--ease-out`; leave: fades and settles 2px over `--dur-overlay` `--ease-exit`.
- `--z-popover: 50` (between canvas content and the lightbox layer at 100).

**Mobile (≤767px)** — bottom sheet:
- The shared sheet (`styles/sheet.module.css`): full-width, `--radius-sheet` top corners, max-height 60dvh, slides up over `--dur-sheet` `--ease-out` and back down over `--dur-overlay` `--ease-exit`; rows grow to 44px.
- Backdrop: `var(--scrim)` + `backdrop-filter: blur(8px)`; tap dismisses. Esc also dismisses.
- Swipe-down dismiss is deferred to a future phase.

**Every bottom sheet obeys two rules** (they read as details and behave as bugs when missed — the Move popover, the Prompt Picker and its axis sheet, the batch overflow menu, the Prompt Library help panel, the chip menus and the shared dialog sheet all follow them):

- **The backdrop dismisses on a completed tap, never on `pointerdown`.** A tap fires `pointerdown` first; dismissing there unmounts the backdrop mid-tap and the click lands on whatever is underneath — WebKit dispatches it on the element now under the finger, so the tap bleeds into the layer below (closing a parent sheet, collapsing the composer, opening a tile). Wherever a sheet renders a backdrop, `useOutsidePointer` is disabled and the backdrop's own click is the dismissal path.
- **The sheet's bottom padding carries `env(safe-area-inset-bottom)`.** `viewport-fit=cover` lets a flush-bottom sheet run under the home indicator, putting its last action row in the OS gesture strip.

**Markup**:
- `role="dialog"`, `aria-label="Move to collection"`.
- Header label "Move to collection" in the small-caps label (the menu group label).
- `<ul role="list">` of rows. **`(Unsorted)` is ALWAYS the first list item.** Each row is a `<button>` with the same geometry as Library rail rows. ✓ (lucide `check`) marks the row matching `batch.collectionId` — including the `null` / Unsorted case.
- Divider, then a New collection row (plus glyph and label).

**Behaviour**:
- Click a collection row → `useMoveBatch` with that id → popover closes; the optimistic cache update flips ✓ to the new row before the server response.
- Click `(Unsorted)` row → `useMoveBatch` with `collectionId: null` → popover closes.
- Double-click on a collection row name → swap to inline rename input within the popover (sr-only `<label>`, Enter commits, Esc cancels). The focus trap continues to apply; focus returns to the row button on commit/cancel.
- New collection: click → inline input below with a visible **Move** button beside it in a flex row, gap 6px, aligned center. Input flexes with `min-width: 0`; Move composes ink-primary, height 36px, padding 0 12px, `--text-xs`; input and button have 44px minimum height under the touch gate. Move and Enter share `useInlineEdit.commit` → `useCreateCollection` → `useMoveBatch({ batchId, collectionId: newId })`; success closes the popover. Empty trimmed names disable Move; empty Enter retains cancellation. A synchronous local guard spans both mutations, disabling Move (`aria-busy`) and draft editing while displaying the entered name. Failure shows the actual error toast and permits deliberate retry. Tab or pointer focus within the create row retains the draft; leaving it cancels without stealing focus. Esc cancels to the remounted New collection button, then closes on the next Escape; IME, rename, dismissal and late mutation semantics remain unchanged. The prototype Move mock has no create input and records this production-only exception in its CSS comments.

**Focus + dismiss**:
- Focus trap reuses the Lightbox recipe (no library). Tab cycles within the popover; Shift+Tab cycles backward.
- Esc closes; click-outside closes; focus returns to the trigger captured at open time. If the collection token disappears after a move to Unsorted, focus falls back to the persistent Move icon.
- Reduced motion: the shared rule set (see Motion) turns enter and leave into an 80ms opacity change; the sheet swaps its slide for the same fade.

### Tile (Image)

**Container**: the shared tile shell (`web/src/components/tile/shell.module.css`, also composed by loading, failed and Archive tiles): `var(--bg-elev)` bg, `1px solid var(--line)`, `--radius-tile`, overflow hidden, `cursor: zoom-in`.
- **Entrance**: `atelier-tile-in` over `--dur-entrance` `--ease-out` — opacity 0→1, `translateY(var(--m-shift))` → 0. Once per batch (`data-seen`).
- **Hover** (and keyboard focus on the frame): `border-color: var(--line-2)`, `transform: translateY(-2px)`, `--shadow-2`; focus adds the 2px `--focus-ring` outline.

**Frame**: aspect-ratio set to `{w} / {h}` from the ratio definition (e.g. `1024/1024` for 1:1). Background `var(--bg-sunk)`.

**Image**: object-fit cover. Pixels stay transparent until native load/decode readiness. Fresh, unseen images transition from `grayscale(1) blur(var(--m-blur))` and opacity 0 to an unfiltered image at opacity 1 over `--dur-reveal` `--ease-out`, without scaling. Other newly loaded images fade over `--dur-hover`; completed cache hits appear without replaying the reveal.

**Readiness mat (`.reveal`)**: every still-image tile keeps a sibling mat (absolute fill, `pointer-events: none`, `background-color: var(--bg-sunk)`) at opacity 0.8 until pixels are ready, then dissolves it over `--dur-reveal` `--ease-out`. This matches the LoadingTile veil for a continuous loading-to-done handoff. The wipe stops when generation finishes. `completedAt` freshness (`Date.now() - tile.completedAt < 2000` at mount), together with the batch's seen state, gates the developing filter. Cached remounts skip both transitions, so history navigation does not replay the reveal.

**Hover overlay**: absolute fill, gradient `linear-gradient(180deg, transparent 60%, var(--scrim-tile) 100%)`, opacity 0 → 1 on hover and focus-within over `--dur-overlay`.
- **Bottom row**: on the left a `Meta` list of the tile number and ratio (`1`, `1:1`; sans `--text-2xs` 500 in `--glass-on-dark-85`, text shadow), with a film glyph on video; on the right the `buttons.tileAction` glass buttons (`--scrim-control`, 1px `--glass-on-dark-12`, `--radius-control`, blur 8px; hover `--scrim-strong`). Icons: download, archive, expand, plus the optional edit, animate and extend actions. (The archive icon — box-with-slot — replaces the conventional trash because main-feed removals soft-delete to the Archive view; reserve the trash icon for the Archive view's "Delete permanently" action.)

### Tile (Loading)

Replaces the image while `status === 'loading'`. Aspect ratio matches the requested ratio.

**The plate wipe** inside the frame (`web/src/components/tile/LoadingTile`), monochrome until the image arrives:
1. **Plate** (`.loading`): `var(--bg-sunk)` with `box-shadow: var(--plate-mark)`.
2. **Wipe** (`.loading::after`): an oversized layer tilted 20° carrying one `var(--scrim-scan)` band (42% → 50% → 58%), crossing the plate diagonally with `atelier-sweep` every `--cadence-loop` (1.6s), linear. Under reduced motion it holds still and swaps to `atelier-pulse`.
3. **Status line** (`.text`): bottom-left on a triple `--scrim-on-image` backing, `--radius-control`, 4px 6px padding, sans `--text-2xs` 500 in white with `--shadow-text-on-image`. Content: a 60×1px progress bar with a sweeping `--accent` fill, then a `Meta` list `{modelName}`, `{elapsed}s`. Elapsed updates once a second (sub-second updates churn React state with no UX gain).

**Queued tile**: the plate at rest (the same mat and plate mark, no wipe) with the queue state bottom-left (`Queued, 3 ahead` or `Queued, next`) on the same backing.

**Veiled mode (preview present)** — When the upstream emits partial previews mid-generation (e.g. cliproxy `image_generation.partial_image` SSE frames), the developing image is rendered **behind** the placeholder, not in place of it:

1. **Preview** (`.preview`): absolute fill, `object-fit: cover`, `transform: scale(1.06)` (overscan to hide blur halo), `z-index: 0`. Heavy initial blur sharpens with each new partial — a CSS variable `--pass-blur` keyed off `data-pass="1..5"` maps the upstream `partial_image_index` to `12 → 8 → 4 → 2 px`; index `0` (or absent) uses the default `16px`. Filter transitions over `600ms cubic-bezier(.2,.8,.2,1)` so each new pass reads as "sharpening into focus" rather than a hard repaint. Entrance `preview-in` 320ms ease-out (opacity 0→1).
2. **Veil** (`.loading.veiled`): the placeholder layer drops its opaque `var(--bg-sunk)` fill to transparent and reduces overall opacity to **0.8**, so the developing image is visible through the continuing wipe and progress bar. Background-color and opacity transition over `--dur-reveal` `--ease-out`.
3. **Status line** stays at full opacity — it's pulled out of the veil's stacking context so the model and elapsed fields remain legible over bright partials; the progress fill turns white so it keeps 3:1 over any preview.

The veil persists through the loading→done handoff (see "Fresh-completion reveal" under Tile (Image) above): same mat, same easing, same starting opacity. Visually continuous; nothing flashes or swaps.

### Tile (Failed)

**Body**: absolute fill, 18px padding, `var(--bg-elev)` bg with 45° hatched stripes (`repeating-linear-gradient(45deg, transparent 0 8px, var(--bg-sunk) 8px 9px)`).
- **Icon**: alert-triangle, color `var(--danger)`.
- **Title** "Generation failed": the small-caps label in `var(--danger)`.
- **Message**: sans `--text-xs`, `var(--ink-2)`, line-height 1.5. The error string from the backend (or the mock's reason).
- **Actions**: two compact buttons (Retry, Dismiss) — sans `--text-xs` 500 with an icon, `1px solid var(--line-2)`, `--radius-control`, 5px 9px padding (44px tall on touch devices). Hover: invert to `var(--ink)` bg, `var(--bg)` text.
- **Phone** (`width < 768px`): no image footprint and no stripes; the tile is as tall as its content: icon and title on one line, the message, then the actions in one row.

**Behavior**: Retry calls generate again with a new random seed (preserves prompt/model/ratio); Dismiss removes that single tile. If all tiles in a batch are dismissed, the batch is removed.

### Video (I2V) — project-side extension

Image-to-video (animate a still into a clip of user-chosen length — 5 / 10 / 15 s) is a post-handoff feature, gated behind `VIDEO_MODELS_ENABLED`. It reuses the existing tile/composer vocabulary rather than introducing new chrome.

**Animate action.** A first-class tile-overlay action (film glyph, alongside Download/Archive/Expand) and a Lightbox bottom-bar action, shown only on image tiles when an I2V model is available. Clicking it shows an on-glass pending spinner while the still is fetched + uploaded as the source, then opens the Composer in video mode (shared `useAnimateFromTile` hook). Reachable on touch (always-visible overlay), not hover-only.

**Composer (video mode).** When the selected model does I2V: the generic prompt textarea and the Templates/Enhance controls are hidden, and a `.videoPanel` animates in (opacity + 6px rise, `--dur-sheet`). It holds (1) the **source still as a 64px framed thumbnail** — click to replace, corner `×` to clear, an overlay spinner during a replace that keeps the prior frame until the new one resolves (never an id string), and (2) the **motion prompt** as the single hero textarea. The motion prompt is **required** (Generate stays disabled, statusline reads "Describe the motion to animate", until set). The count chip locks to ×1 and a **Duration** chip (`DurationChip`, 5 / 10 / 15 s off `VIDEO_DURATION_FRAMES`) picks the clip length; Generate is labelled **"Animate"** and the statusline shows the `~12 min` render estimate (a flat display hint, `web/src/lib/i2v.ts`, not scaled by duration). A quiet **"‹ Images"** exit chip (the composer `.chip` vocabulary, `chevronLeft` glyph, `aria-label`/tooltip "Back to image generation") sits in the panel's top-right corner — clicking it restores the last image model the user was on (falling back to the first image model) which is what leaves video mode, so the exit is discoverable without adding new chrome. The bottom-row Model chip remains an equivalent exit.

**Tile (Video).** A done clip renders via `ClipFrame`: `<video muted playsInline loop preload="none">` + a centred glass play badge. On pointer devices it **autoplays muted on hover** (paused + rewound to the poster on leave); on touch it plays while in view (IntersectionObserver, paused off-screen) — the energy-correct pattern, never audio, never off-screen. The badge fades out while playing; a clip-duration chip (`0:05`, top-left on `--scrim-control` glass, sans tabular numerals, `--radius-control`) appears once metadata loads; the overlay index token carries a film glyph so video reads as video at a glance in a mixed grid. `prefers-reduced-motion` keeps a static poster + badge. Entrance: `clip-in` (fade + blur + scale, `--dur-reveal`).

**Loading (Video).** A render runs ~11–13 min, so the loading tile is video-aware: the `{model}`, `{elapsed}s` fields become `{model}`, `m:ss / ~12:00` with tabular figures (a 13-min render must never read "740s"), the determinate progress bar is given more presence (88×2px), and the **uploaded source still is veiled behind the loading layer** (the `.preview` veil vocabulary at a fixed gentle blur, `data-source`) so the user watches the frame being animated. 

### Video sequences (Extend) — project-side extension

Longer videos are built by extending: a done video tile grows a clip-chain, one segment at a time, and the server keeps a stitched master.

**Extend action.** Sibling of Animate on done video tiles (distinct extend glyph in `I.tsx`), in the tile overlay, the Lightbox bottom bar, and the sequence overflow menu — shown only when the tile is standalone or its sequence's tail and an I2V model exists. Click shows the on-glass pending state (duplicate clicks ignored, abort on unmount, failure → toast) while the server extracts the last frame, then opens the Composer in extend mode (`useExtendFromTile`).

**Composer (extend mode).** Video mode variant: the handoff frame is the source thumbnail, Generate is labelled **"Extend"**, the Ratio chip is locked to the sequence's ratio (disabled with tooltip, never hidden), Duration stays live. Leaving video mode or Clear wipes the extend draft fields (`extendsTileId`, `extendPrevPrompt`). Submit passes `extendContext` to motion enhancement so the rewrite continues the previous clip's motion, identity block, and soundscape.

**Sequence chrome.** Segment batch headers carry a chip — `Part k of n, M:SS` (24 fps total), `Part k of n, stitching…` while the master rebuilds, `Part k of n, master failed` on error. The overflow menu gains a grouped sequence section: Play master (Lightbox viewer plane, native video controls), Download master (both gated on `masterStatus === 'ready'`), Extend (tail only), Discard tail (danger confirm; 409 while a linked render runs → "wait for the render" toast). Master status converges by polling — any visible stitching sequence keeps the adaptive history cadence alive; there is no sequence SSE.

### Composer

**Wrapper (`.wrap`)**: position absolute, bottom 24px, centred with auto inline margins between zero left/right insets, `width: calc(100% - 72px)`, `max-width: 920px`, `z-index: var(--z-composer)`. The wrapper owns the surface, shadow and radius; its `::before` edge follows the live animated footprint through collapse and reversal.

**Card (`.composer`)**: padding `14px 14px 10px`, flex column gap 10, with a transparent border reserving the edge's space. The wrapper paints ground glass (`--glass-surface` + `--glass-blur`, opaque `var(--bg-elev)` fallback), a 1px `--line-2` edge, `--radius-panel` and `--shadow-3`. Focus within the expanded form changes that edge to `--focus-ring`. On phone the wrapper is a fixed-bottom sheet with `--radius-sheet` top corners and `--shadow-2-up`; the form retains safe-area bottom padding.

**Textarea**: borderless, transparent bg, no resize handle, sans `--text-md` (`--text-base` on phone), line-height 1.5, min-height 48, max-height 180. Grows with its content (`field-sizing: content` where supported). Placeholder "Describe an image…" in `var(--ink-3)`.

**Limited-height image Composer**: only `@media (width >= 768px) and (height <= 620px)` compacts the image-mode body, excluding inventory/error-only cards and video mode. Top padding becomes 10px; horizontal padding, the 10px row gap, 10px bottom padding, 10px footer-to-status gap and 22px status rail stay unchanged, keeping Generate anchored. A grid uses `auto minmax(0, 1fr)` columns with all flow children spanning both. Without reference chips, Attach and the image prompt share the first row; the textarea's actual width reserves the existing absolute Minimize hit region by subtracting its canonical 28px width plus 16px from the grid cell's end, using 44px plus 16px under the touch gate. With references, when the Composer content box is at least 640px, the reference row (Attach and chips) takes the first column, top-aligned, capped at 40cqi and wrapping inside it, with 4px end padding so 44px coarse-pointer remove targets keep clear of the prompt. The prompt takes the second column with the same Minimize reservation. Narrower Composers keep separate rows. Chip part motion and footprint animation are unchanged. The prompt has a 32px minimum, raised to 44px under `@media (hover: none), (any-pointer: coarse)`, and `max-height: calc(3lh + 10px)` with natural vertical scrolling beyond three lines. Minimize position, handlers, focus and the existing mode ViewTransition remain. Phone widths below 768px retain their layout. The prototype has only the image textarea and footer, so it mirrors the matching padding and textarea rules without adding Attach, reference, Minimize, video or dock surfaces; the target reservation applies only to production's compact shared row. The approved reference, Move and copy exceptions are recorded in matching root comments across all three CSS owners; existing token values are unchanged. These scoped extensions reuse existing sizes and introduce no tokens; the root comment is synchronized across all root owners.

**Chip row (`.composer-row`)**: flex row, 8px gap, wraps.

**Chip (`.chip`)**: `1px solid var(--line)` border, `--radius-control`, `var(--bg)` bg, padding 6px 10px, sans `--text-xs` 500 in small caps (`all-small-caps`, `letter-spacing: 0.04em`) with tabular lining figures, `var(--ink-2)`; the value span in `var(--ink)`. Press scales; hover and selection change colour over `--dur-hover`. The chip wraps a hidden absolute-positioned `<select>` (opacity 0, fills the chip) so the native dropdown appears on click. Hover: `var(--bg-sunk)` bg, `var(--line-2)` border, `var(--ink)` text.

Three chips: Model (grouped by `<optgroup>` for Local/Cloud), Ratio (1:1, 4:5, 3:4, 16:9, 9:16), Count (1–4).

**In-flight indicator (`.inFlight`)**: a small neutral badge at the right of the status rail while tiles are in flight: sans `--text-2xs` 500 tabular numerals, `var(--ink-2)` on `var(--bg-sunk)` with a 1px `var(--line-2)` edge, `--radius-control`, 3px 6px padding (`--accent` stays reserved for AI actions), format `N/cap` plus `M queued` when batches wait (an AI fill or burst preparation shows the text model's name instead). Hidden when nothing runs. At capacity it fills `var(--danger)` with `var(--bg)` text. The per-click rejection (toast) carries the exact failure reason, so the indicator stays a simple capacity gauge instead of trying to predict which click will fail (re-roll and retry use derived counts, not the Composer's count chip). Colour changes over `--dur-transform` `--ease-out`; a polite live region carries the full sentence ("3 of 4 tile slots in use, 1 queued").

**Help line**: under the footer, a `Meta` list (`--text-xs`, `var(--ink-3)`): "⌘ ↵ to generate" with the keys as `.kbd` caps (mono `--text-2xs` 500 on `var(--bg-sunk)`, 1px `--line-2`, `--radius-control`), then the polite status message. The shortcut field is hidden on touch-only devices (`hover: none` and `pointer: coarse`).

**Generate button (`.go`)**: `var(--ink)` bg, `var(--bg)` text, `--radius-control`, padding `8px 14px 8px 16px`, fixed 11.75em width (sized to its label when the desktop composer is narrower than 560px, so the toolbar beside the open rail at 820px keeps two rows), sans `--text-sm`; the label is the plain verb "Generate" ("Animate", "Extend" in video modes), never an arrow. Hover `var(--ink-2)`; press `scale(0.98)`. Disabled (no prompt or no available model inventory): opacity 0.4. A failed background inventory refresh retains cached models. On phone it fills the dock in `--text-md`; on touch devices it is 44px tall. Stays *enabled* while generations are in flight: multi-flight is the rule, and a batch submitted at capacity queues (see § Concurrency cap).

**Composer command dock (project-side extension)**

Enhance/Undo are post-launch additions never present in the prototype. The shipped footer is a two-zone command bar, not the prototype's single chip row: a `.controls` zone (Templates, the Enhance segmented control, Model, Ratio, Count) that may wrap internally, and a fixed-width `.dock` sibling (Clear, Generate) separated by a hairline `var(--line)` divider. Generate is bottom-anchored inside the dock and is spatially invariant across every state — if the controls wrap, the card grows upward, away from it. The Enhance control is a segmented `[Enhance │ ↺]` whose revert segment is always in the DOM (dimmed until an enhance is undoable), so it can never insert/remove and cause a reflow. The prompt-library chip shows icon + `Templates`; the Model chip shows a short family token (`GPT` / `Banana` / `Local`) with the full name in the dropdown, batch header, and hover title. Ref/local hints render on one reserved-height `.statusline` in the help line below the footer, with the in-flight pill at its right. All other Composer tokens are unchanged from the spec above.

**Submit shortcut**: ⌘+Enter / Ctrl+Enter from anywhere in the textarea.

### Lightbox

**Backdrop**: position fixed, fill viewport, `var(--scrim-strong)` + `backdrop-filter: blur(12px)`, `--z-lightbox`, flex centered, `cursor: zoom-out`. Entrance: opacity fade over `--dur-sheet`.

**Frame**: relative, fitted to the batch ratio within `90vw` and `calc(100dvh - 120px)` before image readiness, `var(--bg-sunk)` behind the image, `--radius-tile`. Entry transitions from `scale(var(--m-scale))` and opacity 0 over `--dur-entrance` `--ease-out`; exit fades and scales back over `--dur-overlay`. Differing image ratios fit inside the reserved frame. Video retains its native intrinsic fit.

**Image**: same max constraints, `--radius-tile`, `--shadow-photo`. Full images remain transparent until load readiness, then fade in over `--dur-sheet`, including when no thumbnail is available.

**Close button**: top-right 24,24, 40×40 circle, white-on-dark glass (`--glass-on-dark-8` + blur 12, 1px `--glass-on-dark-10`). Hover rotates 90°.

**Nav buttons (`.lb-nav`)**: vertically centered, 24px from each edge, 44×44 circles, similar glass treatment. Disabled at array bounds.

**Bottom bar**: position fixed, bottom 28, centered. `var(--scrim-panel)` + `backdrop-filter: blur(20px)` + `1px solid var(--glass-on-dark-8)`, `--radius-panel`, 6px padding.
- **Info segment**: 12px horizontal padding, right-bordered with `--glass-on-dark-10`, 28px tall. A `Meta` list with `lead` on dark: sans `--text-xs`, fields in `--glass-on-dark-65` (`--meta-ink`), the model name first in white weight 500 (`--meta-ink-strong`), one line, each field ellipsizing. Fields: model name, ratio, natural `{w}×{h}`, `{n} of {count}`. On phone the segment takes its own row above the buttons.
- **Buttons**: sans `--text-xs` 500 in `--glass-on-dark-85`, `--radius-control`, hover `--glass-on-dark-10`. Download, then a context-sensitive remove button using the `.danger` modifier. In the **history** lightbox it renders as **Archive** with the archive icon (soft delete → Archive view); in the **archive** lightbox it renders as **Delete** with the trash icon (permanent removal of an already-archived tile).

**Keyboard**: Esc closes, ←/→ navigates between done tiles only (skips loading and failed).

### Lightbox zoom — project-side extension

The prototype only ever showed the image fitted to the viewport, which downsamples most renders. The shipped viewer adds a second step at **1:1** (one image pixel per CSS pixel), offered only when the natural size beats the fitted size by ≥1.05× — below that there is no button, no cursor change, and no gesture. The image is transformed with `translate3d(x, y, 0) scale(s)` about its own centre, so its layout box never moves and the frame chrome stays put.

- **Enter / exit**: click the image (mouse/pen), double-tap it (touch), or press the bottom-bar toggle. Clicking zooms **around the pointer** — the point under the cursor stays under it; the toggle zooms about the centre. Touch keeps its single tap free for swipe-to-dismiss, which is why it needs a double-tap.
- **Pan**: mouse drag, touch drag, two-finger trackpad scroll, or `←`/`→`/`↑`/`↓` (96px a press). Translation is clamped so the scaled image always covers the viewport; dragging past that gives with iOS-style resistance and snaps back to the bound on release.
- **Continuous zoom**: trackpad pinch / ⌘-scroll (a `ctrlKey` wheel event) between fit and 1:1, anchored on the pointer. Touch pinch zooms and pans at once, overshoots to 0.8×/1.3×, and settles back into range on release. The wheel listener is bound natively, not through React, because React marks its delegated `wheel` handler passive and the browser's own page zoom has to be `preventDefault`ed.
- **Motion**: reuses the swipe snap-back transition (`--dur-transform` / `--ease-out`), suppressed while a pointer is driving the transform. At 1:1 the image drops its `--radius-tile` corners and photo shadow — both read as mistakes once scaled 3×.
- **Cursors**: `zoom-in` when zoomable, `grab` / `grabbing` while zoomed.
- **Info segment** appends a `{pct}%` field while zoomed, after the model, ratio, size and index fields.
- **Escape unwinds one level**: out of zoom first, then out of the viewer. Backdrop clicks behave the same way; the close button always dismisses outright. While zoomed, `←`/`→` pan instead of stepping between tiles — the on-screen prev/next buttons still navigate.
- Zoom resets on tile navigation, on switching to a reference image, and when a resize makes the fitted view large enough that 1:1 no longer applies. Video tiles keep their native controls and are never zoomable.

Geometry and clamping live in `web/src/lib/imageZoom.ts` (pure, unit-tested); gesture handling in `web/src/hooks/useImageZoom.ts`.

### Toast

**Stack**: toasts stack in a grid (8px gap) that hangs 16px above the Composer card, centred on it, through native anchor positioning on `--atelier-composer`; without anchor support or a mounted Composer it rests top-centre of the content column. Confirmations land next to the surface the user just acted on. The stack never takes the pointer; a toast with an action does.

**Toast (`web/src/components/Toast`)**: an ink sheet: `var(--ink)` bg, `var(--bg)` text, `--radius-panel`, padding 9px 16px, sans `--text-xs` 500 in sentence case, line-height 1.3, with a 14×14 check glyph in `--good-on-ink`. Error toasts fill `var(--danger)`; soft toasts are a `var(--bg-elev)` sheet with a 1px `--line` edge. It rises `var(--m-shift)` with `--ease-tactile` over `--dur-settle` and leaves fading 2px down over `--dur-overlay` `--ease-exit`. Auto-dismiss: 2000ms (soft 3500ms, error 6000ms, actionable toasts set their own). An action (Undo) is an outlined button in the toast's own colour, `--radius-control`, at least 44×44 on touch devices. Identical (text, tone) toasts without an action dedupe. While the phone drawer is open the stack fades out over `--dur-overlay`, each visible toast goes inert and `aria-hidden` (the polite and assertive live regions stay exposed), and every toast holds its timer; closing the drawer brings them back with the time they had left. An actionable toast raised while the drawer covers the stack is announced through the polite live region and stays there (its visible copy drops its own status role), so it is announced once.

Trigger toasts on: download success ("Downloaded"), main-feed soft-delete ("Archived" — single tile, batch, or full clear-all), prompt copy ("Prompt copied"), archive restore ("Restored"), archive permanent delete ("Deleted").

**Informational glyph semantics**: a soft toast omits the glyph and its wrapper. Success, including an omitted tone's success fallback, retains the check; error retains the alert. Text, actions, portal host moves, live announcements, timers, deduplication, Undo, covered/inert behavior, focus and motion keep their existing owners. The prototype emits success strings only, so its check remains; soft/error variants are production extensions documented here and in its CSS literal. No new token is needed.

## Interactions & Behavior

**Touch**: every touch target is at least 44×44 on a touch device, decided by capability (`@media (hover: none), (any-pointer: coarse)`), never by viewport width, so iPad (with or without a keyboard) and touch laptops get the same floor as phones.

### Submit flow
1. User types prompt, optionally changes model/ratio/count.
2. ⌘+Enter or click Generate.
3. New batch is **prepended** to the batches list (top of canvas).
4. The first batch of a burst scrolls into view; the rest of the burst does NOT
   re-scroll. One follow per burst — every SSE `batch` event pulses a scroll
   request, so arming a spring per batch made the feed oscillate for the whole
   burst. Prepends after that are absorbed by the virtualizer's `anchorTo`
   anchoring (`web/src/lib/feedAnchor.ts`): pinned at the top new work flows in,
   scrolled into history nothing moves under the reader.
5. N tiles render in `loading` state immediately, each with their own `startedAt` timestamp.
6. Backend calls fire in parallel — each tile resolves to `done` (with image URL) or `failed` (with error message) independently.
7. Failed tiles can be retried (new seed, same prompt/model/ratio) or dismissed.

### Concurrency cap
Each pool runs a bounded number of tiles at once (per user, `MAX_CONCURRENT_TILES_PER_USER`). A batch that cannot start at once is not rejected: `POST /api/generate` persists it as `queued` and reports `queueLengthAhead`, and the batch starts by itself when earlier work frees slots. Queued tiles show the plate at rest with "Queued, N ahead" (or "Queued, next"); the Composer's in-flight badge counts running slots plus waiting batches. Roll-queue submissions that meet capacity raise a soft "queued, will generate automatically" toast. Server-side queue order, local-model affinity and recovery: [`docs/architecture.md`](../architecture.md).

### Re-roll
The re-roll button on a batch header repopulates the composer with that batch's prompt/model/ratio/count and immediately submits — useful for one-click variations. Subject to the concurrency cap above.

### Tooltips
All icon-only buttons carry both `aria-label` (screen-reader contract) and `data-tip="Label"` (visual tooltip).

- The `[data-tip]` primitive (`styles/global.css`): one shared label node, shown as a manual popover anchored to its host by `hooks/useTooltipDismiss.ts`; CSS owns every coordinate. Default position is **above** the host, with `data-tip-place` modifiers (locked in `lib/tooltip.ts`) such as `below` for top-of-viewport elements (lightbox close, sidebar clear).
- Label style: a sentence-case sans label: `--text-xs` 500, line-height 1.3, `var(--ink)` bg, `var(--bg)` text, 4px 7px padding, `--radius-control`; one line unless it would cross the window.
- Motion: 360ms hover/focus delay, then a `--dur-hover` `--ease-out` fade + 2px slide. Under reduced motion the shared rule set shortens it to an 80ms linear opacity fade.
- Coverage: tile actions (Download / Archive / Expand), batch action cluster (Copy prompt / Re-roll / **Move** / Archive batch), batch-header **pin star**, sidebar **pin star on history items**, sidebar Library rail **search toggle**, sidebar Library rail **collection delete** (`╳`), sidebar Archive all, Prompt Library icon-only delete controls, Prompt picker close controls, lightbox Close / Previous / Next. Buttons that already render a visible text label next to their icon (lightbox bottom-bar Download/Archive (or Delete, in archive view), failed-tile Retry/Dismiss, Composer Generate, Library rail row labels) intentionally skip `data-tip` to avoid redundancy.

### Copy prompt
Writes the prompt to clipboard via `navigator.clipboard.writeText`. Shows a toast.

### Download
Filename format: `atelier_{slug(prompt)}_{modelId}_{ratio.replace(':','x')}_{seed}.{ext}`. The prototype generates SVG so it downloads `.svg`; in production, use whatever the backend returns (PNG/WebP).

### Archive (soft delete from main feed)
All "remove" actions in the main feed UI are soft deletes — the affected tiles move to the **Archive view** and live there for **30 days** before they are permanently purged. Failed/loading tiles bypass the archive (they have no completed image worth retaining) and are hard-deleted on dismiss.
- **Single tile** (tile overlay): archives the tile. If it was the last live tile in the batch, the batch is archived as well. Toast: "Archived" with **Undo** for 5s.
- **Whole batch** (icon button on batch header): archives every live tile in the batch and the batch itself. Toast: "Archived" with **Undo** for 5s.
- **Undo** restores exactly the tile IDs that operation archived, through the same restore path as the Archive view's Restore, and fires once (`hooks/useArchiveUndoToast.ts`). Failed tiles are hard-deleted, so they never come back; an operation that archived nothing shows a plain "Archived".
- **Archive all** (sidebar history-section icon): native confirm "Archive all history?" then archives every live tile and batch for the user. Toast: "Archived" (no Undo).
- **Lightbox** in history view: shows an **Archive** button with the archive icon — same soft-delete semantics. In archive view the same slot shows **Delete** with the trash icon (see Archive view below).

### Archive view
A separate view (entered from the persistent sidebar Archive button) lists archived tiles. Each tile carries an identity block below the image — a truncated one-line prompt (full text via the shared `BatchPrompt` prose reveal, hover/focus/touch) plus a `Meta` list of the model label and "Archived {date}" — and the same prompt feeds the tile's `aria-label`/`alt` and the archive lightbox. Each tile has two actions: **Restore** (move back to history; uses the re-roll icon) and **Delete permanently** (hard delete from disk; uses the trash icon). A header **Empty archive** button (`.danger` vocabulary — it is an irreversible purge) clears everything via a `ConfirmDialog`; it stays rendered and disabled while the archive is empty. The view opens under `ManagedViewHeader` (secondary "Back to Unsorted" button, the arrow alone below 768px, serif `--text-xl` title standing alone, no count beside it); archive tiles compose the feed tile shell. The empty state is `StateView` with the `empty-archive` etching in a plate.

### Keyboard
- `⌘/Ctrl + Enter` (anywhere in textarea): submit
- `Esc` (lightbox): close
- `←` / `→` (lightbox): navigate between completed images

### Persistence
Generation history (batches + tiles + their image URLs) is persisted to `localStorage` under key `atelier.history.v1`, capped at 200 entries. Production should swap this for a server-side history endpoint scoped to the user.

### History selection
Clicking a sidebar item highlights the batch as active and smooth-scrolls the canvas to it (`scrollTo({ top, behavior: 'smooth' })`).

## State Management

```ts
type Tile = {
  id: string;
  status: 'loading' | 'done' | 'failed';
  modelId: string;
  seed: number;
  startedAt: number;
  completedAt?: number;        // required on done/failed; drives the reveal-freshness gate
  url?: string;
  error?: string;
  // transient — only set while status === 'loading' and the upstream emits partials
  preview?: string;            // data:image/{png|jpeg|webp};base64,... from streaming partials
  previewIndex?: number;       // monotonic; drives the blur-sharpen curve via data-pass
};

type Batch = {
  id: string;
  prompt: string;
  ratio: '1:1' | '4:5' | '3:4' | '16:9' | '9:16';
  modelId: string;
  modelLabel: string;
  createdAt: number;
  tiles: Tile[];
};

type AppState = {
  // composer
  prompt: string;
  modelId: string;
  ratio: string;
  count: 1 | 2 | 3 | 4;

  // data
  batches: Batch[];               // newest first
  activeBatchId: string | null;

  // overlays
  lightbox: { batchId: string; index: number } | null;
  toast: string | null;
};
```

## Design Tokens

Re-identified on 2026-11-01 to the "print room" identity: plate paper, lamp-black ink, verdigris accent, the Atelier type family (renamed subsets of Adobe's Source Sans 3, Source Serif 4 and Source Code Pro). `web/src/styles/tokens.css` is the source; the prototype's `design/index.html :root` mirrors its main `:root` byte for byte (`web/test/tokens.test.ts`).

```css
--bg:            #ebeae6;               /* table: the page the app sits on */
--bg-elev:       #f7f7f3;               /* sheet: sidebar, batch frames, dialogs, menus (1.12:1 over --bg) */
--bg-sunk:       #dedcd6;               /* mat: input wells, hover rows, icon-button fill */
--ink:           #1b1d20;               /* lamp black, primary text (14.0:1 on --bg) */
--ink-2:         #44474b;               /* secondary text (7.8:1) */
--ink-3:         #5c5f63;               /* tertiary / meta (5.3:1 --bg, 6.0:1 --bg-elev, 4.7:1 --bg-sunk) */
--line:          #d6d4ce;               /* divider (decorative) */
--line-2:        #c2c0b9;               /* emphasized divider (decorative) */
--line-control:  #777a7e;               /* interactive control boundary (3.1:1 or better on all three surfaces) */
--accent:        oklch(46% 0.085 195);  /* verdigris, AI actions only; 5.6:1 on --bg */
--accent-soft:   oklch(93% 0.025 195);  /* paired with --accent (5.6:1) */
--danger:        oklch(50% 0.15 28);    /* sanguine; 5.4:1 on --bg and on --danger-soft */
--danger-soft:   oklch(94% 0.025 28);
--good:          oklch(55% 0.11 150);   /* proof green, graphical use only (3.8:1) */
--good-on-ink:   oklch(78% 0.14 150);   /* toast check glyph on --ink (8.9:1) */
--focus-ring:    var(--ink);
--plate-mark:    inset 0 1px 1px rgba(27,29,32,0.14), inset 0 0 0 1px rgba(27,29,32,0.06), 0 1px 0 rgba(255,255,255,0.75);  /* debossed plate frame */
--etch-ink:      color-mix(in oklab, var(--ink) 72%, transparent);  /* tint for etched art masks */
```

Ratios are sRGB relative luminance. Text pairs clear WCAG AA and control boundaries clear 3:1 (WCAG 1.4.11) in both themes. `--accent` stays reserved for AI actions; selected state is the 2px `--ink` bar.

**Materials**

Every surface token names what the surface is in a print room. Pick by material, not by shade.

| Material | Token | Used for |
|---|---|---|
| Table | `--bg` | the page the app sits on; the canvas scrolls over it |
| Sheet | `--bg-elev` | paper laid on the table: sidebar, batch frames, tiles, dialogs, menus, panels |
| Mat | `--bg-sunk` | under a sheet: input wells, hover rows, icon-button fill, the plate |
| Ink | `--ink`, `--ink-2`, `--ink-3` | lamp black at three dilutions; also the toast and tooltip sheets |
| Plate | `--bg-sunk` + `--plate-mark` | the debossed frame for etched art, the loading and queued tiles, empty thumbnails |
| Ground glass | `--glass-surface`, `--glass-blur` | the two floating Composer-plane surfaces only (see Frosted floating chrome) |

Shadows are contact shadows: a sheet at rest casts `--shadow-1`, a lifted surface (hover, popover) `--shadow-2`, the floating planes (composer, dialog) `--shadow-3`. Rows separate by spacing and the mat on hover, not by hairlines between every row.

**Dark theme deltas (project-side extension)**

The exempt `tokens.css :root[data-theme='dark']` block is "the plate": graphite surfaces with the same jobs and pale ink.

| Token | Dark value | Contrast |
|---|---|---|
| `--bg` / `--bg-elev` / `--bg-sunk` | `#1a1c1f` / `#222527` / `#111315` | |
| `--ink` / `--ink-2` / `--ink-3` | `#ecebe6` / `#c0c1bc` / `#95979a` | 14.3 / 9.4 / 5.8:1 on `--bg` |
| `--line` / `--line-2` / `--line-control` | `#2d3033` / `#3b3f43` / `#767a7e` | control 3.6:1 or better |
| `--accent` / `--accent-soft` | `oklch(74% 0.09 195)` / `oklch(26% 0.03 195)` | 7.7:1 on `--bg`, 6.9:1 on soft |
| `--danger` / `--danger-soft` | `oklch(72% 0.14 28)` / `oklch(24% 0.04 28)` | 6.5:1, 6.3:1 on soft |
| `--good` / `--good-on-ink` | `oklch(72% 0.11 150)` / `oklch(49% 0.13 150)` | 7.2:1; 4.9:1 on `--ink` |
| `--focus-ring` | `var(--ink-2)` | near-white `--ink` would flash on every focus move |
| `--shadow-1/2/3/2-up` | pure black alphas | ink tint is invisible on graphite |
| `--plate-mark` | `inset 0 1px 1px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.05), 0 1px 0 rgba(255,255,255,0.05)` | |
| `--etch-ink` | `color-mix(in oklab, var(--ink) 62%, transparent)` | one mask asset serves both themes |
| `--scrim-scan` | `var(--glass-on-dark-6)` | the ink sweep would read dark-on-dark |

**Frosted floating chrome (project-side extension)**

The Composer card and the desktop Prompt Picker popover are ground glass: they diffuse and desaturate the canvas behind them. Two main-`:root` tokens carry it (mirrored in the prototype `:root`, unused by `app.js`):

- `--glass-surface: color-mix(in oklab, var(--bg-elev) 90%, transparent)`: 90% keeps `--ink-3` at its on-`--bg-elev` contrast. Derived from `--bg-elev`, so it follows the dark theme without a separate value.
- `--glass-blur: blur(28px) saturate(0.6)`: desaturates so a saturated tile behind the panel reads as grey, not a colour bleed.

Applied to `.composer` (incl. the mobile fixed-bottom variant), `.collapsedBar`, the desktop picker `.popover` and the Prompt Library `.helpPopover`, each behind `@supports (backdrop-filter | -webkit-backdrop-filter)` with an opaque fallback and opaque again under `@media (prefers-reduced-transparency: reduce)`.

**Prompt Picker "Advanced" disclosure (project-side extension)**

When a template is selected, the per-variable pin controls (axis rows) are collapsed by default behind an `Advanced, N variables` disclosure (`button[aria-expanded]` + rotating caret, matching the chip idiom). The default-visible surface is the resolved-prompt preview, the seed instrument strip, and the commit bar; the disclosure re-collapses on template change and is omitted entirely for templates with no variables. Warnings stay visible regardless of disclosure state.

The disclosure keeps its panel mounted and animates an intrinsic grid track in both directions over `--dur-sheet`, with an opacity change over `--dur-overlay`. Closing content is inert and aria-hidden. Reversal continues from the current height; reduced motion switches height immediately and keeps the short opacity change.

**Prompt Picker refine footer — instrument strip over commit bar (project-side extension)**

The footer carries two jobs and renders them in two vocabularies, because rendering both as the same pill made six controls read as interchangeable:

- **Instrument strip** — acts on the roll. A `Meta` readout of sans tabular numerals (`Seed 3096472877`, `Locked`, `3 stashed`, so the digits don't jitter across a re-roll, ellipsizing rather than wrapping) sits left; a lock toggle and a dice re-roll sit right as `buttons.icon`, `nowrap` at fixed positions so the re-roll target never moves when the readout's width changes. The lock's pressed state is a filled shackle plus an `--ink` border — hover cannot repaint either, which matters because the icons carry no text label. The dice tumbles once per press via a keyed one-shot animation and returns to rest.
- **Commit bar** — disposes of the sheet. `Stash & roll` (plus glyph) (left, hidden while a sweep is armed, since sweeping *is* stashing at axis granularity), then `Simulate` and the `Use prompt` primary. On phone the primary takes `flex: 1`, so it is always the widest target in the footer.

There is **no `Cancel`**: the header `×`, Escape, and a backdrop tap already dismiss, and a fourth exit spent 76px of the thumb zone. The whole footer is 125px on a 375pt-wide phone, down from a three-row 177px that orphaned `Stash & roll` on its own line. Locked by `web/e2e/phone-picker.spec.ts`.

**Additional main-`:root` tokens (project-side extension)**

Same byte-parity contract as the glass tokens: these live in both `tokens.css :root` and the prototype `:root`; dark overrides go in the exempt dark block.

- `--z-composer: 5` / `--z-overlay-max: 1000`. Full z-scale: `--z-composer` 5, `--z-popover` 50, chip menu `calc(--z-popover + 10)`, `--z-lightbox` 100, `--z-toast` 200, `--z-confirm` 250, `--z-overlay-max` 1000.
- `--shadow-2-up`: shadow-2 mirrored upward for the mobile fixed-bottom Composer edge.
- `--good-on-ink`: green for the Toast check glyph on the `--ink` surface.
- `--line-control`: resting boundary for interactive controls (`buttons.secondary`, `buttons.icon`, the prototype's `.btn-mini` / `.chip`). `--line` / `--line-2` are decorative dividers and exempt from WCAG 1.4.11; a control's own boundary is not.
- `--scrim*`: ink-tinted overlays, `rgba(27,29,32,x)` at alphas 0.4, 0.32, 0.55, 0.6, 0.7, 0.85 and 0.06 (scan).
- `--plate-mark`, `--etch-ink`: the plate frame and the art-mask tint (see the dark table).
- Motion: `--dur-*`, `--ease-*` and `--m-*` (see Easing).
- `--serif`: display face for four moments only: StateView heading, ManagedViewHeader title, dialog title, PromptPicker header ("Templates", the selected template's name in the refine phase, "Brainstorm"; the refine and Brainstorm titles carry a back icon button beside them, never a line under them).

**Typography**

One superfamily, self-hosted variable WOFF2 (see Assets):

- Sans (UI, labels, meta, numerals): `'Atelier Sans', -apple-system, 'Helvetica Neue', Arial, sans-serif`
- Serif (four display moments): `'Atelier Serif', 'Iowan Old Style', Georgia, 'Times New Roman', serif`, optical size pinned at 20
- Mono (kbd, template tokens, resolved-prompt body): `'Atelier Code', ui-monospace, SFMono-Regular, Menlo, monospace`

Ramp (`--text-*`, every `font-size` uses one; `web/test/typeScale.test.ts`): `2xs` 0.6875rem, `xs` 0.75, `sm` 0.8125, `md` 0.9375 (body), `base` 1 (phone inputs), `lg` 1.125 (dialog title, picker header), `xl` 1.375 (managed-view title), `display` 2 (StateView heading).

Labels are sans `--text-xs` 500 in real small caps (`font-variant-caps: all-small-caps`, `letter-spacing: 0.04em`, `--ink-3`) from sentence-case text, never tracked uppercase. No subtitles: a title or heading stands alone, with no small-caps or muted fragment, identifier, count or instruction under or beside it; field labels, dialog and empty-state body copy and one-sentence panel notes are not subtitles. Meta is a list (`<Meta items>`, `web/src/components/Meta`), not a `·`-joined string. Shared primitives: `web/src/styles/type.module.css` (`.label`, `.meta`, `.numeral`, `.kbd`).

**Radius** (by hierarchy)

- `--radius-control` 3px: buttons, chips, kbd, inputs, menu rows, icon buttons
- `--radius-tile` 5px: image tiles, sidebar thumbnails, archive frames
- `--radius-panel` 8px: composer card, dialog card, popover panel, toast
- `--radius-sheet` 12px: phone sheet top corners only

Pick by the element's role, not by size: content panels (Text models providers, Prompt Library settings and AI result cards) take `--radius-panel`; wells and rows inside them take `--radius-control`. No other radius tokens exist.

**Shadow** (contact shadows, ink-tinted in light; black in dark)

- 1: `0 0 0 1px rgba(27,29,32,0.05), 0 1px 1px rgba(27,29,32,0.08)` (sheet at rest)
- 2: `0 1px 2px rgba(27,29,32,0.10), 0 10px 24px -14px rgba(27,29,32,0.28)` (lifted: hover, popover)
- 3: `0 1px 2px rgba(27,29,32,0.12), 0 24px 48px -24px rgba(27,29,32,0.40)` (floating: composer, dialog)
- 2-up: `0 -1px 2px rgba(27,29,32,0.10), 0 -10px 24px -14px rgba(27,29,32,0.28)` (mobile fixed-bottom composer edge)

**Spacing**: Generally 4 / 6 / 8 / 10 / 14 / 18 / 24 / 36 px. Canvas padding 28×36×180. Sidebar 18px sides. Composer 14px sides.

**Easing**

- Curves: `--ease-out` `cubic-bezier(.2,.8,.2,1)` (enter, colour), `--ease-exit` `cubic-bezier(.4,0,1,1)` (exits accelerate away), `--ease-tactile` `cubic-bezier(.2,.8,.2,1)` (monotonic small-control transforms and toast landing, without overshoot), `--ease-view` `cubic-bezier(.22,1,.36,1)` (view transitions).
- Durations: `--dur-hover` 120ms, `--dur-overlay` 160ms (popover enter, every overlay exit), `--dur-transform` 200ms, `--dur-view` 220ms, `--dur-sheet` 240ms, `--dur-dialog` 240ms, `--dur-settle` 280ms, `--dur-entrance` 380ms (tile entrance, once), `--dur-rise` 420ms, `--dur-reveal` 500ms, `--dur-reduced` 80ms (every animation under reduced motion).
- Amplitudes: `--m-shift` 6px, `--m-scale` 0.97, `--m-blur` 6px; press scales `--m-press` 0.98, `--m-press-icon` 0.94, `--m-press-row` 0.985.
- Loop cadences: `--cadence-loop` 1600ms (plate wipe, sweeps, pulses, scans), `--cadence-loop-fast` 700ms (spinners, the finishing sheen). Every `infinite` animation reads one of them; two loops that run together and must not phase-lock use `calc(var(--cadence-loop) * 1.25)`, a slower scan `* 1.5`. They sit outside `--dur-*` because reduced motion does not shorten a loop: its owner stops it or swaps it to `atelier-pulse`.

## Motion

One system, read from tokens (see Easing). Shared keyframes live in `web/src/styles/motion.css` and take their amplitude from `--m-shift`, `--m-scale` and `--m-blur`, never from literals. Exits accelerate away on `--ease-exit`; `useExitTransition` stamps `data-closing` and unmounts after `--dur-overlay` (read by `web/src/lib/overlayDuration.ts`), because the CSS `overlay` transition is Chromium-only.

Overlay surfaces share native CSS transitions and `@starting-style` in `styles/surface.module.css`, so closing during entry and reopening during exit continue from the current pose. An owner tunes its surface only by declaring `--surface-from`, `--surface-to` or `--surface-duration` on the element itself; the shared file declares its defaults and its resting pose (`opacity: 1; transform: none`) at zero specificity and registers the three as non-inherited, so an override, or an owner's own resting opacity or transform, holds whatever order the composed stylesheets load in. The batch prompt card is an overlay too: it composes `fade` and fades out through `useExitTransition` on every close. The sidebar animates its grid allocation alongside its transform. Composer keeps both forms mounted in an intrinsic grid reveal; the hidden form is inert and aria-hidden. Image tiles keep their mat until native load/decode readiness, and cached remounts skip developing. Historical Archive cards have no mount entrance. The Lightbox reserves its fitted batch-ratio frame before media arrives and contains differing image ratios inside that frame. Toast keeps one portal mount across modal hosts, using native `moveBefore` when available and retaining CSS animation progress and focus across the fallback move.

| Surface | Enter | Exit | Owner |
|---|---|---|---|
| Popover (OverflowMenu, MovePopover, AxisDropdown, ChipSelect, TextModelNote) | opacity and `translateY(var(--m-shift))` → 0, `--dur-overlay` `--ease-out` | fades, settling 2px, `--dur-overlay` `--ease-exit` | `styles/menuShell.module.css` |
| Sheet (phone form of an overlay; the phone chip menu; the phone drawer) | `translateY(100%)` → 0 (the drawer `translateX(-100%)` → 0), `--dur-sheet` `--ease-out`; backdrop fade on the same beat | slides back out, `--dur-overlay` `--ease-exit`; the backdrop fades on the same beat | `styles/sheet.module.css`; drawer `components/Sidebar` with the scrim in `App` |
| Dialog (`DialogShell`) | card `scale(var(--m-scale))` and opacity → 1, `--dur-dialog` `--ease-out`; scrim fade `--dur-overlay` | card scales to 0.985 and fades, `--dur-overlay` `--ease-exit` | `styles/dialog.module.css` |
| Viewer (Lightbox) | backdrop fade `--dur-sheet`; frame `scale(var(--m-scale))` → 1, `--dur-entrance` | frame fades and scales to `var(--m-scale)`, `--dur-overlay` `--ease-exit` | `components/Lightbox` |
| Toast | rises `var(--m-shift)`, `--dur-settle` `--ease-tactile` | fades 2px down, `--dur-overlay` `--ease-exit`, after its timer or a user action (Undo calls the store's `dismissToast`, which clears the live timer and unmounts once; `removeToast` is instant programmatic teardown). An actionable toast's timer holds while it is hovered, focused or covered by the phone drawer, and resumes once every reason is released | `components/Toast`, toast slice in `store/atelier.ts` |
| Tile | once per batch: opacity and `translateY(var(--m-shift))`, `--dur-entrance` | | `components/tile/shell.module.css` |
| Image develop | fresh, unseen image: decoded pixels fade in from `grayscale(1) blur(var(--m-blur))`, `--dur-reveal`; cached and historical images use readiness without developing | | `components/tile/ImageTile` |
| State view | plate, heading and body fade in together, `--dur-overlay` | | `components/StateView` |
| Composer navigation | opacity only, `--dur-overlay` `--ease-out` | opacity only, `--dur-overlay` `--ease-exit` | independent React `<ViewTransition>` in `App.tsx` |
| Tile exit (feed and Archive) | | the leaving tile's snapshot runs `atelier-shrink-out`, `--dur-overlay` `--ease-exit`; an Undo-restored tile in a seen batch (or a tile a failed Archive action brings back) fades in on `atelier-tile-in`, `--dur-overlay` `--ease-out` | React `<ViewTransition>` in `components/Batch`, `components/Archive`; classes in `styles/motion.css` |
| Grid reflow | survivors and tiles moving to another virtual row interpolate position and size over `--dur-view` `--ease-view`; the picture is the live element, so a tile completing in the same commit shows its own entrance | | `.tile-move` group in `styles/motion.css` |
| Batch removal | the rows below move up over `--dur-view` `--ease-view`, also when a tile removal only shrinks the batch (rows sit in flow inside one translated window, so they move in the same commit) | the removed batch row shrinks out like a tile | React `<ViewTransition>` per row in `components/Canvas` |
| Conditional part (banner, chip, badge, strip, phase body, state, card, report section) | the part's new snapshot runs `atelier-drop-in`, `--dur-overlay` `--ease-out` | the old snapshot runs `atelier-drop-out`, `--dur-overlay` `--ease-exit`; the live element behind it is already final and takes input | unnamed React `<ViewTransition>` per part, classes `.part-enter` / `.part-exit` in `styles/motion.css` |
| Composer footprint | the frame's group interpolates size and position over `--dur-sheet` `--ease-out`, both pictures hung from its bottom edge and clipped to it; the image and video bodies cross-fade on the same beat | the same, reversed | `update="composer-frame"` in `App.tsx`, `update="composer-body"` in `components/Composer` |
| Disclosure (height-auto reveal) | grid track `0fr` → `1fr` over `--dur-sheet` `--ease-out`, opacity over `--dur-overlay`; reduced motion keeps the fade only; text that switches while open gets one disclosure per text, so the old closes as the new opens | the same transition reversed; the closed panel stays mounted, inert and `aria-hidden` | `components/Disclosure`, `styles/disclosure.module.css` |

Press: `scale(var(--m-press))` (0.98) on buttons, `--m-press-icon` (0.94) on icon actions, `--m-press-row` (0.985) on role-button rows, over `--dur-transform` `--ease-tactile`. Every control's transform channel is declared at rest, never only under `:active`, so the release eases back as well as the press. Hover changes colour and border over `--dur-hover`; buttons do not lift. Disabled: hover rules skip `:disabled`, and one shared rule in `styles/buttons.module.css` gives every disabled (or `aria-busy`) icon, star and tile action `opacity: 0.4` and the `not-allowed` cursor, with no hover change and no press.

**View transitions.** The view stage in `web/src/App.tsx` is one keyed React `<ViewTransition>` (`default="none"`, `exit="view-exit"`). Its enter class comes from `viewNavDirection()` in `web/src/lib/viewNav.ts`: Canvas into Archive, Prompt Library or Text models is `deeper` (fades in from `translateX(var(--m-shift))`), a managed view back to Canvas is `back` (from the opposite side), everything else is `lateral` (opacity only); the old view fades out in place. All run over `--dur-view` `--ease-view`. Composer has an independent boundary that fades its fixed frame when entering or leaving a managed view and interpolates its footprint when a part enters or leaves or the mode body swaps (Composer footprint above); draft edits, expansion and feed-scope changes leave that boundary live. Conditional parts are unnamed `part-enter` / `part-exit` boundaries fed by their surface's deferred snapshot (Conditional part above). The toast stack anchors to the live frame, so it re-anchors at the final geometry. Canvas batch rows, feed tiles and Archive tiles each have a boundary too (`tile-move` / `tile-exit` / `tile-enter`, see Tile exit, Grid reflow and Batch removal above), fed by one deferred snapshot per surface; those and the conditional parts are the only other captures. Feed boundaries are unnamed, so a batch shown in two scopes travels with the stage on a view swap; Archive tiles are named `tile-<id>` and shared, so a tile that changes virtual row moves as one group. React waits for a running view transition and batches the Transitions committed meanwhile into the next one (a burst of removals plays as one step after the first). `:root { view-transition-name: none; }` keeps the sidebar, toasts and top-layer overlays out of every capture (only their listed parts are captured, and only while they enter or leave), and `::view-transition { pointer-events: none; }` keeps input live during the swap. Feed entrances do not replay (`seenBatches`), and placeholder rows from the previous scope are replaced by a keyed remount of the row list, not by row exits and entrances.

**Reduced motion.** One rule set at the end of `motion.css`: under `prefers-reduced-motion: reduce` every `--m-*` amplitude collapses (`0px` or `1`), every `--dur-*` becomes `--dur-reduced` (80ms; `--dur-transform` 0ms), every `--ease-*` becomes `linear`, the `::view-transition-old/new(*)` pseudos shorten to match, and `::view-transition-group(*)` takes `animation: none` so no captured geometry interpolates (React does not honour reduced motion itself). The `--cadence-*` loop tokens are deliberately left alone. Each animation above becomes a short linear opacity change and presses hold still, with no per-surface rule. Owners handle only what a token cannot reach: sheets swap the slide for a fade, and looping loaders (the plate wipe, spinners) swap to `atelier-pulse` or stop.

## Assets

No external image, icon, or font assets beyond:
- **Atelier Sans** (roman + italic), **Atelier Serif** (roman) and **Atelier Code** (roman): subset variable WOFF2 builds of Adobe's Source Sans 3, Source Serif 4 and Source Code Pro (OFL 1.1), renamed because the OFL reserves "Source" for modified versions. Files in `web/public/fonts/`, declared in `tokens.css` with `font-display: swap`; only the sans roman is preloaded. Release tags, build script and license text: `web/public/fonts/LICENSE-fonts.txt`. No font CDN (the CSP allows `font-src 'self'` only).
- **Inline SVG icons** drawn in `app.js` under the `I` object. They are 14×14, 2px stroke, `currentColor`, lucide-style. List: arrow, close, download, trash, archive (box-with-slot — used for main-feed soft-delete actions), copy, reroll (refresh), alert (triangle), check, expand (corners), cloud, chip. The trash icon is reserved for the Archive view's "Delete permanently" action; everywhere else (tile overlay, batch header, sidebar Archive-all, lightbox-in-history) uses the archive icon. **Replace these with whatever icon library your codebase already uses** — lucide-react, heroicons, your design system's Icon component, etc. Match the 14×14 / 2px-stroke visual weight.

### The plate and etched art

Every empty, error and crash surface shows an etched still life in a plate; nothing else carries art (not the Lightbox, toasts, tooltips, loaders, failed tiles or the moderation notice).

- **Medium**: copperplate-style line art of studio instruments, black line on transparent, no figures, no lettering, no frame. Each asset is a lossy WebP alpha mask at 2x its largest display width in `web/src/assets/etch/`, imported through Vite so the hash busts the cache.
- **Owner**: `web/src/components/Etching` is the only component that sets an artwork mask: `<Etching id>` maps an `EtchingId` to its URL, aspect ratio and desktop/phone widths. The element is `aria-hidden`, filled with `var(--etch-ink)` and masked by the asset (`mask: url(…) center / contain no-repeat`, `mask-mode: alpha`), so one file serves both themes; under `forced-colors` the fill is `CanvasText`.
- **Plate**: `StateView`'s `art` prop puts the etching in `.plate` (`var(--bg-sunk)`, `box-shadow: var(--plate-mark)`, `--radius-tile`, 24px padding, 16px on phone, 8px in the short actionable row). `restPlate` is the empty plate at rest for loading states and `LazyFallback`.

| id | Surface | Width desktop / phone |
|---|---|---|
| `empty-canvas` | Canvas first run and empty collection | 360 / 240 |
| `empty-search` | Canvas search with no matches | 200 / 160 |
| `empty-archive` | Archive empty | 320 / 220 |
| `empty-templates` | Prompt Library, no templates | 320 / 220 |
| `empty-lists` | Prompt Library, no variable lists | 320 / 220 |
| `empty-dimensions` | Prompt Library, no dimensions | 320 / 220 |
| `empty-picker` | Prompt Picker with no templates | 120 |
| `empty-brainstorm` | Brainstorm, before any ideas | 280 |
| `empty-text-models` | Text models, no providers | 220 / 160 |
| `state-error` | `ErrorState` (history and library errors) | 160 / 120 (48 in the short actionable row) |
| `crash` | ErrorBoundary crash card | 320 / 220 |

### Brand mark

The mark is a capital A engraved in a small plate, the one letterform in the art set. The sidebar shows `web/src/assets/atelier-mark.png` at 22×22. The favicons (`web/public/favicon-16.png`, `web/public/favicon-32.png`) and the iOS icon (`web/public/apple-touch-icon.png`, 180×180) carry the same mark; `web/index.html` links them with a `?v=` cache-busting query.

The placeholder images shown in the prototype are deterministic SVG gradients generated client-side by `generateMockImage()`. Delete that function — production will receive real image URLs from the backend.

## Files

```
design_handoff_atelier/
├── README.md          — this document
└── design/
    ├── index.html     — host page (style tokens, font load, React + Babel)
    └── app.js         — full prototype: components, mock backend, state, styles
```

`app.js` contains everything in one file for prototype convenience. In a production codebase, decompose it into:

- `App.tsx` — top-level state and layout
- `Composer.tsx` — prompt input + chips + Generate button
- `Sidebar.tsx` — history list
- `Batch.tsx` — batch header + grid
- `Tile/ImageTile.tsx`, `Tile/LoadingTile.tsx`, `Tile/FailedTile.tsx`
- `Lightbox.tsx`
- `Toast.tsx`
- `api/models.ts`, `api/generate.ts` — backend clients
- `tokens.css` (or equivalent) — design tokens

The CSS in the `css` template literal at the top of `app.js` is the source of truth for visual styling — port it to your styling system (CSS modules, Tailwind config, styled-components, etc.) preserving every value.

## Things to verify in the real implementation

- **Streaming responses**: the prototype fakes parallel resolution with independent setTimeouts. The real backend should stream per-image results so tiles flip from loading→done individually as soon as each is ready, not in lockstep.
- **Image format**: prototype downloads `.svg`. Real downloads should use the source format (PNG / WebP) and include EXIF or sidecar metadata if the backend provides it.
- **Failure messages**: surface the actual backend error string verbatim. The prototype uses fake messages like "CUDA out of memory on GPU-1" — these are the kind of text the real failure tile should show, but they must come from the backend.
- **Aspect ratios**: the dropdown lists 5 fixed ratios. Confirm with the model registry which ratios each model actually supports — you may want to filter the ratio chip per selected model.
- **Auth**: not in scope of the design but obviously needed in production.
- **Accessibility audit**: keyboard nav exists for major paths but the lightbox should also trap focus; the chips' hidden `<select>` works with screen readers but verify against your team's a11y baseline.
