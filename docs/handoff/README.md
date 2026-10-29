# Handoff: Atelier — Unified AI Image Generation Frontend

## Overview

**Atelier** is a minimalist single-pane web interface for generating images via AI models. The defining product idea is **backend agnosticism**: the user picks a model from a unified list and writes a prompt — they don't need to know or care whether that model runs on a local GPU or a remote cloud API. The frontend is a single point of entry; the backend routes to the appropriate provider transparently.

Core flow: user types a prompt → picks a model + aspect ratio + count → presses Generate → animated placeholder tiles appear → tiles resolve to images (or to a dismissable failure state) → user can click any image to expand fullscreen, download, or delete.

## About the Design Files

The `design/` folder contains an HTML/JSX prototype (`index.html` + `app.js`) created as a **design reference**. It is not production code — the image-generation backend is mocked (it returns deterministic SVG placeholders after a simulated delay, with a 6% random failure rate to exercise the failure state). The prototype demonstrates intended visual design, layout, animation, and interaction patterns.

**Your task is to recreate this design in the target codebase's existing environment** (React + your styling solution, Vue, SvelteKit, etc.), wiring it to the real image-generation backends. If no frontend environment exists yet, React + Vite + a CSS-in-JS or CSS-modules approach is a reasonable default — the design is light enough that any modern component framework works.

## Fidelity

**High-fidelity.** Final colors, typography, spacing, and motion are all in the prototype. Reproduce it pixel-faithfully. The animations (scanning loading state, tile entrance, lightbox expand, hover overlays, toast) are part of the design, not decoration — keep them.

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

- **Sidebar** (left, fixed 240px): app mark + version, generation history list, clear-all action, footer status pill.
- **Canvas** (main): vertically stacked **batches**. Each batch is one prompt+model+settings+timestamp + a grid of **tiles**.
- **Composer** (floating, anchored bottom-center, max-width 920px, 24px from bottom): prompt textarea + model/ratio/count chips + Generate button.

When the canvas is empty, the canvas region shows a centered empty state with a dashed-circle glyph and a hint about ⌘+Enter.

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

**Header (`.sb-h`)** — 18px top padding, 14px bottom, 18px sides; flex row with gap 10; bottom border `1px solid var(--line)`.
- **Logo mark** (`.sb-mark`): 22×22px solid `var(--ink)` square. Inset 4px `::after` pseudo in `var(--bg-elev)` clipped to `polygon(0 0, 100% 0, 100% 60%, 60% 100%, 0 100%)` — gives a notched-corner glyph.
- **Title** "Atelier": 14px, weight 500, letter-spacing -0.01em.
- **Version** (prototype showed "v0.4"; the shipped Sidebar renders `v1.0`): JetBrains Mono 10px, uppercase, letter-spacing 0.08em, color `var(--ink-3)`, margin-left auto.

**Section header (`.sb-section`)**: padding 14px 18px 8px, JetBrains Mono 10px, uppercase, letter-spacing 0.1em, color `var(--ink-3)`. Right side hosts an "Archive all" archive icon (only shown when batches exist) — clearing history archives every live item rather than hard-deleting it.

**History list (`.sb-list`)**: flex 1, vertically scrollable, 8px horizontal padding, 80px bottom padding. Empty state: `.sb-empty` 12px copy in `var(--ink-3)` reading "Nothing here yet. Your generations will appear here."

**History item (`.hist-item`)**: 10px padding, 6px radius, grid `32px 1fr` with 10px gap, 1px transparent border. Hover: `background: var(--bg-sunk)`. Active (currently-viewed batch): same bg + `border-color: var(--line-2)`.
- **Thumbnail** (`.hist-thumb`): 32×32, 4px radius, overflow hidden. Shows the first ready image of the batch, `object-fit: cover`. If no image ready, shows a 45° striped pattern: `repeating-linear-gradient(45deg, var(--bg-sunk) 0 4px, var(--line) 4px 5px)`.
- **Prompt text**: 12px, `-webkit-line-clamp: 2`, line-height 1.35.
- **Meta line**: JetBrains Mono 9.5px, uppercase, letter-spacing 0.06em, color `var(--ink-3)`. Format: `{count}× · {ratio} · {modelLabel}`.

**Footer (`.sb-footer`)**: top border `1px solid var(--line)`, 10px 14px padding. JetBrains Mono 10px uppercase letter-spacing 0.08em color `var(--ink-3)`. Contains a 6×6 green dot (`var(--good)`) with a 3px outer glow ring at 18% alpha, then text "{N} models · {M} backends".

#### Library rail

A second section above HISTORY. Main, Archive, and Prompt Library all keep the same Library rail *chrome* (position, row geometry, section header, active-bar, keyboard model); full-screen managed views hide the feed list below the rail, but the rail itself remains present. Collapsing, restructuring, or jumping the rail chrome between modes is not an option in v1. The rail *content* adapts to context: in Archive, rows route to archive-scoped views and use archived counts, collection rows with no archived content are hidden (gated like Pinned), and "+ New collection" is omitted — Archive is a terminal 30-day deletion bin, not a place to organize live work.

**LIBRARY section header (`.sb-section`)** — same JetBrains Mono 10px uppercase / letter-spacing 0.1em / `var(--ink-3)` treatment as HISTORY. Right side hosts the **search icon-toggle** (lucide `search`, 14×14, 2px stroke). Click expands an inline search input below the section header on desktop; mobile shows a full-width search row that is always expanded.

**Library row (`.lib-row`)**: 36px tall on desktop, 44px on mobile (HIG/MD touch target). 10px horizontal padding, 6px radius, 1px transparent border. Layout: leading 14×14 folder glyph in `var(--ink-3)`, name, trailing count pill (JetBrains Mono 10px uppercase, `var(--ink-3)`).
- **Hover**: `background: var(--bg-sunk)`, no accent.
- **Active**: 2px left accent bar in `var(--ink)` via `::before` pseudo-element (absolutely positioned; **no layout shift** between active and inactive states — Linear/VS Code pattern). `aria-current="page"` + `aria-pressed="true"`.

**Conditional rows** (driven by `LibrarySummary` returned by `GET /api/collections`):

| Row | Shown when |
|---|---|
| `All` | Always |
| `Pinned` | Main: `summary.pinnedCount > 0`; Archive: `summary.archivedPinnedCount > 0` |
| `Unsorted` | Main: visible as the default scope; Archive: visible as the archived-unsorted scope |
| `<name>` | Main: one per user collection, sorted by `sort_order, name`. Archive: only collections with `archivedCount > 0` |
| `+ New collection` | Main only (dashed `var(--line-2)` border); omitted in Archive |

**Inline create + rename + delete** (no modal, no context menu):
- `+ New collection` row: click → swaps in place to `<input>` with visually-hidden `<label>Collection name</label>`. Enter or blur commits; Esc cancels.
- Double-click on a collection row name → swaps to inline rename input (same pattern). Enter/blur commits; Esc cancels.
- Hover on a collection row reveals a right-side `╳` (lucide `x`). Click → `ConfirmDialog` ("Delete collection? Batches will return to Unsorted.") → idempotent DELETE; batches' `collection_id` is set NULL by FK cascade.

**Per-scope HISTORY label** (the existing HISTORY section title changes per active scope):

| view | Section label | Empty-state copy |
|---|---|---|
| `history` | `RECENT` | "Nothing here yet. Your generations will appear here." |
| `pinned` | `PINNED` | "No pinned batches yet. Click the star on any generation to pin it." |
| `unsorted` | `UNSORTED` | "Everything is in a collection. Nice!" |
| `collection: <name>` | `IN <NAME>` | "No generations in `<Name>` yet. Move batches here from the Move menu." |
| any + `q !== ''` and no matches | (unchanged) | `"No prompts match \"<q>\"."` |

When `useCollections()` returns `items: []`, the rail renders only `All` + `+ New collection` plus a one-line microcopy in `var(--ink-3)`, JetBrains Mono 11px: *"Group related batches into collections."*

**Pin star on history items**: A 14×14 lucide `star` button in the top-right of each history item card. Hover-revealed when unpinned (opacity 0 default; 1 on item-card hover or star focus); always visible when pinned (filled via `data-pinned="true"` → CSS `fill: currentColor`). Click stops propagation and toggles `pinned` server-side.

**Keyboard**: roving tabindex within the rail. Tab enters at the active row; ↑/↓ navigates within the rail (wraps); Home/End jumps to first/last; Enter activates. Inline-input states (rename, create, search) pause the model and restore focus to the triggering row on commit/cancel.

**Live region**: a single rail-level `aria-live="polite"` region announces count changes (e.g. "Logo concepts, 13 batches"), debounced 300ms so rapid changes don't spam screen readers.

**Mobile (≤767px)**: rail rows expand to 44px min height; search is always-expanded as a full-width row with 16px font (avoids iOS auto-zoom). The drawer header gains a `Cancel` text button in non-idle inline-input states (creating / renaming / searching) — clears the active state and returns to idle.

### Canvas

**Container (`.canvas`)**: vertical scroll, padding `28px 36px 180px` (the bottom 180 reserves space under the floating composer).

**Empty state (`.canvas-empty`)**: full-height flex column, centered.
- **Glyph**: 64×64 dashed-border circle (`var(--line-2)`), inner SVG icon (image-with-mountain glyph at 22×22). An `::before` pseudo at `inset: -8px` is a second dashed circle that pulse-animates `scale(1) 0.6 opacity → scale(1.08) 0.2 opacity` over 3s ease-in-out infinite alternate.
- **Heading** "What would you like to make?": 22px, weight 400, letter-spacing -0.015em, color `var(--ink)`.
- **Body**: 13px, line-height 1.55, max-width 420px, color `var(--ink-3)`. Includes inline `<kbd>` chips for ⌘ and ↵ — 11px JetBrains Mono, `var(--bg-elev)` background, `1px solid var(--line)` border with bottom border doubled (`border-bottom-width: 2px`), 4px radius.

### Batch

**Container (`.batch`)**: 36px top margin between batches.

**Header (`.batch-h`)**: flex row, baseline-aligned, 14px gap, 14px bottom margin, 12px bottom padding, bottom border `1px solid var(--line)`.
- **Prompt**: 15px, letter-spacing -0.005em, flex 1, single-line ellipsis truncation, color `var(--ink)`. Full prompt in `title` attribute.
- **Meta cluster**: JetBrains Mono 10.5px, uppercase, letter-spacing 0.06em, color `var(--ink-3)`, gap 14px. Three pieces: model name (in `var(--ink-2)` weight 500), ratio, and relative time ("just now", "5m ago", "2h ago", or locale date). When `batch.collectionId` is set, a fourth token follows: `<I.folder> <COLLECTION_NAME>` (text-only mono, no chip border, matches the existing token weight). Clicking the token opens the Move popover anchored at the Move icon. The relative-time token (`.metaTime`) is suppressed below 767px to prevent meta-cluster wrap on phones.
- **Pin star**: 14×14 lucide `star` between the meta cluster and the action cluster. Hover-revealed when unpinned (opacity 0 default; 1 on `.batch-h:hover` or star `:focus`); always visible when pinned (filled via `data-pinned="true"`). Click toggles `pinned` server-side. `aria-label={pinned ? 'Unpin batch' : 'Pin batch'}` + `aria-pressed` + `data-tip`. Stops propagation so the parent click doesn't fire.
- **Action cluster**: four 28×28 icon buttons (copy prompt, re-roll, **move**, archive batch) — `.icon-btn` style: transparent border, 4px radius, color `var(--ink-3)`. Hover: `var(--bg-sunk)` bg, `var(--ink)` color, `var(--line)` border. The archive button uses the archive (box-with-slot) icon, not a trash icon — main-feed removals are soft deletes that move tiles to the Archive view for 30 days before permanent deletion. The **move** button uses the lucide `folder-plus` glyph; when `batch.collectionId` is non-null the glyph is filled (`fill: currentColor` via `data-in-collection="true"`), otherwise outlined. `aria-label` is dynamic ("Move to `<name>`" or "Move to collection") and `data-tip="Move"`.

**Grid (`.grid`)**: CSS grid `repeat(auto-fill, minmax(260px, 1fr))`, 14px gap.

### Move popover

Anchored to the batch-header Move icon. Opens on Move-icon click OR collection-meta-token click (both use the same anchor ref for predictable positioning).

**Desktop (≥768px)** — popover layer:
- 220px wide, 6px radius, `var(--bg-elev)` background, `1px solid var(--line)`, shadow-2 (the tile-hover token).
- Inline `position: absolute` with viewport-aware flip logic — opens below the trigger by default; flips above if there isn't enough vertical room.
- `--z-popover: 50` (between canvas content and the lightbox layer at 100).

**Mobile (≤767px)** — bottom sheet:
- Full-width, 14px top radius, max-height 60vh, slides up on open (240ms `cubic-bezier(.2,.8,.2,1)`).
- Backdrop: `rgba(20,19,15,0.4)` + `backdrop-filter: blur(8px)`; tap dismisses. Esc also dismisses.
- Swipe-down dismiss is deferred to a future phase.

**Every bottom sheet obeys two rules** (they read as details and behave as bugs when missed — the Move popover, the Prompt Picker and its axis sheet, the batch overflow menu, the Prompt Library help panel, the chip menus and the shared dialog sheet all follow them):

- **The backdrop dismisses on a completed tap, never on `pointerdown`.** A tap fires `pointerdown` first; dismissing there unmounts the backdrop mid-tap and the click lands on whatever is underneath — WebKit dispatches it on the element now under the finger, so the tap bleeds into the layer below (closing a parent sheet, collapsing the composer, opening a tile). Wherever a sheet renders a backdrop, `useOutsidePointer` is disabled and the backdrop's own click is the dismissal path.
- **The sheet's bottom padding carries `env(safe-area-inset-bottom)`.** `viewport-fit=cover` lets a flush-bottom sheet run under the home indicator, putting its last action row in the OS gesture strip.

**Markup**:
- `role="dialog"`, `aria-label="Move to collection"`.
- Header label "Move to collection" (uses `letter-spacing: 0.08em`, matching the canonical `app.js .move-popover-h` — tighter than the LIBRARY header's 0.1em).
- `<ul role="list">` of rows. **`(Unsorted)` is ALWAYS the first list item.** Each row is a `<button>` with the same geometry as Library rail rows. ✓ (lucide `check`) marks the row matching `batch.collectionId` — including the `null` / Unsorted case.
- Divider, then a `+ New collection` row.

**Behaviour**:
- Click a collection row → `useMoveBatch` with that id → popover closes; the optimistic cache update flips ✓ to the new row before the server response.
- Click `(Unsorted)` row → `useMoveBatch` with `collectionId: null` → popover closes.
- Double-click on a collection row name → swap to inline rename input within the popover (sr-only `<label>`, Enter commits, Esc cancels). The focus trap continues to apply; focus returns to the row button on commit/cancel.
- `+ New collection`: click → inline input below; Enter commits via `useCreateCollection` AND immediately follows with `useMoveBatch({ batchId, collectionId: newId })` so the batch lands in the freshly-created collection; popover closes. Esc cancels.

**Focus + dismiss**:
- Focus trap reuses the Lightbox recipe (no library). Tab cycles within the popover; Shift+Tab cycles backward.
- Esc closes; click-outside closes; focus returns to the Move icon on close (captured at open time).
- Reduced motion: 80ms opacity fade only (matches `[data-tip]`).

### Tile (Image)

**Container (`.tile`)**: `var(--bg-elev)` bg, `1px solid var(--line)`, 10px radius, overflow hidden, `cursor: zoom-in`.
- **Entrance animation**: `tile-in` 380ms `cubic-bezier(.2,.8,.2,1)` — opacity 0→1, translateY 8px→0, scale 0.98→1.
- **Hover**: `border-color: var(--line-2)`, `transform: translateY(-2px)`, shadow 2.

**Frame (`.tile-frame`)**: aspect-ratio set to `{w} / {h}` from the ratio definition (e.g. `1024/1024` for 1:1). Background `var(--bg-sunk)`.

**Image**: object-fit cover, `img-in` entrance — 500ms, opacity 0→1, blur 12px→0, scale 1.04→1, same easing.

**Fresh-completion reveal (`.reveal`)**: on the SSE-driven loading→done transition, ImageTile mounts with a sibling overlay (absolute fill, `pointer-events: none`, `background-color: var(--bg-sunk)`) that fades opacity 0.8 → 0 over `500ms cubic-bezier(.2,.8,.2,1)` (the `--dur-reveal` token) with `both` fill mode. This is the same cream the LoadingTile veil holds at 0.8, so the handoff is continuous — the veil changes ownership and dissolves. Drift/scan motion does **not** carry through; once the image is final, the developing vocabulary stops and stillness is the payoff. **Gated by `completedAt` freshness** (`Date.now() - tile.completedAt < 2000` at mount): history pagination and initial page loads remount with stale `completedAt` and skip the overlay entirely, otherwise every historical tile would flash cream on first paint.

**Hover overlay (`.tile-overlay`)**: absolute fill, gradient `linear-gradient(180deg, transparent 60%, rgba(20,19,15,0.55) 100%)`, opacity 0 → 1 on hover (160ms).
- **Bottom row**: index label (e.g. "01 · 1:1") on left in white 85% mono 10px; on right, three 26×26 action buttons (`.tile-btn`) — `rgba(20,19,15,0.6)` bg, `backdrop-filter: blur(8px)`, white 90% icon. Hover deepens bg to 0.85. Icons: download, archive, expand. (The archive icon — box-with-slot — replaces the conventional trash because main-feed removals soft-delete to the Archive view; reserve the trash icon for the Archive view's "Delete permanently" action.)

### Tile (Loading)

Replaces the image while `status === 'loading'`. Aspect ratio matches the requested ratio.

**Layered animation** inside `.tile-frame`:
1. **Base layer** (`.loading::before`): three radial gradients in warm amber, cool blue, soft magenta (each at distinct positions), blurred 20px, animated `drift` 6s ease-in-out infinite alternate (scale 1→1.15, translate 0,0 → -4%,4%).
2. **Scan band** (`.loading::after`): vertical gradient with a soft dark band at 50%, animated `scan` 2.4s linear infinite (translateY -100% → 100%).
3. **Noise** (`.loading-noise`): inline-SVG turbulence pattern, opacity 0.25, mix-blend multiply, jittered with `shift` 0.6s steps(4) infinite (4 micro-displacements for film-grain feel).
4. **Status line** (`.loading-text`): bottom-left, JetBrains Mono 10.5px uppercase. Format: `[60×1px progress bar with sweeping fill] {modelName} · {elapsed}s`. Update elapsed via `setInterval(1s)` — whole-second granularity (sub-second updates churn React state with no UX gain).

**Veiled mode (preview present)** — When the upstream emits partial previews mid-generation (e.g. cliproxy `image_generation.partial_image` SSE frames), the developing image is rendered **behind** the placeholder, not in place of it:

1. **Preview** (`.preview`): absolute fill, `object-fit: cover`, `transform: scale(1.06)` (overscan to hide blur halo), `z-index: 0`. Heavy initial blur sharpens with each new partial — a CSS variable `--pass-blur` keyed off `data-pass="1..5"` maps the upstream `partial_image_index` to `12 → 8 → 4 → 2 px`; index `0` (or absent) uses the default `16px`. Filter transitions over `600ms cubic-bezier(.2,.8,.2,1)` so each new pass reads as "sharpening into focus" rather than a hard repaint. Entrance `preview-in` 320ms ease-out (opacity 0→1).
2. **Veil** (`.loading.veiled`): the placeholder layer drops its opaque `var(--bg-sunk)` fill to transparent and reduces overall opacity to **0.8**, so the developing image is visible through the continuing drift / scan / progress-bar animations. Background-color and opacity transition over `480ms cubic-bezier(.2,.8,.2,1)`.
3. **Status line** stays at full opacity — it's pulled out of the veil's stacking context so the mono `{model} · {elapsed}s` label remains legible over bright partials.
4. **Noise field** is **not rendered** in veiled mode — the developing image takes its place.

The veil persists through the loading→done handoff (see "Fresh-completion reveal" under Tile (Image) above): same cream, same easing, same starting opacity. Visually continuous; nothing flashes or swaps.

### Tile (Failed)

**Body (`.failed-body`)**: absolute fill, 18px padding, `var(--bg-elev)` bg with 45° hatched stripes (`repeating-linear-gradient(45deg, transparent 0 8px, var(--bg-sunk) 8px 9px)`).
- **Icon**: alert-triangle, color `var(--danger)`.
- **Title** "Generation failed": JetBrains Mono 10.5px uppercase, color `var(--danger)`.
- **Message**: 12.5px, `var(--ink-2)`, line-height 1.5. The error string from the backend (or the mock's reason).
- **Actions**: two `.btn-mini` buttons (Retry, Dismiss) — JetBrains Mono 10px uppercase, `1px solid var(--line-2)`, 3px radius, 5px 9px padding. Hover: invert to `var(--ink)` bg, `var(--bg)` text.

**Behavior**: Retry calls generate again with a new random seed (preserves prompt/model/ratio); Dismiss removes that single tile. If all tiles in a batch are dismissed, the batch is removed.

### Video (I2V) — project-side extension

Image-to-video (animate a still into a clip of user-chosen length — 5 / 10 / 15 s) is a post-handoff feature, gated behind `VIDEO_MODELS_ENABLED`. It reuses the existing tile/composer vocabulary rather than introducing new chrome.

**Animate action.** A first-class tile-overlay action (film glyph, alongside Download/Archive/Expand) and a Lightbox bottom-bar action, shown only on image tiles when an I2V model is available. Clicking it shows an on-glass pending spinner while the still is fetched + uploaded as the source, then opens the Composer in video mode (shared `useAnimateFromTile` hook). Reachable on touch (always-visible overlay), not hover-only.

**Composer (video mode).** When the selected model does I2V: the generic prompt textarea and the Library/Enhance controls are hidden, and a `.videoPanel` animates in (opacity + 6px rise, `--dur-sheet`). It holds (1) the **source still as a 64px framed thumbnail** — click to replace, corner `×` to clear, an overlay spinner during a replace that keeps the prior frame until the new one resolves (never an id string), and (2) the **motion prompt** as the single hero textarea. The motion prompt is **required** (Generate stays disabled, statusline reads "Describe the motion to animate", until set). The count chip locks to ×1 and a **Duration** chip (`DurationChip`, 5 / 10 / 15 s off `VIDEO_DURATION_FRAMES`) picks the clip length; Generate is labelled **"Animate"** and the statusline shows the `~12 min` render estimate (a flat display hint, `web/src/lib/i2v.ts`, not scaled by duration). A quiet **"‹ Images"** exit chip (the composer `.chip` vocabulary, `chevronLeft` glyph, `aria-label`/tooltip "Back to image generation") sits in the panel's top-right corner — clicking it restores the last image model the user was on (falling back to the first image model) which is what leaves video mode, so the exit is discoverable without adding new chrome. The bottom-row Model chip remains an equivalent exit.

**Tile (Video).** A done clip renders via `ClipFrame`: `<video muted playsInline loop preload="none">` + a centred glass play badge. On pointer devices it **autoplays muted on hover** (paused + rewound to the poster on leave); on touch it plays while in view (IntersectionObserver, paused off-screen) — the energy-correct pattern, never audio, never off-screen. The badge fades out while playing; a clip-duration chip (`0:05`, top-left glass mono) appears once metadata loads; the overlay index token carries a film glyph so video reads as video at a glance in a mixed grid. `prefers-reduced-motion` keeps a static poster + badge. Entrance: `clip-in` (fade + blur + scale, `--dur-reveal`).

**Loading (Video).** A render runs ~11–13 min, so the loading tile is video-aware: the `{model} · {elapsed}s` line becomes `{model} · m:ss / ~12:00` with tabular figures (a 13-min render must never read "740s"), the determinate progress bar is given more presence (88×2px), and the **uploaded source still is veiled behind the loading layer** (the `.preview` veil vocabulary at a fixed gentle blur, `data-source`) so the user watches the frame being animated. The scan/noise atmosphere stays image-only.

### Video sequences (Extend) — project-side extension

Longer videos are built by extending: a done video tile grows a clip-chain, one segment at a time, and the server keeps a stitched master.

**Extend action.** Sibling of Animate on done video tiles (distinct extend glyph in `I.tsx`), in the tile overlay, the Lightbox bottom bar, and the sequence overflow menu — shown only when the tile is standalone or its sequence's tail and an I2V model exists. Click shows the on-glass pending state (duplicate clicks ignored, abort on unmount, failure → toast) while the server extracts the last frame, then opens the Composer in extend mode (`useExtendFromTile`).

**Composer (extend mode).** Video mode variant: the handoff frame is the source thumbnail, Generate is labelled **"Extend"**, the Ratio chip is locked to the sequence's ratio (disabled with tooltip, never hidden), Duration stays live. Leaving video mode or Clear wipes the extend draft fields (`extendsTileId`, `extendPrevPrompt`). Submit passes `extendContext` to motion enhancement so the rewrite continues the previous clip's motion, identity block, and soundscape.

**Sequence chrome.** Segment batch headers carry a chip — `Part k/n · M:SS` (24 fps total), `Part k/n · stitching…` while the master rebuilds, `master failed` on error. The overflow menu gains a grouped sequence section: Play master (Lightbox viewer plane, native video controls), Download master (both gated on `masterStatus === 'ready'`), Extend (tail only), Discard tail (danger confirm; 409 while a linked render runs → "wait for the render" toast). Master status converges by polling — any visible stitching sequence keeps the adaptive history cadence alive; there is no sequence SSE.

### Composer

**Wrapper (`.composer-wrap`)**: position absolute, bottom 24, horizontally centered (`left: 50%; transform: translateX(-50%)`), `width: calc(100% - 72px)`, `max-width: 920px`, `z-index: 5`.

**Card (`.composer`)**: `var(--bg-elev)` bg, `1px solid var(--line-2)`, 14px radius, shadow-3 (`0 30px 80px -20px rgba(20,19,15,0.35), 0 8px 20px rgba(20,19,15,0.10)`), padding `14px 14px 10px`, flex column gap 10. Focus-within: border darkens to `var(--ink)`.

**Textarea**: borderless, transparent bg, no resize handle, 14.5px Helvetica Neue, line-height 1.5, min-height 48, max-height 180. Auto-grows: on every input, set `height: auto` then `height: min(scrollHeight, 180)`. Placeholder "Describe an image…" in `var(--ink-3)`.

**Chip row (`.composer-row`)**: flex row, 8px gap, wraps.

**Chip (`.chip`)**: `1px solid var(--line)` border, 6px radius, `var(--bg)` bg, padding 6px 10px, JetBrains Mono 10.5px uppercase, letter-spacing 0.06em. Two text spans: `chip-label` (in `var(--ink-3)`, e.g. "MODEL") and `chip-val` (in `var(--ink)`, e.g. "SDXL 1.0"). The chip wraps a hidden absolute-positioned `<select>` (opacity 0, fills the chip) so the native dropdown appears on click. Hover: `var(--bg-sunk)` bg, `var(--line-2)` border, `var(--ink)` text.

Three chips: Model (grouped by `<optgroup>` for Local/Cloud), Ratio (1:1, 4:5, 3:4, 16:9, 9:16), Count (1–4).

**In-flight indicator (`.in-flight`)**: small mono pill rendered to the left of the kbd shortcut while there's at least one tile streaming. JetBrains Mono 10px uppercase, `var(--bg-sunk)` bg, `1px solid var(--line)`, 3px radius, 2×7 padding, format `"N/4 TILES"`. Hidden when count is 0. Swaps to `--danger` color/border with `oklch(94% 0.02 25)` background when `inFlightCount >= cap` — the absolute floor where no further click can succeed regardless of count. The per-click rejection (toast) carries the exact failure reason, so the indicator stays a simple capacity gauge instead of trying to predict which click will fail (re-roll and retry use derived counts, not the Composer's count chip). 200ms colour transition, `cubic-bezier(.2,.8,.2,1)`. The `data-tip` reads "At capacity — wait for some tiles to finish" in the warning state.

**Shortcut hint**: JetBrains Mono 10px uppercase color `var(--ink-3)`, "⌘ ↵" rendered as two `<kbd>` pills.

**Generate button (`.btn-go`)**: `var(--ink)` bg, `var(--bg)` text, 7px radius, padding `8px 14px 8px 16px`, 13px Helvetica Neue. Right-arrow icon translates 2px on hover. Disabled (no prompt, no models, or models error): opacity 0.4. Stays *enabled* while generations are in flight — multi-flight is the rule (see § Concurrency cap). Clicking at cap surfaces a soft toast and does not start a new generation.

**Composer command dock (project-side extension)**

Enhance/Undo are post-launch additions never present in the prototype. The shipped footer is a two-zone command bar, not the prototype's single chip row: a `.controls` zone (Library · Enhance segmented control · Model · Ratio · Count) that may wrap internally, and a fixed-width `.dock` sibling (in-flight pill · Clear · Generate) separated by a hairline `var(--line)` divider. Generate is bottom-anchored inside the dock and is spatially invariant across every state — if the controls wrap, the card grows upward, away from it. The Enhance control is a segmented `[Enhance │ ↺]` whose revert segment is always in the DOM (dimmed until an enhance is undoable), so it can never insert/remove and cause a reflow. The Library chip shows icon + `Library` (no `Templates` label); the Model chip shows a short family token (`GPT` / `Banana` / `Local`) with the full name in the dropdown, batch header, and hover title. Ref/local hints render on one reserved-height `.statusline` below the footer. All other Composer tokens are unchanged from the spec above.

**Submit shortcut**: ⌘+Enter / Ctrl+Enter from anywhere in the textarea.

### Lightbox

**Backdrop (`.lb-backdrop`)**: position fixed, fill viewport, `rgba(20,19,15,0.85)` + `backdrop-filter: blur(12px)`, z-index 100, flex centered, `cursor: zoom-out`. Entrance: 220ms opacity fade.

**Frame (`.lb-frame`)**: relative, `max-width: 90vw`, `max-height: calc(100vh - 120px)`. Entrance: `lb-frame-in` 360ms `cubic-bezier(.2,.8,.2,1)` — scale 0.92→1, opacity 0→1.

**Image**: same max constraints, 6px radius, large dropped shadow `0 40px 100px -20px rgba(0,0,0,0.5)`.

**Close button (`.lb-close`)**: top-right 24,24, 40×40 circle, white-on-dark glass (`rgba(255,255,255,0.08)` + blur 12). Hover rotates 90°.

**Nav buttons (`.lb-nav`)**: vertically centered, 24px from each edge, 44×44 circles, similar glass treatment. Disabled at array bounds.

**Bottom bar (`.lb-bar`)**: position fixed, bottom 28, centered. `rgba(20,19,15,0.7)` + `backdrop-filter: blur(20px)` + `1px solid rgba(255,255,255,0.08)`, 10px radius, 6px padding.
- **Info segment**: 12px horizontal padding, right-bordered with `rgba(255,255,255,0.1)`, 28px tall. JetBrains Mono 10.5px uppercase, color `rgba(255,255,255,0.65)`. Content: `{modelName bold} · {ratio} · {w}×{h} · {01}/{04}`.
- **Buttons**: Download, then a context-sensitive remove button using the `.danger` modifier (hover bg `oklch(50% 0.14 25 / 0.4)`). In the **history** lightbox it renders as **Archive** with the archive icon (soft delete → Archive view); in the **archive** lightbox it renders as **Delete** with the trash icon (permanent removal of an already-archived tile).

**Keyboard**: Esc closes, ←/→ navigates between done tiles only (skips loading and failed).

### Lightbox zoom — project-side extension

The prototype only ever showed the image fitted to the viewport, which downsamples most renders. The shipped viewer adds a second step at **1:1** (one image pixel per CSS pixel), offered only when the natural size beats the fitted size by ≥1.05× — below that there is no button, no cursor change, and no gesture. The image is transformed with `translate3d(x, y, 0) scale(s)` about its own centre, so its layout box never moves and the frame chrome stays put.

- **Enter / exit**: click the image (mouse/pen), double-tap it (touch), or press the bottom-bar toggle. Clicking zooms **around the pointer** — the point under the cursor stays under it; the toggle zooms about the centre. Touch keeps its single tap free for swipe-to-dismiss, which is why it needs a double-tap.
- **Pan**: mouse drag, touch drag, two-finger trackpad scroll, or `←`/`→`/`↑`/`↓` (96px a press). Translation is clamped so the scaled image always covers the viewport; dragging past that gives with iOS-style resistance and snaps back to the bound on release.
- **Continuous zoom**: trackpad pinch / ⌘-scroll (a `ctrlKey` wheel event) between fit and 1:1, anchored on the pointer. Touch pinch zooms and pans at once, overshoots to 0.8×/1.3×, and settles back into range on release. The wheel listener is bound natively, not through React, because React marks its delegated `wheel` handler passive and the browser's own page zoom has to be `preventDefault`ed.
- **Motion**: reuses the swipe snap-back transition (`--dur-transform` / `--ease-out`), suppressed while a pointer is driving the transform. At 1:1 the image drops its 6px radius and photo shadow — both read as mistakes once scaled 3×.
- **Cursors**: `zoom-in` when zoomable, `grab` / `grabbing` while zoomed.
- **Info segment** appends ` · {pct}%` while zoomed, alongside the existing model/ratio/size/index tokens.
- **Escape unwinds one level**: out of zoom first, then out of the viewer. Backdrop clicks behave the same way; the close button always dismisses outright. While zoomed, `←`/`→` pan instead of stepping between tiles — the on-screen prev/next buttons still navigate.
- Zoom resets on tile navigation, on switching to a reference image, and when a resize makes the fitted view large enough that 1:1 no longer applies. Video tiles keep their native controls and are never zoomable.

Geometry and clamping live in `web/src/lib/imageZoom.ts` (pure, unit-tested); gesture handling in `web/src/hooks/useImageZoom.ts`.

### Toast

**Container (`.toast`)**: position fixed, top 24, centered over the viewport on mobile and over the canvas region on desktop (`left: calc(50% + 120px)`, offset by half the 240px sidebar), `var(--ink)` bg, `var(--bg)` text, 7px radius, padding 9px 16px, JetBrains Mono 12.5px uppercase letter-spacing 0.05em. Default state: `translateY(-20px)` and `opacity: 0`. `.show` state: translate 0 + opacity 1. 240ms `cubic-bezier(.2,.8,.2,1)` transition. Auto-dismiss after 2000ms. Includes a 14×14 check icon in green `oklch(78% 0.14 145)`.

Trigger toasts on: download success ("Downloaded"), main-feed soft-delete ("Archived" — single tile, batch, or full clear-all), prompt copy ("Prompt copied"), archive restore ("Restored"), archive permanent delete ("Deleted").

**Toast position (project-side extension)**

The handoff anchors the toast at `top: 24`. The shipped app instead anchors it **bottom-center, floating just above the Composer card** (offset from the composer via `--toast-anchor-y`, same horizontal centering rules as the spec). Rationale: confirmations land next to the surface the user just acted on (the Composer / canvas), not at the opposite screen edge. The entrance keeps the same 240ms `--ease-out` motion but rises from below (`translateY(20px) → 0`) — the natural direction for a bottom-anchored element. All other Toast tokens (colors, radius, mono type, auto-dismiss, check glyph, dedupe) are unchanged from the spec above.

## Interactions & Behavior

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
Up to **4 tiles may be in flight simultaneously** — a "tile" is one upstream CLIProxy call. The user can spread the budget any way (1×4, 4×1, 2×2, 1+3, …); the upstream API rate-limits per-image, so the cap is unavoidable.

- A tile counts toward the cap from the moment its batch's mutation starts (i.e. its slot is reserved at submit time, before the `batch` event arrives) until that specific tile reaches a terminal state (`done` or `failed`). Each terminal tile event releases one slot independently of the rest of its batch — partial completion frees room.
- Pre-flight check: `inFlightTiles + request.count > 4` → reject. Done synchronously against a ref (not React state) so back-to-back clicks within one render tick still see each other's reservations.
- A rejected request creates no batch, fires no fetch, and reserves no slots. The hook surfaces a soft toast: `"At capacity (N/4 tiles in flight) — batch of M needs more room. Wait or pick a smaller count."`. The toast slice deduplicates identical (text, tone) so Cmd+Enter mashing can't flood the queue.
- Server-driven reconcile: if the server returns fewer (or more) tiles than the client reserved, the in-flight count trues up when the `batch` event lands.
- Truncation safety: stream truncation, network drop, or explicit cancel releases all unresolved reservations in the mutationFn `finally`.

### Re-roll
The re-roll button on a batch header repopulates the composer with that batch's prompt/model/ratio/count and immediately submits — useful for one-click variations. Subject to the concurrency cap above.

### Tooltips
All icon-only buttons carry both `aria-label` (screen-reader contract) and `data-tip="LABEL"` (visual tooltip).

- The `[data-tip]` primitive is a global pure-CSS rule (no JS, no portal). Default position is **above** the host with a `data-tip-place="below"` modifier for top-of-viewport elements (lightbox close, sidebar clear).
- Label style: JetBrains Mono 10px uppercase, `var(--ink)` bg, `var(--bg)` text, 4px 7px padding, 3px radius, `letter-spacing: 0.06em`.
- Motion: 360ms hover/focus delay, then 120ms `cubic-bezier(.2,.8,.2,1)` fade + 2px slide. `prefers-reduced-motion` reduces to an 80ms linear opacity fade.
- Coverage: tile actions (Download / Archive / Expand), batch action cluster (Copy prompt / Re-roll / **Move** / Archive batch), batch-header **pin star**, sidebar **pin star on history items**, sidebar Library rail **search toggle**, sidebar Library rail **collection delete** (`╳`), sidebar Archive all, Prompt Library icon-only delete controls, Prompt picker close controls, lightbox Close / Previous / Next. Buttons that already render a visible text label next to their icon (lightbox bottom-bar Download/Archive (or Delete, in archive view), failed-tile Retry/Dismiss, Composer Generate, Library rail row labels) intentionally skip `data-tip` to avoid redundancy.

### Copy prompt
Writes the prompt to clipboard via `navigator.clipboard.writeText`. Shows a toast.

### Download
Filename format: `atelier_{slug(prompt)}_{modelId}_{ratio.replace(':','x')}_{seed}.{ext}`. The prototype generates SVG so it downloads `.svg`; in production, use whatever the backend returns (PNG/WebP).

### Archive (soft delete from main feed)
All "remove" actions in the main feed UI are soft deletes — the affected tiles move to the **Archive view** and live there for **30 days** before they are permanently purged. Failed/loading tiles bypass the archive (they have no completed image worth retaining) and are hard-deleted on dismiss.
- **Single tile** (tile overlay): archives the tile. If it was the last live tile in the batch, the batch is archived as well. Toast: "Archived".
- **Whole batch** (icon button on batch header): archives every live tile in the batch and the batch itself. Toast: "Archived".
- **Archive all** (sidebar history-section icon): native confirm "Archive all history?" then archives every live tile and batch for the user. Toast: "Archived".
- **Lightbox** in history view: shows an **Archive** button with the archive icon — same soft-delete semantics. In archive view the same slot shows **Delete** with the trash icon (see Archive view below).

### Archive view
A separate view (entered from the persistent sidebar Archive button) lists archived tiles. Each tile carries an identity block below the image — a truncated one-line prompt (full text via the shared `BatchPrompt` prose reveal, hover/focus/touch) plus model label and archived date in the mono meta grammar — and the same prompt feeds the tile's `aria-label`/`alt` and the archive lightbox. Each tile has two actions: **Restore** (move back to history; uses the re-roll icon) and **Delete permanently** (hard delete from disk; uses the trash icon). A header **Empty Archive** button (`.danger` vocabulary — it is an irreversible purge) clears everything via a `ConfirmDialog`. The empty-state glyph uses the archive icon.

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

```css
--bg:          #f6f4ef;   /* warm near-white page */
--bg-elev:     #fbfaf6;   /* card / sidebar / composer */
--bg-sunk:     #efece5;   /* tile frame / hover */
--ink:         #14130f;   /* primary text */
--ink-2:       #4a4942;   /* secondary text */
--ink-3:       #6c6a62;   /* tertiary / metadata (LIGHT mode; #8a877e is the DARK --ink-3) */
--line:        #e3dfd5;   /* default borders */
--line-2:      #d0ccc0;   /* hover / emphasized borders */
--accent:      oklch(53% 0.12 38);   /* warm orange — the AI-action accent (e.g. PromptManager's AI button); not used in selected-state chrome. 53% (not 55%) so accent text on --accent-soft clears 4.5:1 in the light theme */
--accent-soft: oklch(94% 0.02 38);   /* reserved, paired with --accent */
--danger:      oklch(50% 0.14 25);   /* failure red */
--good:        oklch(58% 0.10 145);  /* status green */
--focus-ring:  var(--ink);            /* keyboard focus color (light) */
```

**Dark theme deltas (project-side extension)**

The handoff is light-mode-first. The project ships a warm-on-warm dark palette (`tokens.css :root[data-theme='dark']`) that inverts on the same L axis. Two semantic deltas exist because the literal token-flip would otherwise misread the design intent:

- `--focus-ring` → `var(--ink-2)`. In light mode `--ink` is `#14130f` — a tasteful dark accent at ~12:1 contrast. The flipped value `#f6f4ef` reads as a spotlight against the warm-dark surface and flashes the eye on every keystroke / chip tab. Dropping to `--ink-2` (`#c4c0b6`) keeps focus clearly active at ~7:1 without the harsh emphasis.
- Warm-red wash: the cream `--danger-soft` (the `.banner` background) becomes a deep `oklch(22% 0.04 25)` so the "barely-tinted warning" intent survives the dark palette. (The at-cap in-flight pill uses solid `--danger`, not `--danger-soft`, so it inverts via the plain token-flip.)

Anything else inverts deterministically via the token-flip alone.

**Frosted floating chrome (project-side extension)**

The handoff renders the Composer card and the Prompt Picker desktop popover as opaque `--bg-elev`. The shipped app frosts both so the scrolling image canvas is faintly visible behind them, consistent with the existing dark-overlay glass vocabulary (Lightbox, modal backdrops). Two tokens in `tokens.css :root` carry it:

- `--glass-surface: color-mix(in srgb, var(--bg-elev) 82%, transparent)` — 82% is a deliberate legibility floor: the surface stays mostly cream so `--ink` / `--ink-3` text never drops below its on-`--bg-elev` contrast. Derived from `--bg-elev`, so it auto-flips with the dark theme — no separate dark value. Unlike the dark-theme deltas (a separate `:root[data-theme='dark']` block, exempt from the mirror), these are main-`:root` tokens, so they live in **both** `tokens.css :root` and the prototype's `design/index.html :root` — byte-for-byte parity is enforced by `web/test/tokens.test.ts`. The prototype's `app.js` does not apply them (there is no frosted composer in the prototype); the tokens are present but unused there.
- `--glass-blur: blur(20px) saturate(1.4)` — the frosted blur + a gentle saturation lift so the warm palette doesn't wash out.

Applied only to `.composer` (incl. the mobile fixed-bottom variant) and the desktop picker `.popover`, each guarded by `@supports (backdrop-filter | -webkit-backdrop-filter)` with an opaque fallback and overridden back to opaque under `@media (prefers-reduced-transparency: reduce)`. The mobile picker `.sheet` (already over a blurred backdrop) and the axis-dropdown `.menuPanel` stay opaque on purpose.

**Prompt Picker "Advanced" disclosure (project-side extension)**

When a template is selected, the per-variable pin controls (axis rows) are collapsed by default behind an `Advanced · N variables` disclosure (`button[aria-expanded]` + rotating caret, matching the chip idiom). The default-visible surface is the resolved-prompt preview, the seed instrument strip, and the commit bar; the disclosure re-collapses on template change and is omitted entirely for templates with no variables. Warnings stay visible regardless of disclosure state.

**Prompt Picker refine footer — instrument strip over commit bar (project-side extension)**

The footer carries two jobs and renders them in two vocabularies, because rendering both as the same pill made six controls read as interchangeable:

- **Instrument strip** — acts on the roll. A mono readout (`SEED 3096472877 · LOCKED · 3 STASHED`, tabular-nums so the digits don't jitter across a re-roll, ellipsizing rather than wrapping) sits left; a lock toggle and a dice re-roll sit right as `buttons.icon`, `nowrap` at fixed positions so the re-roll target never moves when the readout's width changes. The lock's pressed state is a filled shackle plus an `--ink` border — hover cannot repaint either, which matters because the icons carry no text label. The dice tumbles once per press via a keyed one-shot animation and returns to rest.
- **Commit bar** — disposes of the sheet. `＋ Stash & roll` (left, hidden while a sweep is armed, since sweeping *is* stashing at axis granularity), then `Simulate` and the `Use prompt` primary. On phone the primary takes `flex: 1`, so it is always the widest target in the footer.

There is **no `Cancel`**: the header `×`, Escape, and a backdrop tap already dismiss, and a fourth exit spent 76px of the thumb zone. The whole footer is 125px on a 375pt-wide phone, down from a three-row 177px that orphaned `Stash & roll` on its own line. Locked by `web/e2e/phone-picker.spec.ts`.

**Additional main-`:root` tokens (project-side extension)**

Same byte-parity contract as the frosted-glass tokens above — these live in **both** `tokens.css :root` and the prototype's `design/index.html :root` (`web/test/tokens.test.ts`); dark-theme overrides where noted go in the exempt `:root[data-theme='dark']` block.

- `--z-composer: 5` / `--z-overlay-max: 1000` — names the composer layer and the top overlay ceiling (tooltip, crash card). The full z-scale: `--z-composer` 5 → `--z-popover` 50 → chip menu `calc(--z-popover + 10)` → `--z-lightbox` 100 → `--z-toast` 200 → `--z-confirm` 250 → `--z-overlay-max` 1000.
- `--shadow-2-up: 0 -8px 28px -10px rgba(20,19,15,0.18), 0 -2px 6px rgba(20,19,15,0.06)` — shadow-2 mirrored upward, for the mobile fixed-bottom Composer edge. Dark override in the dark block.
- `--good-on-ink: oklch(78% 0.14 145)` — green for the Toast check glyph, which sits on the `--ink` surface (`--good` is calibrated for light surfaces only). Dark override `oklch(55% 0.14 145)` because `--ink` flips to near-white in dark.
- `--line-control: #8d877a` (dark `#736c60`) — resting boundary for **interactive** controls (`buttons.secondary`, `buttons.icon`, and the prototype's `.btn-mini` / `.chip`). `--line` and `--line-2` stay the decorative divider tokens: a divider is exempt from WCAG 1.4.11, a control's own boundary is not, and `--line-2` measures 1.54:1 on `--bg-elev`. This clears 3:1 against every surface a control boundary touches — `--bg`, `--bg-elev`, and `--bg-sunk` (which is `.icon`'s own fill, i.e. the border's inner neighbour).
- `--dur-reduced: 80ms` — the canonical `prefers-reduced-motion` fade-tier duration.
- `--ease-tactile: cubic-bezier(.34,1.56,.64,1)` — springy overshoot curve reserved for the *transform channel* of small controls (button press/release, toast landing). `--ease-out` stays the default for color/opacity/layout motion.
- `--serif: 'Instrument Serif', Georgia, 'Times New Roman', serif` — editorial display face (self-hosted woff2, regular + italic, `web/public/fonts/`). Used sparingly in exactly three coordinated moments: StateView headings (empty/error states), dialog titles, and the PromptPicker header. Not a body face; don't spread it to labels or metadata (those stay mono/sans).

**Typography**
- Sans (UI): `"Helvetica Neue", Helvetica, Arial, sans-serif`
- Mono (metadata, labels, kbd): `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace` — Google Fonts weights 400 + 500

**Radius**: 3 (mini buttons), 4 (tile buttons / kbd), 6 (chips, default), 7 (Generate button), 10 (tiles), 14 (composer card)

**Shadow**
- 1: `0 1px 0 rgba(20,19,15,0.04), 0 1px 2px rgba(20,19,15,0.04)` (default tile)
- 2: `0 8px 28px -10px rgba(20,19,15,0.18), 0 2px 6px rgba(20,19,15,0.06)` (tile hover)
- 3: `0 30px 80px -20px rgba(20,19,15,0.35), 0 8px 20px rgba(20,19,15,0.10)` (composer)
- 2-up: `0 -8px 28px -10px rgba(20,19,15,0.18), 0 -2px 6px rgba(20,19,15,0.06)` (mobile fixed-bottom composer edge — shadow-2 mirrored upward)

**Spacing**: Generally 4 / 6 / 8 / 10 / 14 / 18 / 24 / 36 px. Canvas padding 28×36×180. Sidebar 18px sides. Composer 14px sides.

**Easing**: All UI motion uses `cubic-bezier(.2, .8, .2, 1)` (smooth, slight overshoot feel) at durations 120 (hover), 160 (overlay), 200–240 (toast/transform), 360–500 (entrance), 480–600 (atmospheric reveal — veil toggle, preview blur sharpen, fresh-completion reveal).

## Assets

No external image, icon, or font assets beyond:
- **JetBrains Mono** from Google Fonts (weights 400, 500).
- **Inline SVG icons** drawn in `app.js` under the `I` object. They are 14×14, 2px stroke, `currentColor`, lucide-style. List: arrow, close, download, trash, archive (box-with-slot — used for main-feed soft-delete actions), copy, reroll (refresh), alert (triangle), check, expand (corners), cloud, chip. The trash icon is reserved for the Archive view's "Delete permanently" action; everywhere else (tile overlay, batch header, sidebar Archive-all, lightbox-in-history) uses the archive icon. **Replace these with whatever icon library your codebase already uses** — lucide-react, heroicons, your design system's Icon component, etc. Match the 14×14 / 2px-stroke visual weight.

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
