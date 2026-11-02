import {
  MAX_PROMPT_CHARS,
  type GenerateRequest,
  type Model,
  type Ratio,
  type VideoDurationFrames,
} from '@atelier/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  APP_VIEW_UNSORTED,
  appViewEquals,
  canSubmitDraft,
  holdSubmissionUploads,
  toGenerateRequest,
  type ComposerDraft,
  type QueuedRoll,
  type RollSubmission,
  type ToastMessage,
  useAtelierStore,
} from '../store/atelier';
import { isAbortError } from '../lib/abort';
import { resolveComposerPrompt, type ComposerLibrary } from '../lib/resolveComposerPrompt';
import {
  AI_FILL_BATCH_MAX,
  aiFillMeasuredLength,
  hasAiFillTokens,
  stripCardNotesToken,
} from '@atelier/shared/ai-fill';
import { nextSeed } from '../lib/seed';
import { UNCERTAIN_SUBMISSION_NOTICE } from '../lib/errorCopy';
import { inFlightRollIds } from '../lib/rollQueuePersist';
import { makeSubmissionRequest } from '../lib/rollQueueSubmit/request';
import { prepareItem } from '../lib/rollQueueSubmit/prepare';
import { runCoalescedFlush } from '../lib/rollQueueSubmit/coalesced';
import {
  admitPrepared,
  admitStandalonePrepared,
  createAdmissionSequencer,
  turnOrAbort,
  type AdmissionContext,
  type AdmissionTurn,
} from '../lib/rollQueueSubmit/orderedSubmission';
import { runDrainPump } from '../lib/rollQueueSubmit/pump';
import type {
  BufferedFireItem,
  FireItem,
  MotionFields,
  PrepareContext,
  SingleFillOutcome,
} from '../lib/rollQueueSubmit/types';

const SUBMIT_COALESCE_MS = 300;
// Hard cap on how long the first buffered press may wait. With the 300 ms
// debounce and AI_FILL_BATCH_MAX = 4, it is currently unreachable for
// coalescable presses: a third press lands before 600 ms, so its debounce fires
// before 900 ms, and a fourth flushes at the batch cap. Kept as the guard that
// still bounds the wait if either constant changes.
const SUBMIT_COALESCE_MAX_MS = 900;
const CAPACITY_TOAST = 'At capacity — queued, will generate automatically.';

interface UseRollQueueSubmitArgs {
  draft: ComposerDraft;
  effectiveModel: Model | undefined;
  effectiveRatio: Ratio;
  /** Resolved clip length; undefined on image models. */
  effectiveDuration: VideoDurationFrames | undefined;
  // `onAccepted` fires once the server accepted (and may bill) the batch, before
  // the stream settles, so a consumed roll can settle durably right away.
  generate: (request: GenerateRequest, options?: { onAccepted?: (batchId: string) => void }) => Promise<unknown>;
  fireGenerate: (request: GenerateRequest) => void;
  addToast: (text: string, tone?: ToastMessage['tone'], durationMs?: number, action?: ToastMessage['action']) => string;
  setComposerExpanded: (expanded: boolean) => void;
  // Prompt-library data for resolving {{var::}} in hand-typed prompts; undefined
  // when the library is gated (macros still resolve, var lists stay verbatim).
  library: ComposerLibrary | undefined;
  // True while an ENTITLED user's library is still loading (data not yet
  // fetched, not gated). Resolving {{var::}} in this window would draw from
  // empty lists and leak the raw token to the model, so we block instead.
  libraryPending: boolean;
}

interface UseRollQueueSubmitResult {
  submitDraft: () => void;
  /** A standalone replay is retrying capacity; does not own the paused queue. */
  retryingPrepared: boolean;
  /** Already-resolved historical inputs, admitted in the same press order. */
  submitPrepared: (request: GenerateRequest) => void;
  // Abort the in-progress drain: cancels in-flight ai-fill/format resolves and the
  // inter-pass wait, leaving every un-fired roll back in the queue. Already-started
  // generation batches keep running (the server owns them). Presses not yet
  // sent are retired; a POST already sent keeps its answer.
  stopDraining: () => void;
}

interface SubmitDraftOptions {
  readonly preparedRequest?: GenerateRequest;
  /**
   * Works only the queue: an internal restart of work already submitted, or
   * the Retry/Resume toast. Each roll runs under its own captured settings,
   * whatever the composer now shows.
   */
  readonly queueOnly?: boolean;
  /** Buffered presses to flush, each with its own settings and turn. */
  readonly coalescedItems?: readonly BufferedFireItem[];
  /** The feed pin of the press an internal restart continues. */
  readonly pinFeedScope?: () => void;
}

export function useRollQueueSubmit({
  draft,
  effectiveModel,
  effectiveRatio,
  effectiveDuration,
  generate,
  fireGenerate,
  addToast,
  setComposerExpanded,
  library,
  libraryPending,
}: UseRollQueueSubmitArgs): UseRollQueueSubmitResult {
  const effectiveModelId = effectiveModel?.id ?? '';
  // Controller for the in-progress drain, so the Stop button can abort it from
  // outside the submit closure. Ref (not state): aborting must not re-render.
  const drainAbortRef = useRef<AbortController | null>(null);
  // Settles when the latest drain has finished. A stopped drain may still await
  // one submission's answer; the next drain waits for it before taking the queue.
  const drainSettledRef = useRef<Promise<void> | null>(null);
  // Explicit Resume may adopt a capacity-held replay, but only after its
  // current POST answers. Interrupt backoff and hand off this one owner.
  const standaloneAdmissionRef = useRef<{
    controller: AbortController;
    settled: Promise<void>;
  } | null>(null);
  // Press order for every POST made outside the drain pump, and for presses
  // that must wait behind one (see orderedSubmission).
  const [sequencer] = useState(createAdmissionSequencer);
  const [retryingPrepared, setRetryingPrepared] = useState(false);
  const submitDraftAsyncRef = useRef<(options?: SubmitDraftOptions) => Promise<void>>(() => Promise.resolve());
  const coalescedItemsRef = useRef<BufferedFireItem[]>([]);
  const coalescedSettlersRef = useRef(new Set<() => void>());
  const coalescedAbortControllersRef = useRef(new Set<AbortController>());
  const coalesceTimerRef = useRef<number | null>(null);
  const coalesceFirstAtRef = useRef<number | null>(null);
  // One controller per press not yet finished. Stop and unmount abort them all:
  // a press not yet sent is retired (its preparation cancelled, its turn
  // released); a POST already sent keeps running to its answer.
  const pressControllersRef = useRef(new Set<AbortController>());
  // Keys of presses with an item not yet finished. Until it finishes, a press
  // may still be requeued at capacity, so a later press's head stays behind it.
  const unfinishedPressKeysRef = useRef(new Set<string>());
  // False once the hook unmounts: a POST answered after that never queues
  // work into the store, which may already belong to another session.
  const mountedRef = useRef(true);

  const retirePresses = useCallback(() => {
    for (const controller of pressControllersRef.current) controller.abort();
    pressControllersRef.current.clear();
  }, []);

  const clearCoalesceTimer = useCallback(() => {
    if (coalesceTimerRef.current === null) return;
    window.clearTimeout(coalesceTimerRef.current);
    coalesceTimerRef.current = null;
  }, []);

  const takeCoalesced = useCallback((): BufferedFireItem[] => {
    clearCoalesceTimer();
    const items = coalescedItemsRef.current;
    coalescedItemsRef.current = [];
    coalesceFirstAtRef.current = null;
    return items;
  }, [clearCoalesceTimer]);

  // Stop and unmount: buffered presses end their feedback and hand on their turns.
  const discardCoalesced = useCallback(() => {
    for (const buffered of takeCoalesced()) {
      buffered.settle();
      buffered.turn.release();
    }
  }, [takeCoalesced]);

  const abortCoalescedFlushes = useCallback(() => {
    for (const controller of coalescedAbortControllersRef.current) controller.abort();
  }, []);

  const flushCoalesced = useCallback(() => {
    // A press Clear or a template switch discarded while it buffered ends here,
    // before any fill is paid for it.
    const items = takeCoalesced().filter((buffered) => {
      if (buffered.live()) return true;
      buffered.settle();
      buffered.turn.release();
      return false;
    });
    if (items.length === 0) return;
    void submitDraftAsyncRef.current({ coalescedItems: items })
      .finally(() => {
        for (const buffered of items) {
          buffered.settle();
          buffered.turn.release();
        }
      })
      .catch(() => { /* submit owns its error handling */ });
  }, [takeCoalesced]);

  const submitDraftAsync = useCallback(async (options: SubmitDraftOptions = {}) => {
    // One idempotency key per press, minted before any await. A coalesced item
    // already carries the key its own press minted.
    const pressKey = crypto.randomUUID();
    const queueOnly = options.queueOnly === true;
    const preparedRequest = options.preparedRequest;
    const { coalescedItems } = options;
    const store = useAtelierStore.getState;
    // Clear or a template switch retires this press, including while Resume
    // waits to adopt a standalone replay's unanswered POST.
    const pressEpoch = store().queueEpoch;
    const standalone = queueOnly ? standaloneAdmissionRef.current : null;
    if (standalone) {
      const resumeController = new AbortController();
      pressControllersRef.current.add(resumeController);
      standalone.controller.abort();
      try {
        await turnOrAbort({ ready: standalone.settled, release: () => undefined }, resumeController.signal);
        if (resumeController.signal.aborted || !mountedRef.current || store().queueEpoch !== pressEpoch) return;
      } finally {
        pressControllersRef.current.delete(resumeController);
      }
    }
    // A flush submits presses checked when they were made, under their own
    // settings; a queue-only restart works rolls that carry theirs. Neither
    // depends on what the composer shows now.
    if (coalescedItems === undefined && !queueOnly && preparedRequest === undefined) {
      if (!effectiveModelId) return;
      if (!canSubmitDraft(draft, effectiveModel)) return;
    }
    // Where the user was standing when they pressed Generate. A drain fires
    // batches over many seconds; pinning the feed to Unsorted at EVERY fire
    // used to throw the user out of the Prompt Library (or a collection, or a
    // search) each time a roll resolved. Pin only while the user is still where
    // the press happened — once they navigate, their choice wins. An internal
    // restart pins as the press it continues would, never by the view current
    // at restart; a flush pins per buffered press.
    const viewAtPress = store().view;
    const qAtPress = store().q;
    const pinFeedScope = options.pinFeedScope ?? (() => {
      const state = store();
      if (!appViewEquals(state.view, viewAtPress)) return;
      if (state.view.kind !== 'unsorted') state.setView(APP_VIEW_UNSORTED);
      if (state.q !== '' && state.q === qAtPress) state.setQ('');
    });
    const { prompt: draftPrompt, provenance: _draftProvenance, seed: capturedSeed, idempotencyKey: _capturedKey, ...pressRequest } = preparedRequest ?? toGenerateRequest(
      draft,
      effectiveModelId,
      effectiveRatio,
      effectiveModel,
      effectiveDuration,
    );
    const activePrompt = queueOnly ? '' : draftPrompt.trim();
    const motionFields: MotionFields = {
      ...(draft.i2vSourcePrompt ? { sourcePrompt: draft.i2vSourcePrompt } : {}),
      ...(effectiveDuration !== undefined ? { durationFrames: effectiveDuration } : {}),
      ...(draft.extendsTileId && draft.extendPrevPrompt && draft.i2vSourceUploadId ? {
        extendContext: {
          previousMotionPrompt: draft.extendPrevPrompt,
          handoffUploadId: draft.i2vSourceUploadId,
        },
      } : {}),
    };
    const effectiveCap = effectiveModel?.maxCountPerBatch;
    const picker = store().promptPickerDraft;
    // This press's settings, bound to every item it submits, so a model or
    // setting change made afterwards never rewrites a press already made. A
    // seed locked in the picker reproduces; otherwise every fire draws a fresh
    // one (see makeGenerateRequest).
    const submission: RollSubmission = {
      request: {
        ...pressRequest,
        count: preparedRequest === undefined && effectiveCap !== undefined && pressRequest.count > effectiveCap ? effectiveCap : pressRequest.count,
      },
      lockedSeed: preparedRequest === undefined ? (picker.lockSeed ? picker.seed : null) : capturedSeed ?? null,
      wantsMotion: preparedRequest === undefined && effectiveModel?.promptFormat === 'h3-motion',
      motionFields: preparedRequest === undefined ? motionFields : {},
      ...(preparedRequest === undefined ? {} : { prepared: true as const }),
    };
    // Library rolls queued without settings (stash, sweep, older saved rolls)
    // bind to the press whose drain first takes them (DrainPumpContext.defaultSubmission).
    const makeReq = (item: FireItem): GenerateRequest => makeSubmissionRequest(item.submission ?? submission, item);
    const requiresKey = Boolean(effectiveModel?.requiresKey);
    // Only a user press opens BYOK. A queue-only restart works rolls already
    // submitted under their own non-BYOK settings, so a composer switched to a
    // keyed model never diverts them into the BYOK dialog.
    const byok = requiresKey && !queueOnly && preparedRequest === undefined;
    // A library roll (stash, sweep, older saved rolls) has no settings of its
    // own and binds to the press that submits it, so only a valid image press
    // may take it. I2V is single-job (count 1, no sweep/stash UI in video
    // mode): a stale roll's text would fire as an unrelated motion prompt. Such
    // rolls stay queued (not consumed) and survive a round-trip back to an
    // image model. A roll carrying its own press's settings fires under those,
    // so any press, or a queue-only restart, takes it in its place.
    const libraryRollsBindable = preparedRequest === undefined && effectiveModelId !== ''
      && effectiveModel?.supportsI2V !== true
      && !requiresKey
      && canSubmitDraft(draft, effectiveModel);
    // Historical replay never resumes paused work, even when old rolls carry
    // bound settings. It joins an active owner, or admits only its own click.
    const canTake = (roll: QueuedRoll): boolean => preparedRequest === undefined
      && (roll.submission !== undefined || libraryRollsBindable);
    // Snapshot the queue from the LIVE store, not the closed-over draft prop, so
    // a rapid double-submit can't re-fire rolls the first invocation already
    // cleared (the prop closure would still show the stale, full queue). A
    // BYOK press takes only a library roll as its head: work saved under
    // non-BYOK settings never goes through the BYOK dialog.
    const liveQueue = store().draft.rollQueue;
    const queuedRolls = byok
      ? (effectiveModel?.supportsI2V === true ? [] : liveQueue.filter((roll) => roll.submission === undefined))
      : liveQueue.filter(canTake);
    // Each item is either a queued roll (with its own provenance) or the active
    // draft prompt (with the draft's provenance). Map over the structured rolls,
    // not bare strings, so per-roll provenance survives to the wire. Queued rolls
    // are already resolved (sweep/stash) with their own seed — re-resolving would
    // double-roll, so they pass through untouched.
    const queuedItems: FireItem[] = queuedRolls.map((r) => ({
      key: r.id,
      text: r.text,
      provenance: r.provenance,
    }));

    // The actionable ai-fill failure message for the HEAD item (see
    // PrepareContext.recordHeadError). Held on an object so the property type
    // stays string|null at the read sites (a bare `let` mutated inside a closure
    // gets CFA-narrowed to null, tripping no-unnecessary-condition).
    const fillError: { message: string | null } = { message: null };
    // The active drain's controller and settlement, set once the drain starts.
    const drain: {
      controller: AbortController | null;
      settled: PromiseWithResolvers<undefined> | null;
    } = { controller: null, settled: null };
    // Preparation reads the press's settings through a context; each path
    // supplies the signal that cancels its fills (the drain's Stop, a coalesced
    // flush's abort, a direct press retired by Stop). The BYOK path has no
    // Stop: its signal never aborts. An item carrying its own press's settings
    // is prepared under those.
    const prepareContext = (signal: AbortSignal): PrepareContext => ({
      library,
      effectiveModelId,
      wantsMotion: submission.wantsMotion,
      motionFields,
      signal,
      addToast,
      recordHeadError: (message) => { fillError.message = message; },
      // Only a drain batches queued rolls; the pump supplies its own.
      onDeferSingle: () => undefined,
    });
    const byokCtx = prepareContext(new AbortController().signal);
    // This press until it is sent: Stop or unmount aborts it (see retirePresses).
    const pressController = new AbortController();
    // The press may still put work in the queue: no Clear or template switch
    // since it was made, and the hook still mounted. Stop does not end it, so
    // a POST sent before Stop and refused later stays queued for the next press.
    const owned = (): boolean => mountedRef.current && store().queueEpoch === pressEpoch;
    // The press may still be sent.
    const live = (): boolean => !pressController.signal.aborted && owned();

    // The roll keeps the item's idempotency key as its id and its press's
    // settings, so the drain that later submits it re-POSTs the same logical roll.
    const composerRoll = (item: FireItem): QueuedRoll => ({
      id: item.key,
      text: item.text,
      seed: nextSeed(),
      source: 'composer',
      ...(item.provenance ? { provenance: item.provenance } : {}),
      ...(item.submission ? { submission: item.submission } : {}),
    });
    // Puts a composer item at the end of the queue. A paid item is a system
    // requeue: it bypasses the admission cap, because the item may carry a fill
    // already paid for and refusing it would lose that work. Anything else is
    // a user stash: it obeys the cap (the store toasts a refusal). A press no
    // longer owned (Clear, a template switch, unmount) queues nothing, even
    // when its POST is refused only now.
    const enqueue = (item: FireItem, paid: boolean): boolean => {
      if (!owned()) return false;
      if (!paid) return store().stashRoll(composerRoll(item));
      const roll = composerRoll(item);
      if (store().draft.rollQueue.some((queued) => queued.id === roll.id)) {
        store().setDraft({ rollQueue: store().draft.rollQueue.map((queued) => queued.id === roll.id ? roll : queued) });
      } else store().requeueRoll(roll);
      return true;
    };
    // A press joining a running drain is acknowledged only when taken.
    const joinDrain = (item: FireItem) => {
      if (enqueue(item, false)) addToast('Added to the queue.', 'soft');
    };
    // Rolls queued outside a running drain need an owner: a queue-only press,
    // which waits for a stopped drain still settling before it takes the queue.
    // It starts synchronously otherwise, so a later press sees it at its turn.
    // It pins the feed as the press whose work it continues would.
    const ensureDrain = (pin: () => void = pinFeedScope) => {
      if (owned() && !store().draining) void submitDraftAsyncRef.current({ queueOnly: true, pinFeedScope: pin });
    };
    const admission: AdmissionContext = {
      generate,
      makeRequest: makeReq,
      queueOwned: () => store().draining || drainSettledRef.current !== null,
      enqueue,
      onFire: () => {
        setComposerExpanded(false);
        pinFeedScope();
      },
      onSaved: () => {
        addToast(UNCERTAIN_SUBMISSION_NOTICE.text, 'error', 30_000, {
          label: UNCERTAIN_SUBMISSION_NOTICE.actionLabel, onClick: () => { ensureDrain(); },
        });
      },
    };

    if (coalescedItems !== undefined) {
      await runCoalescedFlush({
        library,
        addToast,
        prepareContext,
        // Each buffered press pins its own feed scope (BufferedFireItem).
        admission: { ...admission, onFire: () => { setComposerExpanded(false); } },
        registerFlushController: (controller) => { coalescedAbortControllersRef.current.add(controller); },
        unregisterFlushController: (controller) => { coalescedAbortControllersRef.current.delete(controller); },
        ensureDrain,
      }, coalescedItems);
      return;
    }

    // Resolve template grammar the user typed into the Composer ({{var::}},
    // {{random::}}, {{roll::}}, …) at Generate time with a fresh seed, so each
    // submit re-rolls and the model receives finished text. One resolution per
    // batch — all `count` tiles share it. Picker-sourced active prompts carry no
    // tokens, so resolution is a no-op there and provenance survives. Each guard
    // below blocks ONLY the active item (queued rolls still fire) and explains
    // why, so Generate is never a silent no-op behind an enabled button.
    let activeItem: FireItem | null = null;
    if (preparedRequest !== undefined) {
      activeItem = { key: pressKey, text: preparedRequest.prompt, provenance: preparedRequest.provenance, submission };
    } else if (activePrompt.length > 0) {
      if (libraryPending && (activePrompt.includes('{{var::') || hasAiFillTokens(activePrompt))) {
        addToast('Prompt library still loading — try again in a moment.', 'soft');
      } else {
        const resolved = resolveComposerPrompt(activePrompt, library, nextSeed());
        if (resolved.warnings.length > 0) {
          addToast(resolved.warnings[0] ?? 'Some prompt tokens could not be resolved', 'soft');
        }
        const resolvedText = resolved.text.trim();
        // Static skeleton only (aiFillMeasuredLength); the FINAL filled text is
        // re-checked post-fill and server-side.
        const measuredLength = aiFillMeasuredLength(resolvedText);
        if (measuredLength > MAX_PROMPT_CHARS) {
          addToast(`Prompt is too long after expanding tokens — ${measuredLength} / ${MAX_PROMPT_CHARS} chars.`, 'error');
        } else if (resolvedText.length > 0) {
          activeItem = { key: pressKey, text: resolvedText, provenance: draft.provenance, submission };
        } else {
          // Non-empty raw prompt that resolved to nothing (comment / noop only).
          addToast('Prompt resolved to empty — nothing to generate.', 'soft');
        }
      }
    }

    // Nothing submittable → bail before showing any "resolving" feedback.
    if (activeItem === null && queuedItems.length === 0) return;

    // The press's media stays held until it is accepted, queued (the queue
    // holds it from there), refused or retired, so a ref replaced or a thread
    // deleted meanwhile cannot delete it before its POST.
    const releaseUploads = activeItem !== null ? holdSubmissionUploads([activeItem.submission]) : () => undefined;
    const earlierPressKeys = [...unfinishedPressKeysRef.current];
    if (activeItem !== null) unfinishedPressKeysRef.current.add(activeItem.key);
    const finishPress = () => {
      pressControllersRef.current.delete(pressController);
      unfinishedPressKeysRef.current.delete(pressKey);
      releaseUploads();
    };

    if (
      !queueOnly
      && preparedRequest === undefined
      && !byok
      && !store().draining
      // A stopped drain may still hold an unanswered roll; this press waits for it.
      && drainSettledRef.current === null
      && queuedRolls.length === 0
      && activeItem !== null
      && library !== undefined
      && hasAiFillTokens(stripCardNotesToken(activeItem.text))
    ) {
      const now = Date.now();
      if (coalescedItemsRef.current.length === 0) coalesceFirstAtRef.current = now;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        coalescedSettlersRef.current.delete(settle);
        store().settlePreparing(1);
      };
      coalescedSettlersRef.current.add(settle);
      // The turn is taken now, so the press keeps its place however long it
      // buffers. Its release, once the press is answered, refused or retired,
      // also ends the press's upload hold.
      const turn = sequencer.reserve();
      pressControllersRef.current.add(pressController);
      coalescedItemsRef.current.push({
        item: activeItem,
        settle,
        turn: {
          ready: turn.ready,
          release: () => {
            turn.release();
            finishPress();
          },
        },
        live,
        owned,
        pinFeedScope,
      });
      store().addPreparing(1);
      const firstAt = coalesceFirstAtRef.current ?? now;
      const remainingToHardCap = Math.max(0, SUBMIT_COALESCE_MAX_MS - (now - firstAt));
      if (coalescedItemsRef.current.length >= AI_FILL_BATCH_MAX || remainingToHardCap === 0) {
        flushCoalesced();
      } else {
        clearCoalesceTimer();
        coalesceTimerRef.current = window.setTimeout(
          flushCoalesced,
          Math.min(SUBMIT_COALESCE_MS, remainingToHardCap),
        );
      }
      return;
    }
    // Buffered presses came first: flush them now rather than make this press
    // wait out their debounce behind them.
    if (!byok && coalescedItemsRef.current.length > 0) flushCoalesced();

    // Non-BYOK, NO QUEUE: prepared at once, then POSTed at this press's turn.
    const direct = !byok && !queueOnly && queuedRolls.length === 0
      && !store().draining && drainSettledRef.current === null;
    // What the head of a drain this press starts follows, fixed now, before
    // any wait: the rolls queued or still held by a stopped drain (its
    // in-flight copies), and earlier presses not yet finished, which a
    // capacity refusal may requeue later. Rolls stashed while this press waits
    // for its turn or for that drain to settle go after its head.
    const queuedBeforeHead: ReadonlySet<string> = new Set(byok || direct || activeItem === null ? [] : [
      ...inFlightRollIds(),
      ...liveQueue.map((roll) => roll.id),
      ...earlierPressKeys,
    ]);
    // Every direct press takes a turn, and so does any press made while turns
    // are still held: it must not pass an earlier press that is preparing or
    // waiting for its answer. A queue-only press never waits, because the press
    // ahead of it is the one that queued its work.
    const turn: AdmissionTurn | null = !byok && !queueOnly && (preparedRequest !== undefined || direct || sequencer.pending() > 0)
      ? sequencer.reserve()
      : null;

    // Single-owner drain: a Generate press while a drain is already working the
    // queue must NOT spawn a parallel pass — overlapping passes are exactly what
    // saturated the enhance pool in the silent-drop incident. The running drain
    // re-reads the LIVE queue every pass, so this press's resolved composer item
    // can join it without starting a parallel owner.
    if (!byok && turn === null && store().draining) {
      if (activeItem !== null) {
        joinDrain(activeItem);
      } else {
        addToast('Still working through your queue…', 'soft');
      }
      // Once queued, the queue holds the press's media.
      finishPress();
      return;
    }
    if (!queueOnly) pressControllersRef.current.add(pressController);

    // Announce that work is happening. The Generate button shows a working state
    // for the FILL window only — the seconds-long ai-fill round-trip. Once the
    // batches are fired, the tiles' own loading state takes over, so resolving
    // must end at fire time, NOT when the generation stream completes (`generate()`
    // only settles on stream `done`, which would pin the spinner and mask the
    // at-capacity badge for the whole generation). beginResolving lives INSIDE the
    // try so the finally always balances it — no permanent stuck-spinner leak.
    const priorResolving = store().resolving;
    let resolvingEnded = false;
    const endResolvingOnce = () => {
      if (resolvingEnded) return;
      resolvingEnded = true;
      store().endResolving();
    };

    try {
      store().beginResolving();
      if (priorResolving > 0) {
        addToast(`Resolving ${priorResolving + 1} prompts…`, 'soft');
      }

      if (byok) {
        // headCandidate is defined: the bail above guarantees an active item or a
        // queued roll exists.
        const headCandidate = activeItem ?? queuedItems[0];
        if (headCandidate === undefined) return;
        const filledHead = await prepareItem(byokCtx, headCandidate);
        if (filledHead === null || 'preserve' in filledHead || 'backpressure' in filledHead) {
          if (filledHead === null) addToast(fillError.message ?? "Couldn't prepare the prompt — nothing to generate.", 'error');
          else if ('backpressure' in filledHead) addToast('At capacity — try again in a moment.', 'soft');
          // quota preserve / backpressure: toast shown; leave composer as-is. BYOK
          // is a single head fire, not a drain, so there is no retry loop here.
          return;
        }
        if (filledHead.text.length > MAX_PROMPT_CHARS) {
          addToast(`Prompt is too long — ${filledHead.text.length} / ${MAX_PROMPT_CHARS} chars.`, 'error');
          return;
        }
        setComposerExpanded(false);
        void import('../components/ByokDialog');
        pinFeedScope();
        // The keyed press's own settings, never a queued roll's.
        fireGenerate(makeSubmissionRequest(submission, filledHead));
        return;
      }

      if (preparedRequest !== undefined) {
        if (activeItem === null || turn === null) return;
        const replayItem = activeItem;
        endResolvingOnce();
        if (sequencer.pending() > 1) {
          addToast('Replay is waiting for an earlier request. Stop cancels waiting replays.', 'soft');
        }
        await turnOrAbort(turn, pressController.signal);
        if (!live()) return;
        const stoppedDrain = !store().draining ? drainSettledRef.current : null;
        if (stoppedDrain) {
          await turnOrAbort({ ready: stoppedDrain, release: () => undefined }, pressController.signal);
          if (!live()) return;
        }
        const epochController = new AbortController();
        const removalController = new AbortController();
        let savedRetry = false;
        const handoffController = new AbortController();
        const standaloneSettled = Promise.withResolvers<undefined>();
        const standaloneOwner = { controller: handoffController, settled: standaloneSettled.promise };
        standaloneAdmissionRef.current = standaloneOwner;
        const unsubscribe = useAtelierStore.subscribe((state) => {
          if (state.queueEpoch !== pressEpoch) epochController.abort();
          if (savedRetry && !state.draft.rollQueue.some((roll) => roll.id === replayItem.key)) removalController.abort();
        });
        try {
          const admitted = await admitStandalonePrepared({
            ...admission,
            // A stopped owner has settled; only a live authorized drain may
            // take this click, never the mere presence of saved queue rows.
            queueOwned: () => store().draining,
            signal: AbortSignal.any([pressController.signal, epochController.signal, removalController.signal, handoffController.signal]),
            owned,
            savedItemExists: (key) => store().draft.rollQueue.some((roll) => roll.id === key),
            retire: (key) => { if (owned()) store().retireQueuedRolls([key]); },
            onBackpressure: () => {
              savedRetry = true;
              if (!live() || handoffController.signal.aborted || epochController.signal.aborted) return;
              setRetryingPrepared(true);
              addToast(CAPACITY_TOAST, 'soft');
            },
          }, replayItem);
          if (admitted === 'queued') addToast('Added to the queue.', 'soft');
          else if (admitted === 'capacity' && owned() && !handoffController.signal.aborted) {
            addToast(pressController.signal.aborted
              ? 'Replay stopped — saved in your queue. Generate or Resume will retry it.'
              : 'Still at capacity — your replay is saved.', 'soft', 30_000, {
              label: 'Resume',
              onClick: () => {
                if (owned()) void submitDraftAsyncRef.current({ queueOnly: true, pinFeedScope });
              },
            });
          }
        } finally {
          unsubscribe();
          if (standaloneAdmissionRef.current === standaloneOwner) {
            standaloneAdmissionRef.current = null;
            if (mountedRef.current) setRetryingPrepared(false);
          }
          standaloneSettled.resolve(undefined);
        }
        return;
      }

      // Non-BYOK, NO QUEUE: no drain lock, so pressing Generate repeatedly for
      // variations still works. Preparation runs at once, alongside earlier
      // presses; the POST waits for this press's turn and the turn is held only
      // until the server answers, never for the generation stream.
      if (direct) {
        if (activeItem === null || turn === null) return;
        let head: SingleFillOutcome;
        try {
          head = await prepareItem(prepareContext(pressController.signal), activeItem);
        } catch (error) {
          // Retired by Stop or unmount mid-preparation: nothing is sent.
          if (isAbortError(error)) return;
          throw error;
        }
        // The working state covers preparation, not the wait for earlier presses.
        endResolvingOnce();
        await turnOrAbort(turn, pressController.signal);
        // Stop, Clear or a template switch since the press: nothing is sent or queued.
        if (!live()) return;
        if (head === null) { addToast(fillError.message ?? "Couldn't prepare the prompt — nothing to generate.", 'error'); return; }
        if ('preserve' in head) return;                                    // quota: toast already shown
        if ('backpressure' in head) {
          // Capacity at fill: the drain retries it in its place.
          if (enqueue(head.advancedItem ?? activeItem, true)) {
            addToast(CAPACITY_TOAST, 'soft');
            ensureDrain();
          }
          return;
        }
        if (head.text.length > MAX_PROMPT_CHARS) {
          addToast(`Prompt is too long — ${head.text.length} / ${MAX_PROMPT_CHARS} chars.`, 'error');
          return;
        }
        // A drain that took the queue since joins its queue instead. The
        // prepared text goes there, so a paid fill is kept (the model's
        // formatting may still run again); a press whose preparation changed
        // nothing is a user admission under the cap.
        const paid = head.text !== stripCardNotesToken(activeItem.text);
        const admitted = await admitPrepared(admission, { item: head, paid });
        // A press Stop retired after its POST was sent stays queued, as a
        // stopped drain leaves its rolls, for the next press.
        if (admitted === 'queued') {
          addToast('Added to the queue.', 'soft');
          if (!pressController.signal.aborted) ensureDrain();
        } else if (admitted === 'capacity') {
          addToast(CAPACITY_TOAST, 'soft');
          if (!pressController.signal.aborted) ensureDrain();
        }
        return;
      }

      if (turn !== null) {
        await turnOrAbort(turn, pressController.signal);
        // Stop, Clear or a template switch meanwhile discards this press, as it
        // would the head of a running drain.
        if (!live()) return;
        // A press ahead may have started a drain: join it.
        if (store().draining) {
          if (activeItem !== null) joinDrain(activeItem);
          return;
        }
      }

      // ── Non-BYOK with a QUEUE: the durable single-owner drain (pump.ts) ──
      const previousDrain = drainSettledRef.current;
      if (previousDrain) {
        await previousDrain;
        // Clear or a template switch meanwhile discards this press, as it would
        // the head of a running drain.
        if (!live()) return;
        // Another press may have taken the queue while this one waited.
        if (store().draining) {
          if (activeItem !== null) joinDrain(activeItem);
          return;
        }
      }
      const drainSettled = Promise.withResolvers<undefined>();
      drain.settled = drainSettled;
      drainSettledRef.current = drainSettled.promise;
      const drainController = new AbortController();
      drain.controller = drainController;
      drainAbortRef.current = drainController;
      store().setDraining(true);
      // Presses behind this one now see the drain and join its queue.
      turn?.release();

      // The first fireable item collapses the composer, pins the view to Unsorted,
      // and ends the button working state — triggered by the first actual fire.
      let firstFired = false;
      await runDrainPump({
        signal: drainController.signal,
        pendingHead: activeItem,
        queuedBeforeHead,
        prepareContext,
        makeRequest: makeReq,
        canTake,
        defaultSubmission: submission,
        generate,
        addToast,
        onFirstFire: () => {
          if (firstFired) return;
          firstFired = true;
          setComposerExpanded(false);
          void import('../components/ByokDialog');
          pinFeedScope();
          endResolvingOnce();
        },
        submitQueueOnly: () => { void submitDraftAsyncRef.current({ queueOnly: true }); },
      });
    } finally {
      endResolvingOnce();
      turn?.release();
      finishPress();
      // Release the single-owner drain so the next Generate can start one. Only the
      // owning run clears its own controller ref (a later run may already own it).
      if (drainAbortRef.current === drain.controller) drainAbortRef.current = null;
      if (drain.controller) store().setDraining(false);
      if (drain.settled) {
        if (drainSettledRef.current === drain.settled.promise) drainSettledRef.current = null;
        drain.settled.resolve(undefined);
      }
    }
  }, [
    draft,
    effectiveModelId,
    effectiveModel,
    effectiveDuration,
    effectiveRatio,
    fireGenerate,
    generate,
    setComposerExpanded,
    addToast,
    library,
    libraryPending,
    sequencer,
    clearCoalesceTimer,
    flushCoalesced,
  ]);

  useEffect(() => {
    submitDraftAsyncRef.current = submitDraftAsync;
  }, [submitDraftAsync]);

  useEffect(() => {
    mountedRef.current = true;
    const settlers = coalescedSettlersRef.current;
    return () => {
      mountedRef.current = false;
      drainAbortRef.current?.abort();
      retirePresses();
      abortCoalescedFlushes();
      discardCoalesced();
      for (const settle of [...settlers]) settle();
    };
  }, [retirePresses, abortCoalescedFlushes, discardCoalesced]);

  // A Generate press starts a single-owner drain that works the whole queue. A
  // press while it is running adds the active composer item to that owner's live
  // queue instead of spawning an overlapping pass.
  const submitDraft = useCallback(() => { void submitDraftAsync(); }, [submitDraftAsync]);
  // Feed actions must stay stable while the composer draft changes. Read the
  // latest admission closure through the same ref used by queue-only Resume.
  const submitPrepared = useCallback((request: GenerateRequest) => {
    void submitDraftAsyncRef.current({ preparedRequest: request });
  }, []);
  const stopDraining = useCallback(() => {
    // Presses not yet sent are retired; POSTs already sent keep their answer.
    retirePresses();
    setRetryingPrepared(false);
    abortCoalescedFlushes();
    discardCoalesced();
    for (const settle of [...coalescedSettlersRef.current]) settle();
    const controller = drainAbortRef.current;
    if (!controller) return;
    controller.abort();
    // Generate is available again at once; a new drain waits for this one to settle.
    useAtelierStore.getState().setDraining(false);
  }, [retirePresses, abortCoalescedFlushes, discardCoalesced]);

  return { submitDraft, submitPrepared, stopDraining, retryingPrepared };
}
