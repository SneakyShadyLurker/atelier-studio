import type { AiFillRequest, EnhancePromptRequest, GenerateRequest } from '@atelier/shared';
import type { QueuedRoll, RollSubmission, ToastMessage } from '../../store/atelier';
import type { ComposerLibrary } from '../resolveComposerPrompt';
import type { AiFillRequestBuild } from '../resolveAiFillItem';
import type { AdmissionTurn } from './orderedSubmission';

export interface FireItem {
  // Idempotency key of the logical roll: the queued roll's id, or the key the
  // composer press minted. Carried through preparation, capacity requeue (the
  // requeued roll's id IS this key) and Stop restoration, so a re-POST of the
  // same roll dedupes server-side. Never minted per request or per pass.
  readonly key: string;
  text: string;
  provenance: GenerateRequest['provenance'];
  /**
   * The settings of the press that made this item, carried like the key.
   * Absent on library rolls, which take the submitting press's settings.
   */
  readonly submission?: RollSubmission;
}

export interface BufferedFireItem {
  readonly item: FireItem;
  /** Ends the press's "preparing" feedback. Idempotent. */
  readonly settle: () => void;
  /** The press's place in the POST order, reserved when it was made. */
  readonly turn: AdmissionTurn;
  /**
   * False once the press may no longer be sent: Clear or a template switch
   * since it was made, or Stop. Checked before every send or queueing.
   */
  readonly live: () => boolean;
  /**
   * False once the press may no longer put work in the queue: Clear or a
   * template switch since it was made, or unmount. Unlike `live`, Stop leaves
   * it true, so a POST sent before Stop and refused later stays queued.
   */
  readonly owned: () => boolean;
  /** Pins the feed scope for this press, only while the user stays where they pressed. */
  readonly pinFeedScope: () => void;
}

/** One item of a drain pass: a queued roll, or the active composer head (`sourceRoll === null`). */
export interface PassItem {
  readonly item: FireItem;
  readonly sourceRoll: QueuedRoll | null;
}

// Outcomes of preparing one item:
//  - FireItem          → resolved, ready to fire generate.
//  - { preserve }      → QuotaExhausted (5h budget): keep the roll, STOP the
//                        drain (waiting won't free a slot for hours).
//  - { backpressure }  → QUEUE_FULL (enhance pool busy): keep the roll and KEEP
//                        draining — it retries on the next pass. Carries
//                        `advancedItem` (post-ai-fill text) so the retry skips
//                        ai-fill, which keeps the fill stable instead of re-rolling it.
//  - null              → genuine failure (refusal / over-length / invalid): a
//                        queued roll is kept but skipped for the rest of the drain;
//                        the active composer prompt is not fired.
export type SingleFillOutcome =
  | FireItem
  | { readonly preserve: true; readonly roll: QueuedRoll | null }
  | { readonly backpressure: true; readonly roll: QueuedRoll | null; readonly retryAfterMs: number; readonly advancedItem?: FireItem }
  | null;

/** A batch miss on a queued roll: it retries through a single fill on the next pass. */
export type FillOutcome =
  | SingleFillOutcome
  | { readonly deferSingle: true; readonly roll: QueuedRoll };

/** The minimal shape `groupAiFillEntries` measures. */
export interface AiFillGroupEntry {
  readonly build: { readonly request: Pick<AiFillRequest, 'staticSegments' | 'instructions'> };
}

export interface BatchReadyItem {
  readonly build: AiFillRequestBuild;
  readonly passItem: PassItem;
}

export type PreparationUnit =
  | { readonly kind: 'batch'; readonly entries: readonly BatchReadyItem[] }
  | { readonly kind: 'single'; readonly entry: PassItem };

/** Motion-enhance context forwarded with every h3-motion format request. */
export type MotionFields = Pick<EnhancePromptRequest, 'sourcePrompt' | 'durationFrames' | 'extendContext'>;

/** Everything the preparation functions read, instead of closing over the hook. */
export interface PrepareContext {
  /** Undefined when the library is gated: ai-fill tokens stay literal. */
  readonly library: ComposerLibrary | undefined;
  /**
   * The submitting press's model and motion settings. An item that carries
   * its own `submission` is prepared under those instead (`itemContext`).
   */
  readonly effectiveModelId: string;
  /** The target model takes an h3-motion enhanced prompt. */
  readonly wantsMotion: boolean;
  readonly motionFields: MotionFields;
  /** Cancels in-flight fills, formats and their retry backoff (Stop, unmount). */
  readonly signal: AbortSignal;
  readonly addToast: (text: string, tone?: ToastMessage['tone']) => string;
  /**
   * The actionable ai-fill failure message for the HEAD item (the active
   * composer prompt or the BYOK head), surfaced in place of a generic toast.
   * Only a `sourceRoll === null` item records it, so a queued roll's error can
   * never clobber the head's message under concurrent preparation.
   */
  readonly recordHeadError: (message: string) => void;
  /** A queued roll missed its batch fill and must take a single fill next pass. */
  readonly onDeferSingle: (rollId: string) => void;
  /** Save completed fill text before any subsequent asynchronous formatting. */
  readonly onFilled?: (item: FireItem) => void;
}

/** Why a taken roll was not submitted, or was refused before any batch existed. */
export type Refusal =
  /** Typed QUEUE_FULL at fill, format or generate: kept, retried after backoff. */
  | { readonly kind: 'backpressure'; readonly retryAfterMs: number }
  /** 5 h budget: the pump stops and the roll is restored. */
  | { readonly kind: 'quota' }
  /** Batch fill miss: the roll takes a single fill next pass. */
  | { readonly kind: 'deferSingle' }
  /** Genuine failure: kept in the queue, skipped for the rest of the drain. */
  | { readonly kind: 'failed' }
  /** Over the prompt limit after preparation: dropped with the aggregate toast. */
  | { readonly kind: 'overLength' }
  /** Fired, then rejected with AbortError: the batch may exist, so treated as started. */
  | { readonly kind: 'aborted' };

export type RollPhase =
  | 'taken'
  | 'preparing'
  | 'prepared'
  | 'submitting'
  | 'accepted'
  | 'refused'
  | 'restored'
  | 'retired'
  | 'dropped';

/**
 * One logical roll's lifecycle for the life of a drain pump, keyed by its
 * idempotency key (the queued roll's id, or the composer press key). A roll
 * restored and re-taken in a later pass keeps its flags and carried text.
 */
export interface RollRecord {
  readonly key: string;
  /** The consumed queued roll; null for the active composer head. */
  readonly source: QueuedRoll | null;
  /** Latest text: a paid fill is carried forward here and into persistence. */
  item: FireItem;
  phase: RollPhase;
  refusal: Refusal | null;
  /** Its batch fill missed this drain: single fill only from now on. */
  singleFillOnly: boolean;
  /** Genuinely failed this drain: kept in the queue but no longer taken. */
  failedThisDrain: boolean;
  acceptedBatchId: string | null;
  /** The generation stream while it runs; never awaited for admission. */
  stream: Promise<unknown> | null;
  /** A saved in-flight copy exists in reload persistence. */
  persisted: boolean;
}

/** What the drain pump needs from the hook for one Generate press. */
export interface DrainPumpContext {
  /** Stop: aborts preparation, backoff and every wait; streams keep running. */
  readonly signal: AbortSignal;
  /**
   * The active composer item: submitted after the rolls queued before its
   * press, and ahead of rolls queued after it.
   */
  readonly pendingHead: FireItem | null;
  /**
   * Fixed at the press, before it waited: the ids of the rolls queued or held
   * by a drain then, and the keys of earlier presses a capacity refusal may
   * still requeue. In every pass the head follows the last of these in the
   * queue and leads every other roll.
   */
  readonly queuedBeforeHead: ReadonlySet<string>;
  /** Preparation settings bound to a signal. */
  readonly prepareContext: (signal: AbortSignal) => PrepareContext;
  /** The wire request under the item's own settings, else the press's. */
  readonly makeRequest: (item: FireItem) => GenerateRequest;
  /**
   * Whether this drain may take a queued roll. A roll without its own settings
   * binds to the press's, so a press whose settings cannot carry it (BYOK,
   * video, an invalid composer) leaves it queued.
   */
  readonly canTake: (roll: QueuedRoll) => boolean;
  /**
   * The drain-starting press's settings. A taken roll without its own binds to
   * them when the pump first takes it, and keeps them through restoration,
   * reload and later passes. Absent: such a roll stays unbound and
   * `makeRequest` decides.
   */
  readonly defaultSubmission?: RollSubmission;
  readonly generate: (request: GenerateRequest, options?: { onAccepted?: (batchId: string) => void }) => Promise<unknown>;
  readonly addToast: (
    text: string,
    tone?: ToastMessage['tone'],
    durationMs?: number,
    action?: ToastMessage['action'],
  ) => string;
  /** Composer collapse, feed scope and the end of the working state. */
  readonly onFirstFire: () => void;
  /** The Retry and Resume toast actions: a queue-only press. */
  readonly submitQueueOnly: () => void;
}
