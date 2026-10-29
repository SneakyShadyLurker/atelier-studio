import type {
  AiFillBackend,
  EnhancePromptRequest,
  GenerateRequest,
  Model,
  Ratio,
  UploadRef,
  VideoDurationFrames,
} from '@atelier/shared';
import { AI_FILL_BACKEND_VALUES, BRAINSTORM_DEFAULT_COUNT, MAX_HISTORY_Q_LEN, MAX_TILE_COUNT } from '@atelier/shared';
import { create, type StateCreator } from 'zustand';
import { refImageUrl } from '../api/uploads';
import { pinAt, withoutPin } from '../lib/promptPins';
import { MAX_ROLL_QUEUE_ENTRIES, persistRollQueue, unsettledInFlightCount } from '../lib/rollQueuePersist';
import { overlayExitDurationMs } from '../lib/overlayDuration';

export type Count = 1 | 2 | 3 | 4;
// Compile-time lock: the shared MAX_TILE_COUNT must be a Count member. If the
// server count cap changes, this stops compiling until Count is updated.
const _countMaxLock: Count = MAX_TILE_COUNT;

// Default composer reference-image cap — mirrors gpt-image-2.5-sunburst's maxRefImages.
// The server enforces the real per-model ceiling; this is the upload-time UX
// guard used while no ref-supporting model is selected.
export const MAX_REF_IMAGES_FALLBACK = 4;

// Archive sub-scope. The Library rail in archive view drives this — picking
// "Unsorted" while archived means "archived batches with collection_id IS NULL",
// etc. `{ kind: 'all' }` is the default landing scope for the Archive button.
export type ArchiveScope =
  | { kind: 'all' }
  | { kind: 'unsorted' }
  | { kind: 'pinned' }
  | { kind: 'collection'; id: string };

export type AppView =
  | { kind: 'archive'; scope: ArchiveScope }
  | { kind: 'pinned' }
  | { kind: 'unsorted' }
  | { kind: 'collection'; id: string }
  | { kind: 'prompts' };

export const APP_VIEW_ARCHIVE: AppView = { kind: 'archive', scope: { kind: 'all' } };
export const APP_VIEW_PINNED: AppView = { kind: 'pinned' };
export const APP_VIEW_UNSORTED: AppView = { kind: 'unsorted' };
export const APP_VIEW_PROMPTS: AppView = { kind: 'prompts' };
export const collectionView = (id: string): AppView => ({ kind: 'collection', id });
export const archiveUnsortedView: AppView = { kind: 'archive', scope: { kind: 'unsorted' } };
export const archivePinnedView: AppView = { kind: 'archive', scope: { kind: 'pinned' } };
export const archiveCollectionView = (id: string): AppView => ({ kind: 'archive', scope: { kind: 'collection', id } });

function archiveScopeEquals(a: ArchiveScope, b: ArchiveScope): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'collection' || (b.kind === 'collection' && a.id === b.id);
}

export function appViewEquals(a: AppView, b: AppView): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'collection') return b.kind === 'collection' && a.id === b.id;
  if (a.kind === 'archive') return b.kind === 'archive' && archiveScopeEquals(a.scope, b.scope);
  return true;
}

export interface ComposerDraft {
  prompt: string;
  modelId: string;
  ratio: Ratio | null;
  /**
   * Selected clip length for video models, in frames. `null` means "not yet
   * chosen" — the Composer resolves it against the model's supportedDurations
   * exactly as it does for `ratio`, so switching models can never strand the
   * draft on a length the new model cannot render.
   */
  durationFrames: VideoDurationFrames | null;
  count: Count;
  refImages: readonly RefImageDraft[];
  i2vSourceUploadId?: string | undefined;
  // Source still's generation prompt, captured at Animate time so the h3-motion
  // enhancer can anchor subject identity. Client-only; never sent on the wire.
  i2vSourcePrompt?: string | undefined;
  motionPrompt?: string | undefined;
  /** Done video tile whose provenance-bound handoff frame is being extended. */
  extendsTileId?: string | undefined;
  /** Previous segment motion prompt used only as motion-enhance continuation context. */
  extendPrevPrompt?: string | undefined;
  /**
   * The user's own prompt, anchored by the first Enhance and kept across
   * Generate / Undo / view switches — every further Enhance re-rolls it and
   * Undo restores it. It follows the user's own edits of that text and is
   * dropped only when the brief is replaced outright (Clear, Use prompt, or
   * emptying the box). Client-only; never on the wire.
   */
  enhanceAnchor?: string | undefined;
  /** Last completed Enhance output, so an unedited rewrite can be told apart from user text. */
  enhancedText?: string | undefined;
  /**
   * The most recent non-I2V (image) model the user actively selected. Tracked so
   * the video panel's "back to image" affordance can restore the model the user
   * was on before entering animate mode, rather than always snapping to the
   * first image model. Optional like the other late-added fields; falls back to
   * the first available image model when unset.
   */
  lastImageModelId?: string | undefined;
  rollQueue: readonly QueuedRoll[];
  /**
   * Brainstorm Characters form state, kept in the draft so it survives the
   * PromptPicker unmounting on close (same persistence as the composer prompt).
   * `brainstormCount` is the per-run character count (1..BRAINSTORM_MAX_COUNT),
   * distinct from `count` (the composer's 1-4 tile count). Optional like
   * `provenance` so existing draft literals stay valid; `initialDraft` always
   * seeds them, so the live store value is never undefined.
   */
  brainstormBrief?: string;
  brainstormCount?: number;
  /** AI Storytelling outline, persisted across dialog closes. */
  storyOutline?: string;
  /**
   * Prompt-library provenance for the current draft prompt. Set by the picker's
   * "Use prompt"; cleared by any manual textarea edit (a hand-edited prompt is
   * no longer faithfully reproducible). `pins` keys are opaque occurrence keys.
   */
  provenance?: {
    readonly templateId: string;
    readonly rollSeed: number;
    readonly pins: Readonly<Record<string, string>>;
  };
}

export interface QueuedRoll {
  readonly id: string;
  readonly text: string;
  readonly seed: number;
  readonly source: 'template' | 'sweep' | 'brainstorm' | 'composer';
  /**
   * Per-roll prompt-library provenance, captured at stash time. Each queued /
   * swept batch is independently reproducible. Feature ① (axis sweep) SETS this
   * when enqueuing sweep rolls; it does not redefine the field.
   */
  readonly provenance?: {
    readonly templateId: string;
    readonly rollSeed: number;
    readonly pins: Readonly<Record<string, string>>;
  };
  /**
   * The settings of the Generate press that queued this roll. Absent on rolls
   * stashed from the library (template, sweep, brainstorm) and on rolls saved
   * before the field existed: those bind to the press that submits them.
   */
  readonly submission?: RollSubmission;
}

/** A press's wire fields, minus what each fire sets: prompt, seed, key and provenance. */
export type RollSubmissionRequest = Omit<GenerateRequest, 'prompt' | 'seed' | 'idempotencyKey' | 'provenance'>;

/**
 * The generation settings of one Generate press, bound to every item it
 * submits, so a model or setting change made afterwards never rewrites a press
 * already made, through capacity requeue, Stop and reload alike.
 */
export interface RollSubmission {
  /** `count` is already clamped to the model's per-batch cap. */
  readonly request: RollSubmissionRequest;
  /** The picker's locked image seed at press time; null draws a fresh seed per fire. */
  readonly lockedSeed: number | null;
  /** The model takes an h3-motion enhanced prompt. */
  readonly wantsMotion: boolean;
  readonly motionFields: Pick<EnhancePromptRequest, 'sourcePrompt' | 'durationFrames' | 'extendContext'>;
  /** Historical replay: submit these inputs without resolving or enhancing them again. */
  readonly prepared?: true;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface RefImageDraft {
  clientId: string;
  serverId?: string;
  status: 'uploading' | 'ready' | 'error';
  mime: string;
  sizeBytes: number;
  previewUrl: string;
  error?: string;
}

export interface ReplaceRefImageResult {
  clientId: string;
  evicted: readonly RefImageDraft[];
}

export type PromptManagerTab = 'templates' | 'lists' | 'dimensions' | 'settings';

export interface PromptPickerDraft {
  templateId: string | null;
  pins: Readonly<Record<string, string>>;
  seed: number;
  lockSeed: boolean;
  sweepKey: string | null;
}

export interface ToastMessage {
  id: string;
  text: string;
  tone?: 'success' | 'error' | 'soft';
  action?: ToastAction;
  // Invoked exactly once when the toast leaves (auto-expiry — which respects
  // pause-on-hover — or manual removal). The undo-window owner hangs deferred
  // destructive teardown here so it can never fire while the action is still
  // on screen; a parallel wall-clock timer could (toast timers pause, it
  // would not).
  onDismiss?: () => void;
  // True once the auto-dismiss timer has elapsed and the toast is playing its
  // exit animation; removed from state after TOAST_EXIT_MS. Lets the renderer
  // run a fade-out instead of having React rip the node out of the DOM.
  leaving?: boolean;
}

interface LightboxState {
  batchId: string;
  tileId: string;
  masterSequenceId?: string;
}

interface ComposerSlice {
  draft: ComposerDraft;
  setDraft: (patch: Partial<ComposerDraft>) => void;
  addRefImage: (file: File) => string;
  markRefImageReady: (clientId: string, upload: UploadRef) => void;
  markRefImageError: (clientId: string, error: string) => void;
  removeRefImage: (clientId: string) => RefImageDraft | null;
  replaceRefImagesFrom: (index: number, file: File) => ReplaceRefImageResult;
  restoreRefImages: (clientId: string, refs: readonly RefImageDraft[]) => void;
  clearRefImages: () => void;
  /**
   * User admission. Refuses (toast, false) once visible plus consumed-but-unsettled
   * rolls reach MAX_ROLL_QUEUE_ENTRIES, so a reload can never drop a saved roll.
   */
  stashRoll: (roll: QueuedRoll) => boolean;
  /** System requeue of work already prepared or paid for; bypasses the cap. */
  requeueRoll: (roll: QueuedRoll) => void;
  removeQueuedRoll: (id: string) => void;
  removeQueuedRolls: (ids: readonly string[]) => void;
  reorderQueuedRolls: (fromIdx: number, toIdx: number) => void;
  clearRollQueue: () => void;
  hydrateRollQueue: (rolls: readonly QueuedRoll[]) => void;
  restoreRollQueue: (snapshot: readonly QueuedRoll[]) => void;
  /** Removes rolls the server took as batches; no restore brings them back. */
  retireQueuedRolls: (ids: readonly string[]) => void;
  // Rolls retired by retireQueuedRolls. A restore skips them: Clear's Undo after a
  // Stop could otherwise return a roll whose batch was accepted meanwhile.
  retiredRollIds: ReadonlySet<string>;
  // Bumped whenever the queue is INVALIDATED by a user action (explicit clear or a
  // template switch that discards prior-template rolls). The single-owner drain
  // snapshots this before consuming a pass and refuses to restore stale rolls if it
  // changed mid-pass — so a clear / template switch can't be undone by a late
  // backpressure restore. NOT bumped by the drain's own consume/restore.
  queueEpoch: number;
}

interface BatchSelectionSlice {
  activeBatchId: string | null;
  setActiveBatchId: (batchId: string | null) => void;
}

interface AutoScrollSlice {
  // Durable burst-follow anchor: the batch the feed is currently following.
  // walkBurstDeepestActive(this) is BOTH the canvas scroll target and the
  // sidebar's highlighted row, so the two cannot diverge. Set when a new
  // batch arrives over SSE; cleared by clearFollowAnchor on a manual selection.
  followAnchorId: string | null;
  followBatch: (batchId: string) => void;
  clearFollowAnchor: () => void;
}

interface UiSlice {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  composerExpanded: boolean;
  setComposerExpanded: (expanded: boolean) => void;
  composerMinimized: boolean;
  setComposerMinimized: (minimized: boolean) => void;
  // Count of in-flight Generate submissions still resolving (ai-fill round-trip +
  // batch POST) before their tiles exist. Drives the Generate button's working
  // state + the queuing badge. A counter, not a flag, so concurrent submits show
  // a real "N resolving" depth.
  resolving: number;
  beginResolving: () => void;
  endResolving: () => void;
  // Count of individual prompts still being resolved (ai-fill + format) before
  // their generate() fires. Distinct from `resolving` (submission-depth, drives
  // the button): `preparing` counts DOWN per item to drive the "Preparing N
  // more…" indicator that persists alongside tiles as the pipeline drains.
  preparing: number;
  addPreparing: (n: number) => void;
  settlePreparing: (n: number) => void;
  /**
   * Per-backend count of in-flight {{ai-fill}} calls. Drives the Generate
   * pill's model attribution.
   */
  aiFillActive: Readonly<Record<AiFillBackend, number>>;
  beginAiFill: (backend: AiFillBackend) => void;
  endAiFill: (backend: AiFillBackend) => void;
  // True while the single-owner roll-queue drain is actively working through the
  // queue (resolving + firing, including inter-pass backpressure waits). Drives
  // the "Draining… [Stop]" affordance and gates re-entrant submits so a second
  // Generate press can't spawn a parallel drain that saturates the enhance pool.
  draining: boolean;
  setDraining: (draining: boolean) => void;
  pendingStory: { readonly id: string; readonly until: number } | null;
  setPendingStory: (pendingStory: { readonly id: string; readonly until: number } | null) => void;
}

interface ByokSlice {
  byokOpen: boolean;
  openByok: () => void;
  closeByok: () => void;
}

interface SaveTemplateSlice {
  saveTemplatePrompt: string | null;
  openSaveTemplate: (prompt: string) => void;
  closeSaveTemplate: () => void;
}

interface PromptLibraryUiSlice {
  promptManagerTab: PromptManagerTab;
  setPromptManagerTab: (tab: PromptManagerTab) => void;
  promptPickerDraft: PromptPickerDraft;
  setPickerTemplate: (templateId: string | null) => void;
  setPickerPin: (listId: string, optionId: string) => void;
  clearPickerPin: (listId: string) => void;
  setPickerSeed: (seed: number) => void;
  setPickerLockSeed: (lockSeed: boolean) => void;
  setPickerSweep: (occurrenceKey: string) => void;
  clearPickerSweep: () => void;
  resetPicker: () => void;
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
  setPickerOpen: (open: boolean) => void;
  // Mirrors the Composer's enhance-stream status into the store so callers that
  // open the picker (e.g. batch Reopen) can refuse while an enhance is in
  // flight — the picker render is gated `promptPickerOpen && !enhancing`, so an
  // open during enhance would leave store-open but visually-hidden, then pop
  // open unexpectedly when enhance ends.
  enhanceInFlight: boolean;
  setEnhanceInFlight: (inFlight: boolean) => void;
  // Returns false (no-op) when an enhance is in flight; true once opened.
  reopenBatchInPicker: (provenance: { templateId: string | null; rollSeed: number; pins: Readonly<Record<string, string>> }) => boolean;
}

interface ViewSlice {
  view: AppView;
  q: string;
  setView: (view: AppView) => void;
  /** URL-driven navigation: sets view and q together, resetting view-scoped
   *  state (as setView does) only when the view actually changes. */
  navigate: (view: AppView, q: string) => void;
  setQ: (q: string) => void;
}

interface LightboxSlice {
  lightbox: LightboxState | null;
  openLightbox: (batchId: string, tileId: string) => void;
  openMasterLightbox: (batchId: string, tileId: string, sequenceId: string) => void;
  setLightboxTile: (tileId: string) => void;
  closeLightbox: () => void;
}

interface ToastSlice {
  toasts: readonly ToastMessage[];
  addToast: (text: string, tone?: ToastMessage['tone'], durationMs?: number, action?: ToastAction, onDismiss?: () => void) => string;
  removeToast: (id: string) => void;
  pauseToast: (id: string) => void;
  resumeToast: (id: string) => void;
}

export interface TilePreview {
  url: string;
  index: number;
}

// Transient in-flight preview frames (cliproxy partial_image data URLs) keyed
// by tileId. Lives outside TanStack Query because /history doesn't persist
// previews — a refetch (window-focus, reconnect, mutation invalidate) would
// otherwise overwrite the cache with the server's preview-less loading row,
// dropping the partial back to the placeholder mid-stream. Owned wholesale
// by useGenerate: set on `partial`, cleared on terminal event or stream end.
interface PreviewsSlice {
  previews: ReadonlyMap<string, TilePreview>;
  setTilePreview: (tileId: string, preview: TilePreview) => void;
  clearTilePreview: (tileId: string) => void;
  // Bulk-reset for `useClearAll`. Avoids the O(n²) sequence of N
  // single-key spread+filter passes for a "wipe everything" action.
  clearAllTilePreviews: () => void;
}

interface ProgressSlice {
  tileProgress: Readonly<Record<string, number>>;
  setTileProgress: (tileId: string, progress: number) => void;
  clearTileProgress: (tileId: string) => void;
  clearAllTileProgress: () => void;
}

// Tiles with a character card in flight (useCharacterCardFromTile owns the
// writes). Lives in the store, not the tile, so a tile virtualized away and
// remounted mid-request still shows its pending action.
interface CharacterCardSlice {
  cardPendingTileIds: ReadonlySet<string>;
  setCardPending: (tileId: string, pending: boolean) => void;
}

type AtelierState =
  & ComposerSlice
  & BatchSelectionSlice
  & AutoScrollSlice
  & UiSlice
  & ByokSlice
  & SaveTemplateSlice
  & PromptLibraryUiSlice
  & ViewSlice
  & LightboxSlice
  & ToastSlice
  & PreviewsSlice
  & ProgressSlice
  & CharacterCardSlice;

const initialDraft: ComposerDraft = { prompt: '', modelId: '', ratio: null, durationFrames: null, count: 2, refImages: [], rollQueue: [], brainstormBrief: '', brainstormCount: BRAINSTORM_DEFAULT_COUNT, storyOutline: '' };
const initialPromptPickerDraft: PromptPickerDraft = {
  templateId: null,
  pins: {},
  seed: 0,
  lockSeed: false,
  sweepKey: null,
};

function revokePreviewUrl(ref: RefImageDraft): void {
  if (ref.previewUrl.startsWith('blob:')) URL.revokeObjectURL(ref.previewUrl);
}

function optimisticRef(file: File): RefImageDraft {
  return {
    clientId: crypto.randomUUID(),
    status: 'uploading',
    mime: file.type || 'application/octet-stream',
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
  };
}

// Every ref-image transition that replaces or removes a previewUrl must revoke
// the discarded blob URL here; otherwise failed uploads and navigation leak.
const createComposerSlice: StateCreator<AtelierState, [], [], ComposerSlice> = (set, get) => ({
  draft: initialDraft,
  setDraft: (patch) => {
    set((state) => {
      const next = { ...state.draft, ...patch };
      // Invalidation: a patch that changes the prompt WITHOUT also supplying a
      // new provenance is a manual edit — drop stale provenance. The picker
      // sets prompt + provenance in one call, so that path is preserved.
      if ('prompt' in patch && !('provenance' in patch)) {
        delete next.provenance;
      }
      return { draft: next };
    });
  },
  addRefImage: (file) => {
    const ref = optimisticRef(file);
    set((state) => ({ draft: { ...state.draft, refImages: [...state.draft.refImages, ref] } }));
    return ref.clientId;
  },
  markRefImageReady: (clientId, upload) => {
    set((state) => ({
      draft: {
        ...state.draft,
        refImages: state.draft.refImages.map((ref) => {
          if (ref.clientId !== clientId) return ref;
          revokePreviewUrl(ref);
          return {
            clientId,
            serverId: upload.id,
            status: 'ready',
            mime: upload.mime,
            sizeBytes: upload.sizeBytes,
            previewUrl: refImageUrl(upload.id),
          };
        }),
      },
    }));
  },
  markRefImageError: (clientId, error) => {
    set((state) => ({
      draft: {
        ...state.draft,
        refImages: state.draft.refImages.map((ref) =>
          ref.clientId === clientId ? { ...ref, status: 'error', error } : ref,
        ),
      },
    }));
  },
  removeRefImage: (clientId) => {
    let removed: RefImageDraft | null = null;
    set((state) => {
      removed = state.draft.refImages.find((ref) => ref.clientId === clientId) ?? null;
      if (!removed) return {};
      revokePreviewUrl(removed);
      return {
        draft: {
          ...state.draft,
          refImages: state.draft.refImages.filter((ref) => ref.clientId !== clientId),
        },
      };
    });
    return removed;
  },
  replaceRefImagesFrom: (index, file) => {
    const ref = optimisticRef(file);
    let evicted: readonly RefImageDraft[] = [];
    set((state) => {
      const refs = [...state.draft.refImages];
      if (index >= 0 && index < refs.length) {
        evicted = refs.splice(index, refs.length - index, ref);
        for (const removed of evicted) revokePreviewUrl(removed);
      } else {
        refs.push(ref);
      }
      return { draft: { ...state.draft, refImages: refs } };
    });
    return { clientId: ref.clientId, evicted };
  },
  restoreRefImages: (clientId, restored) => {
    set((state) => {
      const refs = [...state.draft.refImages];
      const index = refs.findIndex((ref) => ref.clientId === clientId);
      if (index === -1) return {};
      const current = refs[index];
      if (current) revokePreviewUrl(current);
      refs.splice(index, 1, ...restored);
      return { draft: { ...state.draft, refImages: refs } };
    });
  },
  clearRefImages: () => {
    set((state) => {
      if (state.draft.refImages.length === 0) return {};
      for (const ref of state.draft.refImages) revokePreviewUrl(ref);
      return { draft: { ...state.draft, refImages: [] } };
    });
  },
  stashRoll: (roll) => {
    const { rollQueue } = get().draft;
    const inFlight = unsettledInFlightCount(new Set(rollQueue.map((queued) => queued.id)));
    if (rollQueue.length + inFlight >= MAX_ROLL_QUEUE_ENTRIES) {
      get().addToast(`Roll queue is limited to ${MAX_ROLL_QUEUE_ENTRIES} prompts.`, 'error');
      return false;
    }
    set((state) => ({ draft: { ...state.draft, rollQueue: [...state.draft.rollQueue, roll] } }));
    return true;
  },
  requeueRoll: (roll) => {
    set((state) => ({ draft: { ...state.draft, rollQueue: [...state.draft.rollQueue, roll] } }));
  },
  removeQueuedRoll: (id) => {
    set((state) => ({ draft: { ...state.draft, rollQueue: state.draft.rollQueue.filter((r) => r.id !== id) } }));
  },
  removeQueuedRolls: (ids) => {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    set((state) => ({ draft: { ...state.draft, rollQueue: state.draft.rollQueue.filter((r) => !drop.has(r.id)) } }));
  },
  reorderQueuedRolls: (fromIdx, toIdx) => {
    set((state) => {
      const next = [...state.draft.rollQueue];
      const [moved] = next.splice(fromIdx, 1);
      if (!moved) return {};
      next.splice(toIdx, 0, moved);
      return { draft: { ...state.draft, rollQueue: next } };
    });
  },
  queueEpoch: 0,
  clearRollQueue: () => {
    set((state) => ({ draft: { ...state.draft, rollQueue: [] }, queueEpoch: state.queueEpoch + 1 }));
  },
  hydrateRollQueue: (rolls) => {
    set((state) => state.draft.rollQueue.length === 0
      ? { draft: { ...state.draft, rollQueue: rolls } }
      : {});
  },
  retiredRollIds: new Set<string>(),
  retireQueuedRolls: (ids) => {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    set((state) => ({
      draft: { ...state.draft, rollQueue: state.draft.rollQueue.filter((r) => !drop.has(r.id)) },
      retiredRollIds: new Set([...state.retiredRollIds, ...ids]),
    }));
  },
  restoreRollQueue: (snapshot) => {
    set((state) => {
      const restored = snapshot.filter((roll) => !state.retiredRollIds.has(roll.id));
      const restoredIds = new Set(restored.map((roll) => roll.id));
      return {
        draft: {
          ...state.draft,
          rollQueue: [
            ...restored,
            ...state.draft.rollQueue.filter((roll) => !restoredIds.has(roll.id)),
          ],
        },
      };
    });
  },
});

const createBatchSelectionSlice: StateCreator<AtelierState, [], [], BatchSelectionSlice> = (set) => ({
  activeBatchId: null,
  setActiveBatchId: (batchId) => { set({ activeBatchId: batchId }); },
});

const createAutoScrollSlice: StateCreator<AtelierState, [], [], AutoScrollSlice> = (set) => ({
  followAnchorId: null,
  followBatch: (batchId) => { set({ followAnchorId: batchId }); },
  clearFollowAnchor: () => { set({ followAnchorId: null }); },
});

const createUiSlice: StateCreator<AtelierState, [], [], UiSlice> = (set) => ({
  sidebarOpen: false,
  setSidebarOpen: (open) => { set({ sidebarOpen: open }); },
  toggleSidebar: () => { set((state) => ({ sidebarOpen: !state.sidebarOpen })); },
  composerExpanded: false,
  composerMinimized: false,
  // Expanding is the only intent that un-minimizes desktop; collapsing the
  // phone composer (roll-queue drains call this with false) must not.
  setComposerExpanded: (expanded) => {
    set(expanded ? { composerExpanded: true, composerMinimized: false } : { composerExpanded: false });
  },
  setComposerMinimized: (minimized) => { set({ composerMinimized: minimized }); },
  resolving: 0,
  beginResolving: () => { set((state) => ({ resolving: state.resolving + 1 })); },
  endResolving: () => { set((state) => ({ resolving: Math.max(0, state.resolving - 1) })); },
  preparing: 0,
  addPreparing: (n) => { set((state) => ({ preparing: state.preparing + n })); },
  settlePreparing: (n) => { set((state) => ({ preparing: Math.max(0, state.preparing - n) })); },
  aiFillActive: Object.fromEntries(AI_FILL_BACKEND_VALUES.map((backend) => [backend, 0])) as Record<AiFillBackend, number>,
  beginAiFill: (backend) => {
    set((state) => ({
      aiFillActive: { ...state.aiFillActive, [backend]: state.aiFillActive[backend] + 1 },
    }));
  },
  endAiFill: (backend) => {
    set((state) => ({
      aiFillActive: { ...state.aiFillActive, [backend]: Math.max(0, state.aiFillActive[backend] - 1) },
    }));
  },
  draining: false,
  setDraining: (draining) => { set({ draining }); },
  pendingStory: null,
  setPendingStory: (pendingStory) => { set({ pendingStory }); },
});

const createByokSlice: StateCreator<AtelierState, [], [], ByokSlice> = (set) => ({
  byokOpen: false,
  openByok: () => { set({ byokOpen: true }); },
  closeByok: () => { set({ byokOpen: false }); },
});

const createSaveTemplateSlice: StateCreator<AtelierState, [], [], SaveTemplateSlice> = (set) => ({
  saveTemplatePrompt: null,
  openSaveTemplate: (prompt) => { set({ saveTemplatePrompt: prompt }); },
  closeSaveTemplate: () => { set({ saveTemplatePrompt: null }); },
});

const createPromptLibraryUiSlice: StateCreator<AtelierState, [], [], PromptLibraryUiSlice> = (set, get) => ({
  promptManagerTab: 'templates',
  setPromptManagerTab: (tab) => { set({ promptManagerTab: tab }); },
  promptPickerDraft: initialPromptPickerDraft,
  setPickerTemplate: (templateId) => {
    set((state) => {
      // Preserve the queue only when re-selecting the exact same non-null
      // template (e.g. picker re-opens on the same template). Switching to a
      // different template or clearing (null) always discards pending rolls,
      // since they were resolved against the prior template's variables.
      const sameTemplate = templateId !== null && state.promptPickerDraft.templateId === templateId;
      const draftPatch = sameTemplate ? state.draft : { ...state.draft, rollQueue: [] };
      return {
        promptPickerDraft: { ...state.promptPickerDraft, templateId, pins: {}, sweepKey: null },
        draft: draftPatch,
        // A template switch discards prior-template rolls — invalidate so a racing
        // drain can't resurrect them.
        queueEpoch: sameTemplate ? state.queueEpoch : state.queueEpoch + 1,
      };
    });
  },
  setPickerPin: (listId, optionId) => {
    set((state) => ({
      promptPickerDraft: {
        ...state.promptPickerDraft,
        pins: { ...state.promptPickerDraft.pins, [listId]: optionId },
      },
    }));
  },
  clearPickerPin: (listId) => {
    set((state) => {
      if (pinAt(state.promptPickerDraft.pins, listId) === undefined) return {};
      return { promptPickerDraft: { ...state.promptPickerDraft, pins: withoutPin(state.promptPickerDraft.pins, listId) } };
    });
  },
  setPickerSeed: (seed) => {
    set((state) => ({ promptPickerDraft: { ...state.promptPickerDraft, seed } }));
  },
  setPickerLockSeed: (lockSeed) => {
    set((state) => ({ promptPickerDraft: { ...state.promptPickerDraft, lockSeed } }));
  },
  setPickerSweep: (occurrenceKey) => {
    set((state) => ({ promptPickerDraft: { ...state.promptPickerDraft, sweepKey: occurrenceKey } }));
  },
  clearPickerSweep: () => {
    set((state) => (state.promptPickerDraft.sweepKey === null
      ? {}
      : { promptPickerDraft: { ...state.promptPickerDraft, sweepKey: null } }));
  },
  resetPicker: () => { set({ promptPickerDraft: initialPromptPickerDraft }); },
  pickerOpen: false,
  openPicker: () => { set({ pickerOpen: true }); },
  closePicker: () => { set({ pickerOpen: false }); },
  setPickerOpen: (open) => { set({ pickerOpen: open }); },
  enhanceInFlight: false,
  setEnhanceInFlight: (inFlight) => { set({ enhanceInFlight: inFlight }); },
  reopenBatchInPicker: (provenance) => {
    if (get().enhanceInFlight) return false;
    set({
      promptPickerDraft: {
        ...initialPromptPickerDraft,
        templateId: provenance.templateId,
        seed: provenance.rollSeed,
        pins: { ...provenance.pins },
      },
      pickerOpen: true,
    });
    return true;
  },
});

// Collapse the composer alongside lightbox/activeBatchId: these are all
// "things the user was looking at", so switching view resets them in one
// atomic patch instead of relying on Composer to derive its way back to
// collapsed via useEffect. Shared by setView and URL navigation.
function viewChangeReset(state: AtelierState, view: AppView): Partial<AtelierState> {
  return {
    lightbox: null,
    composerExpanded: false,
    composerMinimized: false,
    activeBatchId: view.kind === 'archive' ? null : state.activeBatchId,
    followAnchorId: view.kind === 'archive' ? null : state.followAnchorId,
  };
}

const createViewSlice: StateCreator<AtelierState, [], [], ViewSlice> = (set) => ({
  view: APP_VIEW_UNSORTED,
  q: '',
  setView: (view) => {
    set((state) => ({ view, ...viewChangeReset(state, view) }));
  },
  navigate: (view, q) => {
    set((state) => (appViewEquals(state.view, view)
      ? { q }
      : { view, q, ...viewChangeReset(state, view) }));
  },
  // Clamp at the store boundary so the URL coordinator's truncated
  // serialization and the query cache's bound value never disagree. Cap is
  // the shared wire-contract bound (also the api Zod `.max()`).
  setQ: (q) => { set({ q: q.slice(0, MAX_HISTORY_Q_LEN) }); },
});

const createLightboxSlice: StateCreator<AtelierState, [], [], LightboxSlice> = (set) => ({
  lightbox: null,
  openLightbox: (batchId, tileId) => { set({ lightbox: { batchId, tileId } }); },
  openMasterLightbox: (batchId, tileId, sequenceId) => { set({ lightbox: { batchId, tileId, masterSequenceId: sequenceId } }); },
  setLightboxTile: (tileId) => {
    set((state) => ({ lightbox: state.lightbox ? { batchId: state.lightbox.batchId, tileId } : null }));
  },
  closeLightbox: () => { set({ lightbox: null }); },
});

const createPreviewsSlice: StateCreator<AtelierState, [], [], PreviewsSlice> = (set) => ({
  previews: new Map<string, TilePreview>(),
  setTilePreview: (tileId, preview) => {
    // Monotonic-index guard: drop partials whose ordinal isn't strictly
    // greater than the latest one rendered for this tile. Reordered or
    // duplicate partials would otherwise replace a high-quality frame with
    // a stale low-quality one. Same protection that previously lived in
    // updateLoadingTilePreview when previews were stored on the cache.
    set((state) => {
      const existing = state.previews.get(tileId);
      if (existing && preview.index <= existing.index) return {};
      const next = new Map(state.previews);
      next.set(tileId, preview);
      return { previews: next };
    });
  },
  clearTilePreview: (tileId) => {
    set((state) => {
      if (!state.previews.has(tileId)) return {};
      const next = new Map(state.previews);
      next.delete(tileId);
      return { previews: next };
    });
  },
  clearAllTilePreviews: () => {
    set((state) => (state.previews.size === 0 ? {} : { previews: new Map<string, TilePreview>() }));
  },
});

const createProgressSlice: StateCreator<AtelierState, [], [], ProgressSlice> = (set) => ({
  tileProgress: {},
  setTileProgress: (tileId, progress) => {
    set((state) => (state.tileProgress[tileId] === progress
      ? {}
      : { tileProgress: { ...state.tileProgress, [tileId]: progress } }));
  },
  clearTileProgress: (tileId) => {
    set((state) => {
      if (!(tileId in state.tileProgress)) return {};
      const { [tileId]: _removed, ...tileProgress } = state.tileProgress;
      return { tileProgress };
    });
  },
  clearAllTileProgress: () => {
    set((state) => (Object.keys(state.tileProgress).length === 0 ? {} : { tileProgress: {} }));
  },
});

const createCharacterCardSlice: StateCreator<AtelierState, [], [], CharacterCardSlice> = (set) => ({
  cardPendingTileIds: new Set<string>(),
  setCardPending: (tileId, pending) => {
    set((state) => {
      if (state.cardPendingTileIds.has(tileId) === pending) return {};
      const next = new Set(state.cardPendingTileIds);
      if (pending) next.add(tileId);
      else next.delete(tileId);
      return { cardPendingTileIds: next };
    });
  },
});

// Auto-dismiss timers live outside the store state (they are runtime handles,
// not UI state). Tracking remaining/startedAt lets actionable toasts pause on
// hover/focus (WCAG 2.2.1) and resume on leave so the Undo affordance can't
// expire out from under the pointer.
interface ToastTimerState {
  remainingMs: number;
  startedAt: number;
  handle: number | null;
}
const toastTimers = new Map<string, ToastTimerState>();

const createToastSlice: StateCreator<AtelierState, [], [], ToastSlice> = (set, get) => {
  // Fire a toast's onDismiss exactly once — `leaving` marks that the two-phase
  // dismiss already ran it, so a manual removeToast during the fade can't
  // double-fire.
  const fireOnDismiss = (id: string) => {
    const toast = get().toasts.find((entry) => entry.id === id);
    if (toast && !toast.leaving) toast.onDismiss?.();
  };
  const dismiss = (id: string) => {
    // Two-phase dismiss: flip `leaving` so the renderer plays the fade-out,
    // then unmount after the same CSS duration so the animation can finish.
    toastTimers.delete(id);
    fireOnDismiss(id);
    set((state) => ({
      toasts: state.toasts.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)),
    }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    }, overlayExitDurationMs());
  };
  const arm = (id: string, ms: number): number =>
    window.setTimeout(() => { dismiss(id); }, ms);

  return {
    toasts: [],
    addToast: (text, tone = 'success', durationMs, action, onDismiss) => {
      // Dedup identical (text, tone) toasts already on screen. Without this,
      // mashing Generate at the concurrency cap floods the queue with the same
      // "At capacity..." soft-toast on every keystroke. The first one is enough
      // signal; the auto-dismiss timer clears it. Skip any toast already in its
      // leaving state — that one is about to disappear, so a re-trigger should
      // produce a fresh entry.
      const existing = action || onDismiss
        ? undefined
        : get().toasts.find((toast) => toast.text === text && toast.tone === tone && !toast.leaving);
      if (existing) return existing.id;
      const id = `toast-${crypto.randomUUID()}`;
      const effectiveDurationMs = durationMs ?? (tone === 'error' ? 6000 : tone === 'soft' ? 3500 : 2000);
      set((state) => ({ toasts: [...state.toasts, { id, text, tone, ...(action ? { action } : {}), ...(onDismiss ? { onDismiss } : {}) }] }));
      toastTimers.set(id, { remainingMs: effectiveDurationMs, startedAt: Date.now(), handle: arm(id, effectiveDurationMs) });
      return id;
    },
    removeToast: (id) => {
      const timer = toastTimers.get(id);
      if (timer?.handle != null) window.clearTimeout(timer.handle);
      toastTimers.delete(id);
      fireOnDismiss(id);
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    },
    pauseToast: (id) => {
      const timer = toastTimers.get(id);
      if (timer?.handle == null) return;
      window.clearTimeout(timer.handle);
      const elapsed = Date.now() - timer.startedAt;
      toastTimers.set(id, { ...timer, handle: null, remainingMs: Math.max(0, timer.remainingMs - elapsed) });
    },
    resumeToast: (id) => {
      const timer = toastTimers.get(id);
      if (timer?.handle !== null) return;
      toastTimers.set(id, { ...timer, startedAt: Date.now(), handle: arm(id, timer.remainingMs) });
    },
  };
};

export const useAtelierStore = create<AtelierState>()((...a) => ({
  ...createComposerSlice(...a),
  ...createBatchSelectionSlice(...a),
  ...createAutoScrollSlice(...a),
  ...createUiSlice(...a),
  ...createByokSlice(...a),
  ...createSaveTemplateSlice(...a),
  ...createPromptLibraryUiSlice(...a),
  ...createViewSlice(...a),
  ...createLightboxSlice(...a),
  ...createToastSlice(...a),
  ...createPreviewsSlice(...a),
  ...createProgressSlice(...a),
  ...createCharacterCardSlice(...a),
}));

useAtelierStore.subscribe((state, previousState) => {
  if (state.draft.rollQueue === previousState.draft.rollQueue) return;
  persistRollQueue(state.draft.rollQueue);
});

// Exported for test isolation. Use as:
//   useAtelierStore.setState(initialAtelierState, true)
// This resets all data fields to their initial values while preserving action
// closure references (they are captured from the same initializer invocation).
export const initialAtelierState: AtelierState = useAtelierStore.getInitialState();

export function toGenerateRequest(
  draft: ComposerDraft,
  modelId: string,
  ratio: Ratio,
  model?: Model,
  durationFrames?: VideoDurationFrames,
): GenerateRequest {
  const supportsI2V = model?.supportsI2V === true;
  const readyRefIds = draft.refImages.every((ref) => ref.status === 'ready')
    ? draft.refImages.map((ref) => ref.serverId).filter((id): id is string => typeof id === 'string')
    : [];
  const motionPrompt = draft.motionPrompt?.trim();
  return {
    // The H3 video workflow's only text conditioning is the motion prompt, so
    // for I2V it IS the wire prompt (the generic image prompt is hidden + unused).
    // Keeps the request valid against the server's `prompt.min(1)` schema.
    prompt: supportsI2V ? (motionPrompt ?? '') : draft.prompt.trim(),
    modelId,
    ratio,
    count: supportsI2V ? 1 : draft.count,
    ...(readyRefIds.length > 0 ? { refImageIds: readyRefIds } : {}),
    ...(supportsI2V && draft.i2vSourceUploadId ? { i2vSourceUploadId: draft.i2vSourceUploadId } : {}),
    ...(supportsI2V && draft.extendsTileId ? { extendsTileId: draft.extendsTileId } : {}),
    ...(supportsI2V && motionPrompt ? { motionPrompt } : {}),
    // Sent for every video row (T2V included), never for image models — the
    // server rejects a duration the selected model does not declare.
    ...(model?.outputsVideo === true && durationFrames !== undefined ? { durationFrames } : {}),
    ...(draft.provenance ? { provenance: draft.provenance } : {}),
  };
}


/**
 * Uploads the composer still has attached, plus every upload held by work not
 * yet accepted (`workHeldUploadIds`). Thread deletes send these as
 * `keepUploads`: the server releases a deleted thread's reference media, and
 * chips survive a submit, so without the hold the next generation would lose
 * them.
 */
export function heldUploadIds(): string[] {
  const { refImages, i2vSourceUploadId } = useAtelierStore.getState().draft;
  const ids = refImages.map((ref) => ref.serverId).filter((id): id is string => typeof id === 'string');
  if (i2vSourceUploadId) ids.push(i2vSourceUploadId);
  for (const hold of undoUploadHolds) ids.push(...hold);
  ids.push(...workHeldUploadIds());
  return [...new Set(ids)];
}

// Uploads removed from the draft but still restorable by a pending Undo toast.
const undoUploadHolds = new Set<readonly string[]>();

/** The uploads a press's settings reference: its refs, I2V source and extend handoff. */
export function submissionUploadIds(submission: RollSubmission | undefined): string[] {
  if (!submission) return [];
  const { request, motionFields } = submission;
  const ids = [...(request.refImageIds ?? [])];
  if (request.i2vSourceUploadId) ids.push(request.i2vSourceUploadId);
  if (motionFields.extendContext) ids.push(motionFields.extendContext.handoffUploadId);
  return ids;
}

// Uploads of presses made but not yet queued or accepted (buffering, preparing,
// waiting for their turn or their answer), of rolls a drain has consumed from
// the queue for a pass, and of cleared rolls a pending Undo can restore.
const pendingUploadHolds = new Set<readonly string[]>();

/**
 * Uploads still needed by work not yet accepted: queued rolls' own settings
 * and pending holds. Queued rolls survive Stop and reload in the queue, so
 * their uploads stay held there too.
 */
export function workHeldUploadIds(): Set<string> {
  const ids = new Set<string>();
  for (const roll of useAtelierStore.getState().draft.rollQueue) {
    for (const id of submissionUploadIds(roll.submission)) ids.add(id);
  }
  for (const hold of pendingUploadHolds) {
    for (const id of hold) ids.add(id);
  }
  return ids;
}

/** Holds a press's uploads until the returned function runs (idempotent). */
export function holdSubmissionUploads(submissions: readonly (RollSubmission | undefined)[]): () => void {
  const hold = [...new Set(submissions.flatMap(submissionUploadIds))];
  if (hold.length === 0) return () => undefined;
  pendingUploadHolds.add(hold);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingUploadHolds.delete(hold);
  };
}

/** Holds `ids` against thread-delete release; call the returned function once the Undo settles. */
export function holdUploadsForUndo(ids: readonly string[]): () => void {
  if (ids.length === 0) return () => undefined;
  const hold = [...ids];
  undoUploadHolds.add(hold);
  return () => {
    undoUploadHolds.delete(hold);
  };
}

/**
 * Draft-level submit gating for the Composer (its button and the Cmd/Ctrl+Enter
 * on its prompt fields), so neither path can bypass the visible guards. With
 * uploading or errored chips the request would silently drop refImageIds and
 * start a text-only generation; with chips against an unsupporting model the
 * server's 400 would race the optimistic client state.
 */
export function canSubmitDraft(
  draft: Pick<ComposerDraft, 'refImages' | 'i2vSourceUploadId' | 'motionPrompt'>,
  model: { supportsReferenceImages?: boolean; supportsI2V?: boolean } | undefined,
): boolean {
  if (model?.supportsI2V === true) {
    // Video batches need a source still AND a motion prompt: the motion prompt
    // is the H3 workflow's only text conditioning (it becomes the wire prompt).
    return Boolean(draft.i2vSourceUploadId) && Boolean(draft.motionPrompt?.trim());
  }
  if (draft.refImages.length === 0) return true;
  if (draft.refImages.some((r) => r.status !== 'ready')) return false;
  return model?.supportsReferenceImages === true;
}

export function quotaToastMessage(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null) return 'Codex quota exhausted — try again later';
  const mins = Math.max(1, Math.round(retryAfterSeconds / 60));
  return `Codex quota exhausted — retry in ~${String(mins)} min`;
}
