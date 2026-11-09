// Unsorted (historyKeys.list()) is the canonical SSE channel scope — every mutation touching batch tiles must mirror the optimistic patch into Unsorted in addition to the active scope.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { isAbortError } from '../lib/abort';
import type { ApiErrorCode, Batch, GenerateRequest, Model, Tile } from '@atelier/shared';
import type { QueryKey } from '@tanstack/react-query';
import { ApiError, apiImageUrl } from '../api/client';
import { generateStream, type GenerateAcceptance } from '../api/generate';
import { collectionKeys } from '../api/collections';
import { apiErrorCode, describeError } from '../lib/errorCopy';
import { historyKeys } from '../api/history';
import { modelKeys } from '../api/models';
import { useAtelierStore } from '../store/atelier';
import { emitHistoryInvalidate, MY_TAB_ID, onHistoryCancel, onHistoryInvalidate } from './broadcastHistory';
import { HISTORY_WRITE_MUTATION_KEY, lastHistoryWriteId } from './historyWrites';
import { invalidateHistoryBehindWrites, invalidateLibrary } from './invalidateLibrary';
import { findTileInAnyScope, historyScopesWithBatch, removeBatchFromCache, removeTileFromCache, updateBatchStatus, updateBatchTile, upsertNewBatch } from './historyCache';
import { refreshHistory } from '../api/historyRefresh';
import { replaceBatchInScope } from './scopedHistoryMutation';
import { getBatch, registerBatch, unregisterBatch } from './inFlightBatches';
import { isPhoneViewport } from './useIsPhone';
import { useBackgroundCompletionTitle } from './useBackgroundCompletionTitle';
import { announceBatchSettled, announceGenerationStarted } from '../lib/queueLiveAnnouncer';
import { isDrainOwned } from '../lib/drainOwnership';

function modelLabel(modelById: ReadonlyMap<string, Model>, modelId: string): string {
  return modelById.get(modelId)?.name ?? modelId;
}

// Sentinel thrown when the SSE stream ends without a `done` event. SWAG/Authelia
// idle timeouts close long-lived SSE responses cleanly, so the for-await loop
// sees a quiet EOF — without this guard the mutation resolves successfully and
// any tiles still in `loading` would stay `loading` forever in the cache.
export class StreamTruncatedError extends Error {
  readonly batchId: string | null;
  constructor(batchId: string | null) {
    super(
      batchId === null
        ? 'generation stream ended before any batch event'
        : 'generation stream ended without a done event',
    );
    this.name = 'StreamTruncatedError';
    this.batchId = batchId;
  }
}

export class NeedsKeyError extends Error {
  constructor() {
    super('BYOK key required');
    this.name = 'NeedsKeyError';
  }
}

function isNeedsKeyApiError(error: unknown): boolean {
  return apiErrorCode(error) === ('NEEDS_GOOGLE_KEY' satisfies ApiErrorCode);
}

export interface GenerateOptions {
  // Called once the server has accepted the batch (a billable row exists),
  // before the events stream attaches. Local only; never sent to the server.
  readonly onAccepted?: (batchId: string) => void;
}

interface GenerateVariables {
  readonly request: GenerateRequest;
  readonly onAccepted?: (batchId: string) => void;
}

// `modelById` is REQUIRED with no list-scan fallback — same philosophy as the
// modelById prop lock on Batch/Canvas/Lightbox: if it's missing, the caller is
// buggy, and a silent fallback would mask that instead of surfacing it.
export function useGenerate(modelById: ReadonlyMap<string, Model>) {
  const queryClient = useQueryClient();
  const setActiveBatchId = useAtelierStore((state) => state.setActiveBatchId);
  const followBatch = useAtelierStore((state) => state.followBatch);
  const addToast = useAtelierStore((state) => state.addToast);
  const setTilePreview = useAtelierStore((state) => state.setTilePreview);
  const clearTilePreview = useAtelierStore((state) => state.clearTilePreview);
  const setTileProgress = useAtelierStore((state) => state.setTileProgress);
  const clearTileProgress = useAtelierStore((state) => state.clearTileProgress);
  const markBackgroundCompletion = useBackgroundCompletionTitle();

  // Multi-flight: each mutationFn invocation owns its own controller. The
  // server is the single source of truth for cap enforcement — both the cap
  // value (config) and the in-flight count (per-pool semaphores in
  // `api/src/orchestrator/concurrency.ts`). The client does NOT enforce its
  // own cap; a 429 from the server is the only gate.
  //
  // ownedBatchesRef tracks the batchIds THIS hook instance started. React
  // StrictMode's dev-mode double mount creates a fresh hook instance with a
  // fresh Set; cleanup runs against the same Set that this instance mutated.
  const ownedBatchesRef = useRef<Set<string>>(new Set());
  const pendingControllersRef = useRef<Set<AbortController>>(new Set());
  useEffect(() => {
    const owned = ownedBatchesRef.current;
    const pending = pendingControllersRef.current;
    return () => {
      for (const controller of Array.from(pending)) {
        controller.abort(new DOMException('hook unmount', 'AbortError'));
      }
      pending.clear();
      // Unmount safety net: abort every batch THIS hook started that is
      // still in flight. Snapshot the Set before abort/unregister so future
      // cleanup changes cannot accidentally mutate during iteration.
      for (const batchId of Array.from(owned)) {
        getBatch(batchId)?.controller.abort(new DOMException('hook unmount', 'AbortError'));
        unregisterBatch(batchId);
      }
      owned.clear();
    };
  }, []);
  // A history write (archive, move, pin, cancel, restore) is pending: a GET
  // sent now could return pre-commit state and land over its optimistic patch.
  const historyWriting = () => queryClient.isMutating({ mutationKey: HISTORY_WRITE_MUTATION_KEY }) > 0;

  useEffect(() => {
    // Cross-tab convergence: sibling tabs post on the channel when a history
    // write settles, a generation is accepted or a cancel starts. This tab
    // re-reads the library (history, archive, counts) the way its own writes
    // settle. One re-read at a time: a burst (a sibling draining its queue)
    // joins the running read plus one trailing read, instead of restarting
    // the multi-page history refetch on every message. While this tab's own
    // history write is in flight (its settle re-read included) the re-read
    // waits: a read of pre-commit server state would land over the write's
    // optimistic patch. The MutationCache reports when the last write ends,
    // success or failure, and the deferred re-read runs then.
    // A hidden tab waits too: nobody is looking, and a sibling draining its
    // queue would otherwise keep every background tab re-reading the whole
    // library for the duration. The deferred re-read runs when it is shown.
    let refreshing = false;
    let pending = false;
    const writing = () => queryClient.isMutating({ mutationKey: HISTORY_WRITE_MUTATION_KEY }) > 0;
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const refreshFromSibling = (): void => {
      if (refreshing || writing() || hidden()) {
        pending = true;
        return;
      }
      pending = false;
      refreshing = true;
      void invalidateLibrary(queryClient).finally(() => {
        refreshing = false;
        if (pending) refreshFromSibling();
      });
    };
    const unsubscribeWrites = queryClient.getMutationCache().subscribe(() => {
      if (pending && !refreshing && !writing()) refreshFromSibling();
    });
    const onVisible = () => {
      if (pending && !hidden()) refreshFromSibling();
    };
    document.addEventListener('visibilitychange', onVisible);
    const unsubscribeInvalidate = onHistoryInvalidate(refreshFromSibling);
    const unsubscribeCancel = onHistoryCancel((batchId, originTabId) => {
      if (originTabId === MY_TAB_ID) return;
      getBatch(batchId)?.controller.abort(new DOMException('canceled by sibling tab', 'AbortError'));
      refreshFromSibling();
    });
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribeWrites();
      unsubscribeInvalidate();
      unsubscribeCancel();
    };
  }, [queryClient]);

  // One batch's server row, written into every cached scope that shows it (a
  // scope it no longer belongs to drops it). Falls back to invalidating every
  // history scope (the stream wrote this batch into each of them) when the
  // read fails, or when a history write was in flight or has started since
  // the request began: a response read before that write would carry
  // pre-commit state over its optimistic patch. While such a write is still
  // pending the fallback only marks the scopes stale, and the re-read runs
  // once no history write is pending (the write's own settle, or the deferred
  // read behind it).
  const settleBatchFromServer = async (batchId: string): Promise<void> => {
    const writing = historyWriting;
    const fallback = () => (writing()
      ? invalidateHistoryBehindWrites(queryClient)
      : queryClient.invalidateQueries({ queryKey: historyKeys.all() }));
    const writeEpoch = lastHistoryWriteId(queryClient);
    if (writing()) {
      await fallback();
      return;
    }
    let response: Awaited<ReturnType<typeof refreshHistory>>;
    try {
      response = await refreshHistory({ batchIds: [batchId], storyIds: [] }, null, '', AbortSignal.timeout(30_000));
    } catch {
      await fallback();
      return;
    }
    const row = response.items.find((item) => item.id === batchId);
    const keys = historyScopesWithBatch(queryClient, historyKeys.all(), batchId);
    if (writing() || lastHistoryWriteId(queryClient) !== writeEpoch || (!row && !response.missingBatchIds.includes(batchId))) {
      await fallback();
      return;
    }
    for (const key of keys) {
      if (row) replaceBatchInScope(queryClient, key, row);
      else removeBatchFromCache(queryClient, key, batchId);
    }
  };

  const mutation = useMutation({
    // Offline, fail at once instead of pausing: a stopped queue drain waits for
    // this POST's answer before the next drain may take the queue.
    networkMode: 'always',
    mutationFn: async ({ request, onAccepted }: GenerateVariables) => {
      const selectedModel = modelById.get(request.modelId);
      if (selectedModel?.requiresKey) {
        throw new NeedsKeyError();
      }
      // App's submit/reroll/retry handlers force Unsorted/empty-q before
      // invoking the mutation, so every cache write/read for this stream is
      // pinned to that scope's key. It must NOT follow later navigation.
      const writeKey = historyKeys.list();
      // Tile and status events reach every cached scope that shows the batch
      // (Unsorted, Pinned, a collection it was moved into, a search), so the
      // scope the user is looking at converges with the stream instead of
      // waiting for the poll. Only the insert is pinned to Unsorted.
      const scopesWithBatch = (id: string): QueryKey[] => historyScopesWithBatch(queryClient, historyKeys.all(), id);
      const controller = new AbortController();
      pendingControllersRef.current.add(controller);

      let announcedRunning = false;
      // Counts feed the settled announcement on the batch's `done` event. The
      // page-level announcer de-duplicates it with the batch row, so a batch
      // scrolled out of the feed or behind another view is still announced.
      let doneTileCount = 0;
      let failedTileCount = 0;

      // Processed SSE batch identity: set only by the real batch event so its
      // createdAt/cache upsert still runs.
      let batchId: string | null = null;
      // Accepted identity: set as soon as the server accepted the batch, even
      // when the events stream never delivers a batch event. Boxed so the
      // closure write is not CFA-narrowed away at the read sites. `replayed`
      // marks an idempotent replay: the batch existed before this request, so
      // nothing optimistic is built from the request (its prompt, model,
      // ratio, collection or archive state may differ); history is refetched
      // instead and the events stream still applies tile updates to whatever
      // the server returns.
      const accepted: { batchId: string | null; replayed: boolean } = { batchId: null, replayed: false };
      const acceptBatch = (id: string, acceptance: GenerateAcceptance) => {
        if (accepted.batchId !== null) return;
        accepted.batchId = id;
        accepted.replayed = acceptance.replayed;
        // The persisted batch already contributes to the Library counts,
        // even if its events stream has not attached or rendering is queued.
        void queryClient.invalidateQueries({ queryKey: collectionKeys.list() });
        if (acceptance.replayed) void queryClient.invalidateQueries({ queryKey: historyKeys.all() });
        // Sibling tabs read the new row now; their active-work refresh then
        // follows it to completion like any other loading batch.
        else emitHistoryInvalidate(id);
        onAccepted?.(id);
      };
      // The request's references describe the batch only when this request
      // created it; a replay's batch keeps whatever the server stored.
      const requestRefs = () => (!accepted.replayed && request.refImageIds ? { refImageIds: request.refImageIds } : {});
      let sawDone = false;
      let needsBroadHistoryReconcile = false;
      // Track every tileId that has had a partial preview written to the
      // store so the finally block can sweep orphans (truncated stream,
      // mid-stream abort, server returning fewer terminal events than
      // partials). Terminal events clear their own entry; this set covers
      // the gaps.
      const previewTileIds = new Set<string>();
      const progressTileIds = new Set<string>();
      // Defense-in-depth dedup for terminal tile events. The server's
      // `/batches/:id/events` route now dedups duplicate replay+live
      // deliveries at source; this set guards against any future regression
      // on either side (server bug, proxy replay, etc.). Without it, a
      // duplicate terminal could re-apply stale terminal data after a
      // cancel/delete path already reconciled the tile.
      const seenTerminalTileIds = new Set<string>();
      // Both error paths below abort the controller before throwing so the
      // underlying fetch + body stream tear down deterministically. Without
      // the abort, the server keeps streaming + holds a per-user concurrency
      // slot until next-boot reconciliation reaps the orphaned `loading` rows.
      try {
        try {
          for await (const event of generateStream(request, controller.signal, { onAccepted: acceptBatch })) {
            if (event.event === 'batch') {
              // Server bug guard: a duplicate batch event would re-run the
              // reconcile and double-bump the in-flight count past the cap.
              // The protocol promises a single batch event per stream.
              if (batchId !== null) continue;
              batchId = event.data.batchId;
              registerBatch(batchId, controller);
              ownedBatchesRef.current.add(batchId);
              if (accepted.replayed) continue;
              const optimisticDuration = request.durationFrames
                ?? (selectedModel?.supportedDurations !== undefined ? selectedModel.defaultDuration : undefined);
              const batch: Batch = {
                id: event.data.batchId,
                prompt: request.prompt,
                ratio: request.ratio,
                modelId: request.modelId,
                modelLabel: modelLabel(modelById, request.modelId),
                // Server-authoritative createdAt — keeps optimistic cache in
                // the same canonical `created_at DESC` order the server
                // returns on refetch. Using Date.now() at SSE-arrival time
                // encoded arrival order into the cache, which then visibly
                // reordered when a refetch landed mid-burst.
                createdAt: event.data.createdAt,
                ...(event.data.startedAt === undefined ? {} : { startedAt: event.data.startedAt }),
                collectionId: null,
                pinned: false,
                status: event.data.status ?? 'running',
                ...(event.data.queueLengthAhead === undefined ? {} : { queueLengthAhead: event.data.queueLengthAhead }),
                // Client already holds the source still id (it submitted it), so
                // the loading tile can veil it immediately — no wait for refetch.
                ...(request.i2vSourceUploadId ? { i2vSourceUploadId: request.i2vSourceUploadId } : {}),
                ...(request.motionPrompt !== undefined ? { motionPrompt: request.motionPrompt } : {}),
                // Mirror the server's clip-length resolution so an immediate
                // Re-roll/Retry of this batch replays the same duration.
                ...(optimisticDuration !== undefined ? { durationFrames: optimisticDuration } : {}),
                tiles: event.data.tiles.map((tile) => ({
                  id: tile.tileId,
                  seed: tile.seed,
                  status: 'loading',
                  ...(event.data.refImageIds ? { refImageIds: event.data.refImageIds } : {}),
                })),
              };
              // A history read already in flight was sent before this row
              // existed: a refetch would drop it, and fetchNextPage appends to
              // the pages it started from. Cancel it before the write, as the
              // other history writers do; the pagination sentinel re-requests
              // a cancelled page. A cancelled refetch (a settled write's or a
              // sibling tab's re-read, a focus refetch) is re-issued after the
              // insert, once the row exists server-side, so no writer's read
              // is silently dropped; so is an invalidation the insert would
              // otherwise clear.
              const writeState = queryClient.getQueryState(writeKey);
              const hadHistory = writeState?.data !== undefined;
              // A next-page load is not re-issued: the pagination sentinel
              // requests the cancelled page again on its own.
              const interruptedRead = (writeState?.fetchStatus === 'fetching' && !writeState.fetchMeta?.fetchMore)
                || writeState?.isInvalidated === true;
              await queryClient.cancelQueries({ queryKey: writeKey, exact: true });
              // A sibling-tab cancel or unmount during the await: no phantom row.
              controller.signal.throwIfAborted();
              upsertNewBatch(queryClient, writeKey, batch);
              // A cancelled first load leaves only this row; read the rest now.
              if (!hadHistory) void queryClient.invalidateQueries({ queryKey: writeKey, exact: true });
              // The re-issued read waits behind a pending history write like
              // every other re-read (the stale mark the settle fallback left
              // would otherwise be read right here, over the write's patch).
              else if (interruptedRead) {
                void (historyWriting()
                  ? invalidateHistoryBehindWrites(queryClient)
                  : queryClient.invalidateQueries({ queryKey: writeKey, exact: true }));
              }
              setActiveBatchId(batch.id);
              followBatch(batch.id);
            } else if (event.event === 'queue' && batchId) {
              for (const key of scopesWithBatch(batchId)) {
                updateBatchStatus(queryClient, key, batchId, {
                  status: 'running',
                  ...(event.data.startedAt === undefined ? {} : { startedAt: event.data.startedAt }),
                });
              }
              if (!announcedRunning) {
                announceGenerationStarted(modelLabel(modelById, request.modelId));
                announcedRunning = true;
              }
            } else if (event.event === 'tile' && batchId) {
              if (event.data.status === 'partial') {
                // Cache-based late-write guard. The store doesn't know tile
                // status (that's TanStack's job), so without this check a
                // partial arriving AFTER the tile's terminal event in this
                // stream — or after the user deleted the batch mid-stream —
                // would re-create an orphan preview entry no LoadingTile is
                // listening to. The old `updateLoadingTilePreview` had the
                // equivalent guard inline; this restores it now that the
                // write target is in a separate store.
                const cachedTile = findTileInAnyScope(queryClient, historyKeys.all(), batchId, event.data.tileId);
                if (cachedTile?.status !== 'loading') continue;
                setTilePreview(event.data.tileId, { url: event.data.preview, index: event.data.index });
                previewTileIds.add(event.data.tileId);
              } else if (event.data.status === 'progress') {
                const cachedTile = findTileInAnyScope(queryClient, historyKeys.all(), batchId, event.data.tileId);
                if (cachedTile?.status !== 'loading') continue;
                const { progress, step, totalSteps, pass, passCount } = event.data;
                // sse.ts strips an incoherent step set, so the four travel together.
                setTileProgress(event.data.tileId, step !== undefined && totalSteps !== undefined
                  && pass !== undefined && passCount !== undefined
                  ? { progress, step, totalSteps, pass, passCount }
                  : { progress });
                progressTileIds.add(event.data.tileId);
              } else if (event.data.status === 'canceled') {
                // Server emitted a wire-level cancel terminal. The originating
                // tab already removed the tile via useCancel's optimistic
                // setQueryData; this SSE event is idempotent reconciliation.
                if (seenTerminalTileIds.has(event.data.tileId)) {
                  console.warn('[useGenerate] duplicate terminal event for tile', event.data.tileId);
                  continue;
                }
                seenTerminalTileIds.add(event.data.tileId);
                for (const key of scopesWithBatch(batchId)) removeTileFromCache(queryClient, key, batchId, event.data.tileId);
                clearTilePreview(event.data.tileId);
                clearTileProgress(event.data.tileId);
                previewTileIds.delete(event.data.tileId);
                progressTileIds.delete(event.data.tileId);
              } else {
                if (seenTerminalTileIds.has(event.data.tileId)) {
                  console.warn('[useGenerate] duplicate terminal event for tile', event.data.tileId);
                  continue;
                }
                seenTerminalTileIds.add(event.data.tileId);
                if (event.data.status === 'done') doneTileCount += 1;
                else failedTileCount += 1;
                const tile: Tile = event.data.status === 'done'
                  ? {
                      id: event.data.tileId,
                      seed: 0,
                      status: 'done',
                      url: apiImageUrl(event.data.url),
                      ...(event.data.thumbUrl ? { thumbUrl: apiImageUrl(event.data.thumbUrl) } : {}),
                      ext: event.data.ext,
                      mime: event.data.mime,
                      completedAt: event.data.completedAt,
                      ...requestRefs(),
                    }
                  : {
                      id: event.data.tileId,
                      seed: 0,
                      status: 'failed',
                      error: event.data.error,
                      ...(event.data.moderation ? { moderation: event.data.moderation } : {}),
                      completedAt: event.data.completedAt,
                      ...requestRefs(),
                    };
                for (const key of scopesWithBatch(batchId)) updateBatchTile(queryClient, key, batchId, tile);
                // BatchView swaps LoadingTile → ImageTile/FailedTile on the
                // same render that processes this update, so the preview
                // entry is no longer read after this point. Drop it now to
                // keep the data: URL (often hundreds of KB) from sitting in
                // the store as garbage.
                clearTilePreview(event.data.tileId);
                clearTileProgress(event.data.tileId);
                previewTileIds.delete(event.data.tileId);
                progressTileIds.delete(event.data.tileId);
              }
            } else if (event.event === 'done') {
              sawDone = true;
              if (batchId) for (const key of scopesWithBatch(batchId)) updateBatchStatus(queryClient, key, batchId, { status: 'done' });
              if (selectedModel?.outputsVideo === true && doneTileCount > 0) markBackgroundCompletion();
              if (batchId) announceBatchSettled(batchId, doneTileCount, failedTileCount);
            }
          }
        } catch (error) {
          // v3 spec: server keeps generating across non-deliberate stream loss,
          // so we no longer mutate cached tile state on mid-stream failures.
          // Distinguish deliberate aborts (unmount cleanup, useCancel DELETE —
          // both abort the controller with a DOMException AbortError reason)
          // from genuine network/stream failures.
          const reason: unknown = controller.signal.reason;
          const deliberateAbort = controller.signal.aborted && isAbortError(reason);
          const knownBatchId = batchId ?? accepted.batchId;
          needsBroadHistoryReconcile = deliberateAbort || knownBatchId !== null || !(error instanceof ApiError);
          controller.abort();
          // Once the server accepted the batch (201 body or batch event),
          // normalize non-deliberate failures (events GET 503, TCP reset,
          // partial frame, etc.) into StreamTruncatedError so onError
          // suppresses the misleading "Generation failed" toast and callers
          // never retry a billable batch. The server may still be generating
          // and the history refetch reconciles the cache.
          if (!deliberateAbort && knownBatchId !== null) {
            throw new StreamTruncatedError(knownBatchId);
          }
          throw error;
        }
        if (!sawDone) {
          // Clean EOF without `done` = stream truncation (browser refresh,
          // SWAG idle timeout, mounted-SPA blip). Server keeps running per
          // the v3 spec; the historyOpts refetchInterval reconciles the
          // cache once tiles settle.
          controller.abort();
          needsBroadHistoryReconcile = true;
          throw new StreamTruncatedError(batchId ?? accepted.batchId);
        }
      } finally {
        pendingControllersRef.current.delete(controller);
        if (batchId !== null) {
          // A replay of a batch still streaming here re-registers it under
          // its own controller; leave a registration this stream does not own.
          if (getBatch(batchId)?.controller === controller) unregisterBatch(batchId);
          ownedBatchesRef.current.delete(batchId);
        }
        // Sweep any preview entries left over from tiles that received a
        // partial but never reached a terminal event (truncated stream,
        // abort, server-side reconciliation). Without this, those data:
        // URLs would linger in the store until full page reload.
        for (const tileId of previewTileIds) clearTilePreview(tileId);
        for (const tileId of progressTileIds) clearTileProgress(tileId);
        // Stream loss, deliberate aborts and replays may require cross-scope
        // recovery: the server can keep generating and the next history fetch
        // is the signal that surfaces or converges those rows. A clean stream
        // already wrote every tile; it only needs this batch's server row
        // (one bounded POST) rather than a refetch of every loaded page,
        // which a queue drain would restart on each settle.
        if (needsBroadHistoryReconcile || accepted.replayed) {
          void queryClient.invalidateQueries({ queryKey: historyKeys.all() });
        } else if (batchId !== null && sawDone) {
          void settleBatchFromServer(batchId);
        } else {
          void queryClient.invalidateQueries({ queryKey: writeKey, exact: true });
        }
      }
    },
    onError: (error, variables) => {
      // AbortError surfaces when StrictMode unmounts or when the unmount
      // cleanup aborts every in-flight controller. Cache was already
      // reconciled in mutationFn — silent is the right shape.
      if (isAbortError(error)) return;
      if (error instanceof NeedsKeyError || isNeedsKeyApiError(error)) {
        useAtelierStore.getState().openByok();
        return;
      }
      // 503 + MODEL_OFFLINE: server's health probe says the upstream host is
      // offline. The user raced a stale snapshot — refetch /api/models so the
      // chip flips to disabled, then surface a typed toast. No history
      // invalidation; no tile work was started.
      if (
        error instanceof ApiError &&
        error.status === 503 &&
        apiErrorCode(error) === ('MODEL_OFFLINE' satisfies ApiErrorCode)
      ) {
        void queryClient.invalidateQueries({ queryKey: modelKeys.list() });
        addToast('Model is offline — picker refreshed.', 'error');
        return;
      }
      // 429 = server's cap gate fired. Toast as a soft notice (no history
      // invalidation, no error styling) — the user just needs to wait, not
      // debug a failure.
      if (error instanceof ApiError && error.status === 429) {
        if (
          apiErrorCode(error) === ('QUEUE_FULL' satisfies ApiErrorCode)
          && isDrainOwned(variables.request)
        ) return;
        const display = describeError(error, 'At capacity — wait for some tiles to finish.');
        const durationMs = isPhoneViewport() ? 4000 : undefined;
        addToast(display, 'soft', durationMs);
        return;
      }
      // StreamTruncatedError fires on browser refresh, SWAG idle close,
      // or any non-deliberate stream loss. Under the v3 contract the
      // server keeps generating, so we don't toast here — the
      // historyOpts refetchInterval (separate change) will reconcile the
      // cache. Silent, consistent with the AbortError branch above.
      if (error instanceof StreamTruncatedError) return;
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        if (!isDrainOwned(variables.request)) addToast('Submission timed out. Check history before retrying.', 'error');
        return;
      }
      addToast(describeError(error, 'Generation failed. Please try again.'), 'error');
      void queryClient.invalidateQueries({ queryKey: historyKeys.all() });
    },
  });

  // Narrow return shape — spreading `mutation` leaks ~20 unstable fields
  // (data, error, status, mutateAsync, etc., all freshly referenced every
  // render) into consumers' useCallback/useEffect dep arrays, forcing
  // global listeners (useKeyboard, Lightbox keydown) to tear down + rebind
  // on every keystroke. The wrapper is stable because mutateAsync is; only the
  // request reaches the wire, the callback stays in local mutation variables.
  const { mutateAsync } = mutation;
  const generate = useCallback(
    (request: GenerateRequest, options?: GenerateOptions) => mutateAsync(
      options?.onAccepted ? { request, onAccepted: options.onAccepted } : { request },
    ),
    [mutateAsync],
  );
  return { generate } as const;
}
