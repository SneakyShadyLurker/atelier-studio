import { isVideoMime } from '@atelier/shared';
import type { ArchivedTile, Batch, Collection, DoneTile, GenerateRequest, Ratio, Tile, VideoDurationFrames } from '@atelier/shared';
import { resolveDuration } from './lib/durations';
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HISTORY_WRITE_MUTATION_KEY } from './hooks/historyWrites';
import { useDebouncedValue } from './hooks/useDebouncedValue';
import { resolveActiveBatchId } from './lib/burstFollow';
import { describeError } from './lib/errorCopy';
import { composerPrefsFromDraft, saveComposerPrefs } from './lib/composerPrefs';
import { resolveEffectiveModel } from './lib/effectiveModel';
import { buildHistoricalRequest, isRetiredHistoricalModel, RETIRED_MODEL_TOAST, type HistoricalReplay } from './lib/historicalGeneration';
import { findI2VModel } from './lib/i2v';
import { modelSelectionPatch, promptPickerAvailable, VIDEO_DRAFT_RESET } from './lib/modelSelection';
import { shouldShowComposer } from './lib/viewChrome';
import Canvas, { type CanvasHandle } from './components/Canvas';
import Composer from './components/Composer';
import { runWhenReachable } from './lib/focus';
import ConfirmDialog from './components/ConfirmDialog';
import StoryDialog, { type StoryDialogSource } from './components/StoryDialog';
import SaveTemplateDialog from './components/SaveTemplateDialog';
import CharacterCardDialog from './components/CharacterCardDialog';
import Sidebar from './components/Sidebar';
import Toast from './components/Toast';
import ModerationNotice from './components/ModerationNotice';
import { ErrorBoundary } from './components/ErrorBoundary';
import { StateView } from './components/StateView';
import { PromptDraftProvider } from './components/PromptManager/draftStore';
import { LazyFallback } from './components/LazyFallback';
import { I } from './components/icons/I';
import { usePromptLibrary } from './hooks/usePromptLibrary';
import { useTextProviders } from './hooks/useTextProviders';
import { useArchiveQuery } from './hooks/useArchiveQuery';
import { useClearAll, clearAllConfirmCopy } from './hooks/useClearAll';
import { useCollections } from './hooks/useCollections';
import { useDeleteBatch } from './hooks/useDeleteBatch';
import { useDeleteTile } from './hooks/useDeleteTile';
import { useDownload } from './hooks/useDownload';
import { useDownloadSequenceMaster } from './hooks/useDownloadSequenceMaster';
import { useDiscardSequenceTail } from './hooks/useDiscardSequenceTail';
import { useGenerate } from './hooks/useGenerate';
import { useHistory } from './hooks/useHistory';
import { useIsPhone } from './hooks/useIsPhone';
import { useKeyboard } from './hooks/useKeyboard';
import { useTooltipDismiss } from './hooks/useTooltipDismiss';
import { useModels } from './hooks/useModels';
import { useAnimateFromTile, useUploadTileSource } from './hooks/useAnimateFromTile';
import { useCancel } from './hooks/useCancel';
import { useEditFromTile } from './hooks/useEditFromTile';
import { pendingCardRequest, useCharacterCardFromTile } from './hooks/useCharacterCardFromTile';
import { useEphemera } from './hooks/useEphemera';
import { usePermanentDelete } from './hooks/usePermanentDelete';
import { usePurgeArchive } from './hooks/usePurgeArchive';
import { useRollQueueSubmit } from './hooks/useRollQueueSubmit';
import { useRestore } from './hooks/useRestore';
import { useSidebarFocusChoreography } from './hooks/useSidebarFocusChoreography';
import { useFocusTrap } from './hooks/useFocusTrap';
import { useSidebarCollapsed } from './hooks/useSidebarCollapsed';
import { useTheme } from './hooks/useTheme';
import { useUrlState } from './store/urlState';
import { historyKeys } from './api/history';
import { collectionKeys } from './api/collections';
import { createHandoffFrame, sequenceMasterUrl } from './api/sequences';
import { cancelStory as cancelStoryRequest } from './api/stories';
import { formatSequenceDuration } from './lib/videoSequences';
import {
  APP_VIEW_UNSORTED,
  useAtelierStore,
  type AppView,
  type Count,
} from './store/atelier';
import styles from './App.module.css';

// Stable empty fallback so Canvas's `collections` prop keeps a constant
// reference while the query has no data — a fresh `[]` each render would
// defeat memo(Canvas).
const EMPTY_COLLECTIONS: readonly Collection[] = [];

function buildArchiveLightboxBatch(
  tile: ArchivedTile,
  archiveItems: readonly ArchivedTile[],
): Batch {
  const tiles = archiveItems
    .filter((item) => item.batchId === tile.batchId)
    .map((item) => ({
      id: item.id,
      seed: item.seed,
      status: 'done' as const,
      url: item.url,
      ...(item.thumbUrl ? { thumbUrl: item.thumbUrl } : {}),
      ext: item.ext,
      mime: item.mime,
      completedAt: item.completedAt,
      ...(item.refImageIds && item.refImageIds.length > 0 ? { refImageIds: item.refImageIds } : {}),
    }));
  return {
    id: tile.batchId,
    prompt: tile.prompt,
    ratio: tile.ratio,
    modelId: 'archive',
    modelLabel: tile.modelLabel,
    createdAt: tile.archivedAt,
    collectionId: null,
    pinned: false,
    status: 'done',
    tiles,
  };
}

const Archive = lazy(() => import('./components/Archive'));
const PromptManager = lazy(() => import('./components/PromptManager'));
const TextModels = lazy(() => import('./components/TextModels'));
const Lightbox = lazy(() => import('./components/Lightbox'));
const LazyByokDialog = lazy(() =>
  import('./components/ByokDialog').then((m) => ({ default: m.ByokDialog })),
);

function AppContent() {
  const queryClient = useQueryClient();
  const sidebarRef = useRef<HTMLElement | null>(null);
  const hamburgerRef = useRef<HTMLButtonElement | null>(null);
  const promptLibrary = usePromptLibrary();
  const promptsEnabled = promptLibrary.enabled;
  const textAdmin = useTextProviders();
  useUrlState(promptLibrary.gated, textAdmin.gated);
  const draft = useAtelierStore((state) => state.draft);
  const activeBatchId = useAtelierStore((state) => state.activeBatchId);
  const lightbox = useAtelierStore((state) => state.lightbox);
  const requestedView = useAtelierStore((state) => state.view);
  // The store and URL own navigation. React defers only its rendering snapshot;
  // startTransition cannot make an external-store mutation nonblocking.
  const view = useDeferredValue(requestedView);
  const isViewPending = view !== requestedView;
  const q = useAtelierStore((state) => state.q);
  const sidebarOpen = useAtelierStore((state) => state.sidebarOpen);
  const composerExpanded = useAtelierStore((state) => state.composerExpanded);
  const setDraft = useAtelierStore((state) => state.setDraft);
  const setActiveBatchId = useAtelierStore((state) => state.setActiveBatchId);
  const setView = useAtelierStore((state) => state.setView);
  const setSidebarOpen = useAtelierStore((state) => state.setSidebarOpen);
  const setComposerExpanded = useAtelierStore((state) => state.setComposerExpanded);
  const toggleSidebar = useAtelierStore((state) => state.toggleSidebar);
  const openLightbox = useAtelierStore((state) => state.openLightbox);
  const openMasterLightbox = useAtelierStore((state) => state.openMasterLightbox);
  const closeLightbox = useAtelierStore((state) => state.closeLightbox);
  const addToast = useAtelierStore((state) => state.addToast);
  const openSaveTemplate = useAtelierStore((state) => state.openSaveTemplate);
  const reopenBatchInPicker = useAtelierStore((state) => state.reopenBatchInPicker);
  const byokOpen = useAtelierStore((state) => state.byokOpen);
  const followAnchorId = useAtelierStore((state) => state.followAnchorId);
  const clearFollowAnchor = useAtelierStore((state) => state.clearFollowAnchor);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [lightboxPermanentDeleteTileId, setLightboxPermanentDeleteTileId] = useState<string | null>(null);
  const [discardTailBatch, setDiscardTailBatch] = useState<Batch | null>(null);
  const [storySource, setStorySource] = useState<StoryDialogSource | null>(null);
  const [cardTile, setCardTile] = useState<DoneTile | null>(null);
  const [composerResetKey, setComposerResetKey] = useState(0);
  const [canvasResetKey, setCanvasResetKey] = useState(0);

  const modelsQuery = useModels();
  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);
  const modelById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  // Trailing-edge debounce of the value feeding the history infinite query +
  // Canvas reconcile. The search input stays bound to the immediate store `q`
  // so typing is responsive; only this lagged value drives the query KEY, so
  // search-typing issues ONE /history request after input settles rather than
  // one per keystroke (useDeferredValue does NOT bound network requests — per
  // React docs debounce is the right tool here). The SSE-scope desync is
  // handled structurally by useGenerate's pinned write key + the broad
  // invalidate-on-settle, not by this value.
  const debouncedQ = useDebouncedValue(q, 250);
  const historyQuery = useHistory(view, debouncedQ);
  const archiveScope = view.kind === 'archive' ? view.scope : undefined;
  const archiveQuery = useArchiveQuery(archiveScope, view.kind === 'archive');
  const collectionsQuery = useCollections();

  // Stable load-more handlers shared across InfiniteStatus mounts.
  // `fetchNextPage` is bound on the observer, so the callbacks keep their
  // identity across (SSE-driven) parent renders. `cancelRefetch: false` reuses
  // any running fetch instead of cancelling it, which covers both same-frame
  // double-fires from sibling observers (Sidebar+Canvas share the same
  // historyQuery on desktop) and background refetches after mutations.
  const fetchNextHistory = historyQuery.fetchNextPage;
  const fetchNextArchive = archiveQuery.fetchNextPage;
  const onHistoryLoadMore = useCallback(() => {
    void fetchNextHistory({ cancelRefetch: false });
  }, [fetchNextHistory]);
  const onArchiveLoadMore = useCallback(() => {
    void fetchNextArchive({ cancelRefetch: false });
  }, [fetchNextArchive]);
  const generate = useGenerate(modelById);
  const editFromTile = useEditFromTile();
  const animateFromTile = useAnimateFromTile();
  const uploadTileSource = useUploadTileSource();
  const storyPrepRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    storyPrepRef.current?.abort(new DOMException('app unmounted', 'AbortError'));
  }, []);
  const handleEditTile = useCallback(
    (batch: Batch, tile: DoneTile) => {
      const model = modelById.get(batch.modelId);
      return model
        ? editFromTile(tile, model, { focusPrompt: true, ratio: batch.ratio })
        : Promise.resolve(false);
    },
    [editFromTile, modelById],
  );
  // Ephemera character cards: the action exists only while the probe says the
  // integration is on for this user; the store owns the per-tile pending set.
  // The action opens the optional steering dialog; its submit starts the card.
  const ephemera = useEphemera();
  const createCardFromTile = useCharacterCardFromTile();
  const cardPendingTileIds = useAtelierStore((state) => state.cardPendingTileIds);
  const handleCreateCardTile = useCallback(
    (_batch: Batch, tile: DoneTile) => {
      setCardTile(tile);
      return Promise.resolve(true);
    },
    [],
  );
  // The single image→video model (if any) backs the grid + lightbox Animate
  // action. Bound once here so the handler threaded through Canvas stays
  // referentially stable for BatchView's memoized row.
  const i2vModel = useMemo(() => findI2VModel(models), [models]);
  const handleAnimateTile = useCallback(
    (batch: Batch, tile: DoneTile) =>
      i2vModel
        ? animateFromTile(tile, i2vModel, { focusMotion: true, sourcePrompt: batch.prompt, ratio: batch.ratio })
        : Promise.resolve(false),
    [animateFromTile, i2vModel],
  );
  const handleTellStoryTile = useCallback(async (
    batch: Batch,
    tile: DoneTile,
  ): Promise<boolean> => {
    if (storyPrepRef.current !== null) return false;
    const controller = new AbortController();
    storyPrepRef.current = controller;
    try {
      if (isVideoMime(tile.mime)) {
        const handoff = await createHandoffFrame(tile.id, controller.signal);
        if (controller.signal.aborted) return false;
        setStorySource({
          mode: 'extend',
          sourceUploadId: handoff.uploadId,
          extendsTileId: tile.id,
          ratio: batch.ratio,
        });
      } else {
        const sourceUploadId = await uploadTileSource(tile);
        if (controller.signal.aborted) return false;
        setStorySource({
          mode: 'i2v',
          sourceUploadId,
          sourcePrompt: batch.prompt,
          ratio: batch.ratio,
        });
      }
      return true;
    } catch (error) {
      if (!controller.signal.aborted) {
        addToast(describeError(error, "Couldn't prepare the story source."), 'error');
      }
      return false;
    } finally {
      if (storyPrepRef.current === controller) storyPrepRef.current = null;
    }
  }, [addToast, uploadTileSource]);
  const clearAll = useClearAll({ activeView: view });
  const { cancelBatch: cancelBatchForStory } = useCancel({ activeView: view, q: debouncedQ });
  const cancelStoryMutate = useMutation({
    mutationKey: HISTORY_WRITE_MUTATION_KEY,
    mutationFn: async (storyId: string) => {
      const result = await cancelStoryRequest(storyId);
      if (result.inflightBatchId !== null) await cancelBatchForStory(result.inflightBatchId);
      await queryClient.invalidateQueries({ queryKey: historyKeys.all() });
    },
    onSuccess: () => { addToast('Story canceled'); },
    onError: (error) => { addToast(describeError(error, "Couldn't cancel the story."), 'error'); },
  }).mutate;
  const deleteBatch = useDeleteBatch({ activeView: view, q: debouncedQ });
  const deleteTile = useDeleteTile({ activeView: view, q: debouncedQ });
  const discardTailMutate = useDiscardSequenceTail().mutate;
  const restore = useRestore();
  const downloadMasterMutate = useDownloadSequenceMaster().mutate;
  const permanentDelete = usePermanentDelete();
  const purgeArchive = usePurgeArchive();
  const download = useDownload();
  const { theme, toggle: toggleTheme } = useTheme();
  const { collapsed: sidebarCollapsed, toggle: toggleSidebarCollapsed } = useSidebarCollapsed();
  const isPhone = useIsPhone();
  const archiveViewActive = view.kind === 'archive';
  useEffect(() => {
    if (!archiveViewActive) return;
    void queryClient.invalidateQueries({ queryKey: collectionKeys.list() });
  }, [archiveViewActive, queryClient]);
  const batches = historyQuery.batches;
  // Sidebar badge shows GLOBAL archive count regardless of the current archive
  // scope (the user expects the chip to denote total archive size, not the
  // filtered slice). archiveQuery.total is scope-filtered and powers the
  // Archive view header.
  const archivedCount = collectionsQuery.data?.summary.archivedTotalCount ?? 0;
  // Empty-archive purge is server-side unscoped (DELETE /archive wipes every
  // row, not the current view's scope), so the confirmation count must be the
  // global total — never archiveQuery.total, which is scope-filtered.
  const emptyArchiveCount = archivedCount;
  const effectiveSidebarOpen = isPhone && sidebarOpen;
  useSidebarFocusChoreography({ effectiveSidebarOpen, sidebarCollapsed, isPhone });
  useFocusTrap(sidebarRef, {
    active: effectiveSidebarOpen,
    returnFocusTo: hamburgerRef,
    autoFocus: false,
  });

  const effectiveModel = useMemo(
    () => resolveEffectiveModel(models, draft.modelId),
    [models, draft.modelId],
  );
  const effectiveModelId = effectiveModel?.id ?? '';
  const draftModelId = draft.modelId;
  // Remember the composer settings across reloads. The raw selection, not the
  // effective fallback, so an offline host's model is still restored once it
  // returns; the model's metadata keeps image-to-video rows out of storage.
  const selectedIsI2V = modelById.get(draft.modelId)?.supportsI2V === true;
  useEffect(() => {
    saveComposerPrefs(composerPrefsFromDraft(
      { modelId: draft.modelId, ratio: draft.ratio, count: draft.count, durationFrames: draft.durationFrames, lastImageModelId: draft.lastImageModelId },
      selectedIsI2V,
    ));
  }, [draft.modelId, draft.ratio, draft.count, draft.durationFrames, draft.lastImageModelId, selectedIsI2V]);
  // A boolean, not the model object, so availability polls don't churn the
  // memoized batch-action handler.
  const pickerAvailable = promptPickerAvailable(promptsEnabled, effectiveModel);
  const effectiveRatio: Ratio = draft.ratio !== null && effectiveModel?.supportedRatios.includes(draft.ratio) ? draft.ratio : effectiveModel?.defaultRatio ?? effectiveModel?.supportedRatios[0] ?? '1:1';
  const effectiveStoryRatio: Ratio = draft.ratio !== null && effectiveModel?.supportedRatios.includes(draft.ratio)
    ? draft.ratio
    : effectiveModel?.supportedRatios[0] ?? '1:1';
  // Undefined on image models — the chip is hidden and no duration is sent.
  const supportedDurations = effectiveModel?.supportedDurations;
  const effectiveDuration = supportedDurations === undefined
    ? undefined
    : resolveDuration(supportedDurations, draft.durationFrames ?? undefined, effectiveModel?.defaultDuration);
  // Single source of truth for the highlighted batch in the sidebar rail:
  // while a burst is being followed this resolves to the burst anchor (the
  // newest batch of the burst). A manual selection clears the follow anchor
  // (see selectBatch) and pins the highlight to the chosen batch.
  const effectiveActiveBatchId = useMemo(
    () => resolveActiveBatchId(batches, followAnchorId, activeBatchId),
    [batches, followAnchorId, activeBatchId],
  );
  const canvasHandleRef = useRef<CanvasHandle>(null);

  const generateFn = generate.generate;
  // Put the feed on the scope the generation stream writes into (useGenerate
  // pins its cache writes to historyKeys.list(), the default Unsorted scope) so
  // the user lands where the new batch appears. Callers own the "is this still
  // what the user wants?" decision and must invoke it from the gesture itself —
  // never from an async fire callback. A queued burst fires over many seconds,
  // and re-pinning per fire yanked the user out of whatever view they had
  // navigated to since (the Prompt Library, a collection, a search).
  const pinGenerationScope = useCallback(() => {
    const state = useAtelierStore.getState();
    if (state.view.kind !== 'unsorted') state.setView(APP_VIEW_UNSORTED);
    if (state.q !== '') state.setQ('');
  }, []);
  // `mutateAsync` rejects when mutationFn throws (NeedsKeyError, server-side
  // 429/4xx wrapped in ApiError, etc.) and the rejection is "unhandled"
  // unless the caller catches. The hook's onError is the canonical failure
  // path — these catches just keep unhandledrejection events out of the
  // console.
  const fireGenerate = useCallback((request: GenerateRequest) => {
    generateFn(request).catch(() => { /* handled in onError */ });
  }, [generateFn]);

  const { submitDraft, submitPrepared, stopDraining, retryingPrepared } = useRollQueueSubmit({
    draft,
    effectiveModel,
    effectiveRatio,
    effectiveDuration,
    generate: generateFn,
    fireGenerate,
    addToast,
    setComposerExpanded,
    library: promptLibrary.data,
    // Entitled user whose /api/prompts hasn't resolved yet: data undefined while
    // not gated. Lets the hook block raw {{var::}} instead of leaking the token.
    libraryPending: !promptLibrary.gated && promptLibrary.data === undefined,
  });

  const history = useMemo(() => ({ items: batches, nextCursor: historyQuery.hasNextPage ? 'more' : null }), [batches, historyQuery.hasNextPage]);

  // Stable mutate refs. TanStack guarantees `.mutate` is referentially
  // stable across renders; the hook-returned object is not — depending on
  // it would churn every useCallback below and defeat the BatchView memo.
  const deleteBatchMutate = deleteBatch.mutate;
  const deleteTileMutate = deleteTile.mutate;
  const downloadMutate = download.mutate;
  // Archive needs the observable outcome so a failed Restore/Delete can bring
  // its tile back; it owns catching the rejection (onError already toasts).
  const restoreMutateAsync = restore.mutateAsync;
  const permanentDeleteMutateAsync = permanentDelete.mutateAsync;
  const clearAllMutate = clearAll.mutate;
  const refetchHistory = historyQuery.refetch;
  const refetchModels = modelsQuery.refetch;
  const refetchArchive = archiveQuery.refetch;
  const onSidebarClear = useCallback(() => { setClearConfirmOpen(true); }, []);
  const onSidebarRetry = useCallback(() => { void refetchHistory(); }, [refetchHistory]);
  const onHistoryRetry = useCallback(() => { void refetchHistory(); }, [refetchHistory]);
  const onArchiveRetry = useCallback(() => { void refetchArchive(); }, [refetchArchive]);
  const onPromptChange = useCallback((prompt: string) => { setDraft({ prompt }); }, [setDraft]);
  const onModelChange = useCallback((modelId: string) => {
    const model = modelById.get(modelId);
    if (modelId === effectiveModelId) {
      // Re-selecting the current model keeps count/ratio, but a non-I2V
      // selection still drops any leftover animate/extend state.
      if (model?.supportsI2V !== true) setDraft(VIDEO_DRAFT_RESET);
      // Picking the model shown as a fallback is an explicit choice: it
      // replaces a remembered selection that is offline or gone, so that one
      // no longer comes back when its host returns or after a reload.
      if (draftModelId !== modelId) {
        // Through the selection owner, but keeping the count and ratio the
        // composer already shows for this model.
        const patch = modelSelectionPatch(modelId, model);
        delete patch.count;
        delete patch.ratio;
        setDraft(patch);
      }
      return;
    }
    setDraft(modelSelectionPatch(modelId, model));
  }, [setDraft, modelById, effectiveModelId, draftModelId]);
  const onRatioChange = useCallback((ratio: Ratio) => { setDraft({ ratio }); }, [setDraft]);
  const onDurationChange = useCallback((durationFrames: VideoDurationFrames) => { setDraft({ durationFrames }); }, [setDraft]);
  const onCountChange = useCallback((count: Count) => { setDraft({ count }); }, [setDraft]);
  const onRetryModels = useCallback(() => { void refetchModels(); }, [refetchModels]);
  const handleComposerTellStory = useCallback(() => {
    if (draft.extendsTileId !== undefined) {
      setStorySource({
        mode: 'extend',
        ...(draft.i2vSourceUploadId ? { sourceUploadId: draft.i2vSourceUploadId } : {}),
        extendsTileId: draft.extendsTileId,
        ratio: effectiveStoryRatio,
      });
      return;
    }
    if (draft.i2vSourceUploadId !== undefined) {
      setStorySource({
        mode: 'i2v',
        sourceUploadId: draft.i2vSourceUploadId,
        ...(draft.i2vSourcePrompt ? { sourcePrompt: draft.i2vSourcePrompt } : {}),
        ratio: effectiveStoryRatio,
      });
      return;
    }
    setStorySource({ mode: 't2v', ratio: effectiveStoryRatio });
  }, [draft.extendsTileId, draft.i2vSourcePrompt, draft.i2vSourceUploadId, effectiveStoryRatio]);

  const selectBatch = useCallback((batchId: string) => {
    // Manual selection exits burst-follow: pin the highlight to the chosen
    // batch and scroll directly to it.
    clearFollowAnchor();
    setActiveBatchId(batchId);
    if (isPhone) setSidebarOpen(false);
    canvasHandleRef.current?.scrollToBatch(batchId);
  }, [clearFollowAnchor, setActiveBatchId, isPhone, setSidebarOpen]);

  const selectView = useCallback((nextView: AppView) => {
    setView(nextView);
    if (isPhone) setSidebarOpen(false);
  }, [setView, isPhone, setSidebarOpen]);
  const onManagedViewBack = useCallback(() => { selectView(APP_VIEW_UNSORTED); }, [selectView]);
  const onArchiveRestore = useCallback((tileId: string) => restoreMutateAsync(tileId), [restoreMutateAsync]);
  const onArchivePermanentDelete = useCallback((tileId: string) => permanentDeleteMutateAsync(tileId), [permanentDeleteMutateAsync]);
  const onArchivePurgeAll = useCallback(() => { setConfirmOpen(true); }, []);
  const onArchiveOpenTile = useCallback((tile: { batchId: string; id: string }) => {
    openLightbox(tile.batchId, tile.id);
  }, [openLightbox]);

  const copyPrompt = useCallback((batch: Batch) => {
    void navigator.clipboard.writeText(batch.prompt)
      .then(() => addToast('Prompt copied'))
      .catch(() => addToast('Could not copy prompt', 'soft'));
  }, [addToast]);

  // Re-roll and Retry replay a history batch as a standalone request. A model
  // absent from a successfully fetched inventory is retired: the server would
  // only answer "unknown model", so point the user at a recoverable path.
  const modelsInventoryLoaded = modelsQuery.isSuccess;
  const replayHistorical = useCallback((batch: Batch, replay: HistoricalReplay) => {
    if (isRetiredHistoricalModel(batch.modelId, modelById, modelsInventoryLoaded)) {
      addToast(RETIRED_MODEL_TOAST, 'error', undefined, {
        label: 'Copy prompt',
        onClick: () => { copyPrompt(batch); },
      });
      return;
    }
    pinGenerationScope();
    submitPrepared(buildHistoricalRequest(batch, replay));
  }, [modelById, modelsInventoryLoaded, addToast, copyPrompt, pinGenerationScope, submitPrepared]);

  const handleBatchAction = useCallback((action: 'copy' | 'reroll' | 'delete' | 'saveTemplate' | 'reopen' | 'playMaster' | 'downloadMaster' | 'discardSequenceTail' | 'cancelStory', batch: Batch) => {
    if (action === 'cancelStory') {
      const story = batch.story;
      if (!story) return;
      cancelStoryMutate(story.id);
      return;
    }
    if (action === 'playMaster') {
      const sequence = batch.sequence;
      const tile = batch.tiles.find((candidate): candidate is DoneTile =>
        candidate.status === 'done' && isVideoMime(candidate.mime));
      if (sequence && tile) openMasterLightbox(batch.id, tile.id, sequence.id);
      return;
    }
    if (action === 'downloadMaster') {
      if (batch.sequence) downloadMasterMutate({ batch, sequence: batch.sequence });
      return;
    }
    if (action === 'discardSequenceTail') {
      setDiscardTailBatch(batch);
      return;
    }
    if (action === 'saveTemplate') {
      openSaveTemplate(batch.prompt);
      return;
    }
    if (action === 'reopen') {
      if (batch.provenance) {
        // The picker renders only behind the library gate and outside video
        // mode; opening it there would report success with nothing visible,
        // then pop the stale template open on the next image-model switch.
        // The video draft is kept: the user chooses when to leave it.
        if (!pickerAvailable) {
          addToast(promptsEnabled ? 'Switch to an image model to reopen templates' : 'Templates aren’t available right now', 'soft', 1800);
          return;
        }
        const opened = reopenBatchInPicker(batch.provenance);
        if (!opened) {
          // Picker render is gated `promptPickerOpen && !enhancing`; opening
          // mid-enhance would hide it then pop it open when enhance ends.
          addToast('Finish enhancing first', 'soft', 1800);
          return;
        }
        setComposerExpanded(true); // phone: surface the composer so the now-open picker is visible
        addToast('Reopened in picker', 'soft', 1800);
      }
      return;
    }
    if (action === 'copy') {
      copyPrompt(batch);
      return;
    }
    if (action === 'reroll') {
      // Multi-flight: re-rolls run concurrently with any in-flight stream
      // up to the cap. At-cap rejections surface as a toast via onError.
      replayHistorical(batch, { kind: 'reroll' });
      return;
    }
    deleteBatchMutate({ batchId: batch.id });
  }, [openMasterLightbox, downloadMasterMutate, openSaveTemplate, copyPrompt, replayHistorical, deleteBatchMutate, reopenBatchInPicker, setComposerExpanded, addToast, cancelStoryMutate, promptsEnabled, pickerAvailable]);

  const handleTileAction = useCallback((action: 'download' | 'delete' | 'retry' | 'dismiss', batch: Batch, tile: Tile) => {
    if (action === 'retry') {
      // Multi-flight: retries run concurrently up to the cap; at-cap
      // rejections surface as a toast via onError.
      const seed = new Uint32Array(1);
      crypto.getRandomValues(seed);
      replayHistorical(batch, { kind: 'retry', tile, seed: seed[0] ?? 0 });
      return;
    }
    if (action === 'download' && tile.status === 'done') {
      downloadMutate({ batch, tile });
      return;
    }
    const intent: 'archive' | 'dismiss' = action === 'dismiss' ? 'dismiss' : 'archive';
    if (batch.tiles.length <= 1) {
      deleteBatchMutate({ batchId: batch.id, intent });
      return;
    }
    deleteTileMutate({ batchId: batch.id, tileId: tile.id, intent });
  }, [replayHistorical, downloadMutate, deleteBatchMutate, deleteTileMutate]);

  // Hoisted out of the Canvas JSX so BatchView's memo isn't defeated by a
  // fresh inline closure every App render.
  const handleOpenTile = useCallback(
    (batch: Batch, tile: DoneTile) => { openLightbox(batch.id, tile.id); },
    [openLightbox],
  );

  // Memoized: `batches` reallocates on every SSE tile event (historyCache
  // .map's the items list), so a bare `find` returns a fresh Batch reference
  // per render and defeats Lightbox's batch-keyed memos. Parity with the
  // archiveLightboxBatch memo below.
  const lightboxBatch = useMemo(
    () => (lightbox ? batches.find((batch) => batch.id === lightbox.batchId) : undefined),
    [lightbox, batches],
  );
  // Memoized: this synthetic Batch is rebuilt only when the archive lightbox
  // target changes — not on every SSE-driven App render — so Lightbox's
  // `batch`-keyed memos aren't defeated mid-generation.
  const archiveLightboxBatch = useMemo<Batch | undefined>(() => {
    const tile = lightbox && view.kind === 'archive'
      ? archiveQuery.items.find((item) => item.id === lightbox.tileId)
      : undefined;
    if (!tile) return undefined;
    return buildArchiveLightboxBatch(tile, archiveQuery.items);
  }, [lightbox, view.kind, archiveQuery.items]);
  const resolveKeyboardLightboxBatch = useCallback((batchId: string) => {
    if (archiveLightboxBatch?.id === batchId) return archiveLightboxBatch;
    return batches.find((batch) => batch.id === batchId);
  }, [archiveLightboxBatch, batches]);
  useKeyboard(resolveKeyboardLightboxBatch);
  useTooltipDismiss();
  const visibleLightboxBatch = view.kind === 'archive' ? archiveLightboxBatch : lightboxBatch;
  const visibleMasterSequence = lightbox?.masterSequenceId !== undefined
    && visibleLightboxBatch?.sequence?.id === lightbox.masterSequenceId
    ? visibleLightboxBatch.sequence
    : undefined;
  const lightboxMaster = lightbox?.masterSequenceId !== undefined && visibleLightboxBatch && visibleMasterSequence
    ? {
        url: sequenceMasterUrl(lightbox.masterSequenceId),
        durationLabel: formatSequenceDuration(visibleMasterSequence.totalDurationFrames),
        onDownload: () => { downloadMasterMutate({ batch: visibleLightboxBatch, sequence: visibleMasterSequence }); },
      }
    : undefined;
  const pendingLightboxDeleteTileId = lightbox ? lightboxPermanentDeleteTileId : null;
  const modelError = modelsQuery.isError ? describeError(modelsQuery.error, 'Models unavailable') : null;
  const historyError = historyQuery.isError ? describeError(historyQuery.error, 'History unavailable') : null;
  const archiveError = archiveQuery.isError ? describeError(archiveQuery.error, 'Archive unavailable') : null;

  // Any open overlay above the main shell (sidebar drawer on mobile, lightbox,
  // app-level confirm) inerts the underlying content. The Sidebar is inerted
  // when an overlay above IT is open too — its collection-delete ConfirmDialog
  // inerts siblings self-portal-side, but for the lightbox + main confirm
  // path we still need to lock the Sidebar from this level.
  // keepPreviousData holds the prior search/scope results visible while the new
  // key fetches; dim them (same treatment as the view-kind transition) so the
  // stale state reads as "refreshing", not "current". Main history feed only —
  // Archive deliberately opts out (irreversible actions, see archiveOpts).
  const isFeedStale = view.kind !== 'archive'
    && view.kind !== 'prompts'
    && view.kind !== 'text-models'
    && historyQuery.isPlaceholderData;
  const mainInert = effectiveSidebarOpen || lightbox !== null || confirmOpen || clearConfirmOpen || discardTailBatch !== null || storySource !== null;
  const sidebarInert = (isPhone && !effectiveSidebarOpen) || lightbox !== null || confirmOpen || clearConfirmOpen || discardTailBatch !== null || storySource !== null || (!isPhone && sidebarCollapsed);
  const feedInert = isPhone && composerExpanded && shouldShowComposer(view);

  // Scoped fallback for the lazy full-screen views (Archive, PromptManager):
  // a render or chunk-load error in one of them stays contained — the feed and
  // composer keep their state, and "Back to feed" remounts the view fresh via
  // the viewSwap key change.
  const viewErrorFallback = (
    <StateView
      role="status"
      glyph={<I.alert width={22} height={22} />}
      title="This view hit an error"
      body="The rest of Atelier is unaffected — head back to the feed."
      action={{ label: 'Back to feed', onClick: () => { selectView(APP_VIEW_UNSORTED); } }}
    />
  );
  const handleCanvasReset = useCallback(() => {
    void queryClient.resetQueries({ queryKey: historyKeys.scoped(view, debouncedQ) });
    setCanvasResetKey((key) => key + 1);
  }, [debouncedQ, queryClient, view]);
  const canvasErrorFallback = (
    <StateView
      role="status"
      glyph={<I.alert width={22} height={22} />}
      title="Feed unavailable"
      body="The image feed hit an error — click to reload."
      action={{ label: 'Reload feed', onClick: handleCanvasReset }}
    />
  );
  const composerErrorFallback = (
    <StateView
      role="status"
      glyph={<I.alert width={22} height={22} />}
      title="Composer unavailable"
      body="Composer hit an error — click to reload the composer area."
      action={{ label: 'Reload composer', onClick: () => { setComposerResetKey((key) => key + 1); } }}
    />
  );
  // Lightbox is lazy() + has the most complex render logic (pointer-gesture
  // math, blob fetch); without this boundary a render or chunk-load error
  // escapes to the root boundary and tears down the whole SPA, losing composer
  // draft + feed scroll. Closing returns to the feed with all state intact;
  // resetKeys=[lightbox.tileId] clears a latched error when the user navigates
  // to a different tile, without remounting the viewer per tile step.
  const lightboxErrorFallback = (
    <StateView
      role="status"
      glyph={<I.alert width={22} height={22} />}
      title="Image view unavailable"
      body="The viewer hit an error — the rest of Atelier is unaffected."
      action={{ label: 'Back to feed', onClick: () => { setLightboxPermanentDeleteTileId(null); closeLightbox(); } }}
    />
  );

  return (
    <div
      className={styles.app}
      {...(sidebarCollapsed ? { 'data-sidebar-collapsed': 'true' } : {})}
      {...(isViewPending ? { 'data-view-pending': 'true' } : {})}
    >
      <h1 className="srOnly">Atelier</h1>
      <a
        className={styles.skipLink}
        href="#atelier-composer"
        onClick={() => {
          setComposerExpanded(true);
          runWhenReachable(() => { document.querySelector<HTMLTextAreaElement>('#atelier-composer textarea')?.focus(); });
        }}
      >Skip to composer</a>
      <Sidebar
        ref={sidebarRef}
        id="atelier-sidebar"
        dataOpen={effectiveSidebarOpen}
        inertClosed={sidebarInert}
        history={history}
        models={models}
        activeBatchId={effectiveActiveBatchId}
        historyQ={debouncedQ}
        archivedCount={archivedCount}
        promptsEnabled={promptsEnabled}
        textModelsEnabled={textAdmin.enabled}
        theme={theme}
        error={historyError}
        historyReadOnly={isFeedStale || isViewPending}
        hasNextPage={historyQuery.hasNextPage}
        isFetchingNextPage={historyQuery.isFetchingNextPage}
        isFetchNextPageError={historyQuery.isFetchNextPageError}
        onSelect={selectBatch}
        onSelectView={selectView}
        onClear={onSidebarClear}
        onToggleTheme={toggleTheme}
        onRetry={onSidebarRetry}
        onLoadMore={onHistoryLoadMore}
        collapsed={sidebarCollapsed}
        onCollapse={toggleSidebarCollapsed}
      />
      <button
        ref={hamburgerRef}
        type="button"
        className={styles.hamburger}
        aria-label={isPhone ? 'Open menu' : 'Expand sidebar'}
        aria-controls="atelier-sidebar"
        aria-expanded={isPhone ? effectiveSidebarOpen : false}
        tabIndex={effectiveSidebarOpen ? -1 : undefined}
        onClick={isPhone ? toggleSidebar : toggleSidebarCollapsed}
      >
        <I.menu />
      </button>
      <button
        type="button"
        className={styles.backdrop}
        data-open={effectiveSidebarOpen ? 'true' : 'false'}
        aria-hidden
        tabIndex={-1}
        onClick={() => { setSidebarOpen(false); }}
      />
      <main className={styles.main} inert={mainInert || undefined}>
        <Suspense fallback={<LazyFallback label="Loading view" />}>
        <div
          className={styles.viewSwap}
          data-testid="feed"
          key={view.kind === 'collection' ? `collection:${view.id}` : view.kind}
          {...(isFeedStale ? { 'data-stale': 'true' } : {})}
          inert={feedInert || isViewPending || undefined}
        >
          {view.kind === 'archive' ? (
            // Keyed by the archive sub-scope: the viewSwap key is only
            // view.kind, so without this an Archive error would latch the
            // boundary across every archive scope until "Back to feed".
            <ErrorBoundary key={`archive-${view.scope.kind}-${view.scope.kind === 'collection' ? view.scope.id : ''}`} fallback={viewErrorFallback}>
            <Archive
              items={archiveQuery.items}
              total={archiveQuery.total}
              isLoading={archiveQuery.isLoading}
              isError={archiveQuery.isError}
              error={archiveError}
              hasNextPage={archiveQuery.hasNextPage}
              isFetchingNextPage={archiveQuery.isFetchingNextPage}
              isFetchNextPageError={archiveQuery.isFetchNextPageError}
              onLoadMore={onArchiveLoadMore}
              onRetry={onArchiveRetry}
              onRestore={onArchiveRestore}
              onPermanentDelete={onArchivePermanentDelete}
              onPurgeAll={onArchivePurgeAll}
              onBack={onManagedViewBack}
              onOpenTile={onArchiveOpenTile}
            />
            </ErrorBoundary>
          ) : view.kind === 'prompts' && !promptLibrary.gated ? (
            <ErrorBoundary fallback={viewErrorFallback}>
                <PromptManager onBack={onManagedViewBack} />
            </ErrorBoundary>
          ) : view.kind === 'text-models' && !textAdmin.gated ? (
            <ErrorBoundary fallback={viewErrorFallback}>
              <TextModels onBack={onManagedViewBack} />
            </ErrorBoundary>
          ) : (
            <>
              {/*
                We use resetKeys, not key, so error recovery clears the boundary
                without forcing a full Canvas remount. Canvas virtualizer state
                and scroll position survive recovery.
              */}
              <ErrorBoundary resetKeys={[canvasResetKey]} fallback={canvasErrorFallback}>
                <Canvas
                  batches={batches}
                  modelById={modelById}
                  collections={collectionsQuery.data?.items ?? EMPTY_COLLECTIONS}
                  activeView={view}
                  hasNextPage={historyQuery.hasNextPage}
                  isFetchingNextPage={historyQuery.isFetchingNextPage}
                  isFetchNextPageError={historyQuery.isFetchNextPageError}
                  isLoading={historyQuery.isLoading}
                  error={historyError}
                  readOnlyActions={isFeedStale}
                  onLoadMore={onHistoryLoadMore}
                  onRetry={onHistoryRetry}
                  onBatchAction={handleBatchAction}
                  promptsEnabled={promptsEnabled}
                  onTileAction={handleTileAction}
                  onOpenTile={handleOpenTile}
                  onEditTile={handleEditTile}
                  onAnimateTile={handleAnimateTile}
                  onTellStoryTile={handleTellStoryTile}
                  onCreateCardTile={ephemera.enabled ? handleCreateCardTile : undefined}
                  cardPendingTileIds={cardPendingTileIds}
                  ref={canvasHandleRef}
                  q={debouncedQ}
                />
              </ErrorBoundary>
            </>
          )}
        </div>
        </Suspense>
        {feedInert && (
          <button
            type="button"
            className={styles.composerScrim}
            data-testid="composer-scrim"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => { setComposerExpanded(false); }}
          />
        )}
        {shouldShowComposer(view) && (
          <>
            {/*
              Match Canvas recovery: reset the boundary state without remounting
              the Composer subtree and losing local interaction state.
            */}
            <ErrorBoundary resetKeys={[composerResetKey]} fallback={composerErrorFallback}>
              <Composer
                models={models}
                modelById={modelById}
                prompt={draft.prompt}
                modelId={effectiveModelId}
                ratio={effectiveRatio}
                durationFrames={effectiveDuration}
                count={draft.count}
                disabled={modelsQuery.isError || models.length === 0}
                inFlightCap={effectiveModel?.concurrencyCapPerUser ?? 0}
                promptsEnabled={promptsEnabled}
                error={modelError}
                onPromptChange={onPromptChange}
                onModelChange={onModelChange}
                onRatioChange={onRatioChange}
                onDurationChange={onDurationChange}
                onCountChange={onCountChange}
                onSubmit={submitDraft}
                onTellStory={handleComposerTellStory}
                onStopDraining={stopDraining}
                retryingPrepared={retryingPrepared}
                onRetryModels={onRetryModels}
              />
            </ErrorBoundary>
          </>
        )}
      </main>
      {lightbox && visibleLightboxBatch && (
        <ErrorBoundary resetKeys={[lightbox.masterSequenceId ?? lightbox.tileId]} fallback={lightboxErrorFallback}>
        <Suspense fallback={<LazyFallback label="Loading image viewer" overlay />}>
        <Lightbox
          batch={visibleLightboxBatch}
          modelById={modelById}
          triggerKey={lightbox.tileId}
          deleteVariant={view.kind === 'archive' ? 'permanent' : 'archive'}
          onClose={() => {
            setLightboxPermanentDeleteTileId(null);
            closeLightbox();
          }}
          onDownload={(tile) => { download.mutate({ batch: visibleLightboxBatch, tile }); }}
          onDelete={(tile) => {
            if (view.kind === 'archive') {
              setLightboxPermanentDeleteTileId(tile.id);
            } else if (visibleLightboxBatch.tiles.length <= 1) {
              closeLightbox();
              deleteBatch.mutate({ batchId: visibleLightboxBatch.id });
            } else {
              deleteTile.mutate({ batchId: visibleLightboxBatch.id, tileId: tile.id });
            }
          }}
          {...(lightboxMaster ? { master: lightboxMaster } : {})}
        />
        </Suspense>
        </ErrorBoundary>
      )}
      {storySource && (
        <StoryDialog source={storySource} onClose={() => { setStorySource(null); }} />
      )}
      {cardTile && (
        <CharacterCardDialog
          initial={pendingCardRequest(cardTile.id)}
          onCancel={() => { setCardTile(null); }}
          onSubmit={(direction, kind) => {
            setCardTile(null);
            void createCardFromTile(cardTile, direction, kind);
          }}
        />
      )}
      {pendingLightboxDeleteTileId !== null && (
        <ConfirmDialog
          open
          title="Delete permanently?"
          body="This removes the image from disk. This cannot be undone."
          confirmLabel="Delete"
          cancelLabel="Cancel"
          danger
          closeOnBackdrop={false}
          onConfirm={() => {
            const tileId = pendingLightboxDeleteTileId;
            setLightboxPermanentDeleteTileId(null);
            permanentDelete.mutate(tileId);
          }}
          onCancel={() => { setLightboxPermanentDeleteTileId(null); }}
        />
      )}
      {confirmOpen && (
        <ConfirmDialog
          open
          title="Empty archive?"
          body={
            `This permanently deletes ${emptyArchiveCount} ${emptyArchiveCount === 1 ? 'image' : 'images'} from disk. This cannot be undone.`
          }
          confirmLabel="Delete all"
          cancelLabel="Cancel"
          danger
          closeOnBackdrop={false}
          onConfirm={() => {
            setConfirmOpen(false);
            purgeArchive.mutate();
          }}
          onCancel={() => { setConfirmOpen(false); }}
        />
      )}
      {clearConfirmOpen && (
        <ConfirmDialog
          open
          title="Archive all?"
          // No scope snapshot: `view` can only change via the sidebar nav,
          // which is `inert` while this dialog is open (sidebarInert covers
          // clearConfirmOpen), so body + mutation target stay consistent.
          body={clearAllConfirmCopy(view)}
          confirmLabel="Archive all"
          cancelLabel="Cancel"
          onConfirm={() => {
            setClearConfirmOpen(false);
            clearAllMutate();
          }}
          onCancel={() => { setClearConfirmOpen(false); }}
        />
      )}
      {discardTailBatch?.sequence && (
        <ConfirmDialog
          open
          title="Discard sequence tail?"
          body="The last clip becomes standalone and the remaining sequence master is restitched."
          confirmLabel="Discard tail"
          cancelLabel="Cancel"
          danger
          closeOnBackdrop={false}
          onConfirm={() => {
            const sequenceId = discardTailBatch.sequence?.id;
            setDiscardTailBatch(null);
            if (sequenceId) discardTailMutate(sequenceId);
          }}
          onCancel={() => { setDiscardTailBatch(null); }}
        />
      )}
      {byokOpen && (
        <Suspense fallback={<LazyFallback label="Loading key manager" overlay />}>
          <LazyByokDialog />
        </Suspense>
      )}
      <SaveTemplateDialog />
      <Toast />
      <ModerationNotice />
    </div>
  );
}

export default function App() {
  return <PromptDraftProvider><AppContent /></PromptDraftProvider>;
}
