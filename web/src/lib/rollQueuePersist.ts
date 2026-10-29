import {
  MAX_TILE_COUNT,
  RATIO_VALUES,
  isVideoDurationFrames,
  type MotionEnhanceExtendContext,
  type Ratio,
  type VideoDurationFrames,
} from '@atelier/shared';
import type { QueuedRoll, RollSubmission, RollSubmissionRequest } from '../store/atelier';
import { isRecord } from './guards';
import { pinsFromEntries } from './promptPins';
import { isSessionLocked } from './sessionScope';

export const ROLL_QUEUE_STORAGE_KEY_PREFIX = 'atelier.rollQueue.v1';

// Admission cap: visible rolls plus consumed rolls still in flight (stashRoll).
export const MAX_ROLL_QUEUE_ENTRIES = 200;
// Storage guard against corrupt data only. System requeues and Undo may lift a
// legitimate queue above the admission cap, so this bound must sit above it.
const MAX_STORED_ROLL_ENTRIES = 2 * MAX_ROLL_QUEUE_ENTRIES;
const SOURCES: ReadonlySet<QueuedRoll['source']> = new Set([
  'template',
  'sweep',
  'brainstorm',
  'composer',
]);

let activeStorageKey: string | undefined;
let latestStoreRolls: readonly QueuedRoll[] = [];
const inFlightRolls = new Map<string, QueuedRoll>();

export function rollQueueStorageKey(cacheScope: string): string {
  return `${ROLL_QUEUE_STORAGE_KEY_PREFIX}:${cacheScope}`;
}

export function setRollQueueScope(cacheScope: string): void {
  if (isSessionLocked()) return;
  activeStorageKey = rollQueueStorageKey(cacheScope);
  latestStoreRolls = [];
  inFlightRolls.clear();
}

function parseProvenance(value: unknown): QueuedRoll['provenance'] | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.templateId !== 'string' || typeof value.rollSeed !== 'number' || !isRecord(value.pins)) {
    return undefined;
  }
  const entries: [string, string][] = [];
  for (const [key, pin] of Object.entries(value.pins)) {
    if (typeof pin !== 'string') return undefined;
    entries.push([key, pin]);
  }
  // Assignment would turn a legal `__proto__` list-name pin into a prototype
  // write and drop it.
  return { templateId: value.templateId, rollSeed: value.rollSeed, pins: pinsFromEntries(entries) };
}

const RATIOS: ReadonlySet<string> = new Set(RATIO_VALUES);
const INVALID = Symbol('invalid');

const isString = (value: unknown): value is string => typeof value === 'string';
const isId = (value: unknown): value is string => isString(value) && value.length > 0;
const isIdList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isId);
const isRatio = (value: unknown): value is Ratio => isString(value) && RATIOS.has(value);
const isTileCount = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TILE_COUNT
);
const isSeed = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isDurationFrames = (value: unknown): value is VideoDurationFrames => (
  typeof value === 'number' && isVideoDurationFrames(value)
);
const isExtendContext = (value: unknown): value is MotionEnhanceExtendContext => (
  isRecord(value) && isString(value.previousMotionPrompt) && isId(value.handoffUploadId)
);

/** An optional field: absent, valid, or INVALID, which rejects its whole record. */
function optionalField<T>(value: unknown, valid: (candidate: unknown) => candidate is T): T | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  return valid(value) ? value : INVALID;
}

function parseSubmissionRequest(value: unknown): RollSubmissionRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { modelId, ratio, count } = value;
  if (!isId(modelId) || !isRatio(ratio) || !isTileCount(count)) return undefined;
  const refImageIds = optionalField(value.refImageIds, isIdList);
  const i2vSourceUploadId = optionalField(value.i2vSourceUploadId, isId);
  const extendsTileId = optionalField(value.extendsTileId, isId);
  const motionPrompt = optionalField(value.motionPrompt, isString);
  const durationFrames = optionalField(value.durationFrames, isDurationFrames);
  if (
    refImageIds === INVALID
    || i2vSourceUploadId === INVALID
    || extendsTileId === INVALID
    || motionPrompt === INVALID
    || durationFrames === INVALID
  ) return undefined;
  return {
    modelId,
    ratio,
    count,
    ...(refImageIds !== undefined ? { refImageIds: [...refImageIds] } : {}),
    ...(i2vSourceUploadId !== undefined ? { i2vSourceUploadId } : {}),
    ...(extendsTileId !== undefined ? { extendsTileId } : {}),
    ...(motionPrompt !== undefined ? { motionPrompt } : {}),
    ...(durationFrames !== undefined ? { durationFrames } : {}),
  };
}

function parseMotionFields(value: unknown): RollSubmission['motionFields'] | undefined {
  if (!isRecord(value)) return undefined;
  const sourcePrompt = optionalField(value.sourcePrompt, isString);
  const durationFrames = optionalField(value.durationFrames, isDurationFrames);
  const extendContext = optionalField(value.extendContext, isExtendContext);
  if (sourcePrompt === INVALID || durationFrames === INVALID || extendContext === INVALID) return undefined;
  return {
    ...(sourcePrompt !== undefined ? { sourcePrompt } : {}),
    ...(durationFrames !== undefined ? { durationFrames } : {}),
    ...(extendContext !== undefined ? {
      extendContext: {
        previousMotionPrompt: extendContext.previousMotionPrompt,
        handoffUploadId: extendContext.handoffUploadId,
      },
    } : {}),
  };
}

/**
 * A saved roll's press settings. Invalid settings are dropped, not the roll:
 * like a roll saved before the field existed, it then binds to the press that
 * submits it, so no queued work is lost.
 */
function parseSubmission(value: unknown): RollSubmission | undefined {
  if (!isRecord(value)) return undefined;
  const request = parseSubmissionRequest(value.request);
  const motionFields = parseMotionFields(value.motionFields);
  const { wantsMotion } = value;
  const savedSeed = value.lockedSeed;
  const lockedSeed = savedSeed === null ? null : optionalField(savedSeed, isSeed);
  if (
    request === undefined
    || motionFields === undefined
    || typeof wantsMotion !== 'boolean'
    || lockedSeed === undefined
    || lockedSeed === INVALID
    || (value.prepared !== undefined && value.prepared !== true)
  ) return undefined;
  return { request, lockedSeed, wantsMotion, motionFields, ...(value.prepared === true ? { prepared: true } : {}) };
}

function parseQueuedRoll(value: unknown): QueuedRoll | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string'
    || value.id.length === 0
    || typeof value.text !== 'string'
    || value.text.length === 0
    || typeof value.seed !== 'number'
    || !Number.isInteger(value.seed)
    || value.seed < 0
    || typeof value.source !== 'string'
    || !SOURCES.has(value.source as QueuedRoll['source'])
  ) return null;

  const provenance = value.provenance === undefined ? undefined : parseProvenance(value.provenance);
  const submission = value.submission === undefined ? undefined : parseSubmission(value.submission);
  return {
    id: value.id,
    text: value.text,
    seed: value.seed,
    source: value.source as QueuedRoll['source'],
    ...(provenance ? { provenance } : {}),
    ...(submission ? { submission } : {}),
  };
}

export function loadRollQueue(): readonly QueuedRoll[] {
  if (isSessionLocked()) return [];
  const key = activeStorageKey;
  if (!key) return [];
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.rolls)) return [];
    const rolls: QueuedRoll[] = [];
    for (const value of parsed.rolls) {
      const roll = parseQueuedRoll(value);
      if (roll) rolls.push(roll);
      if (rolls.length >= MAX_STORED_ROLL_ENTRIES) break;
    }
    return rolls;
  } catch {
    return [];
  }
}

function writeRollQueue(): void {
  if (isSessionLocked()) return;
  const key = activeStorageKey;
  if (!key) return;
  // Optimistically consumed rolls precede anything stashed while their pass is
  // in flight. Preserve that order on reload, just like restoreRollQueue does.
  const combined: QueuedRoll[] = [];
  const storeIds = new Set(latestStoreRolls.map((roll) => roll.id));
  for (const roll of inFlightRolls.values()) {
    if (!storeIds.has(roll.id)) combined.push(roll);
  }
  combined.push(...latestStoreRolls);
  try {
    sessionStorage.setItem(
      key,
      // Admission owns the cap and counts in-flight rolls; this slice only
      // protects against corrupt callers and never truncates a legitimate queue.
      JSON.stringify({ rolls: combined.slice(0, MAX_STORED_ROLL_ENTRIES) }),
    );
  } catch {
    // sessionStorage can be unavailable or full; the in-memory queue remains authoritative.
  }
}

export function persistRollQueue(rolls: readonly QueuedRoll[]): void {
  latestStoreRolls = rolls;
  writeRollQueue();
}

/** Consumed rolls still in flight that are not also visible in the queue. */
export function unsettledInFlightCount(visibleIds: ReadonlySet<string>): number {
  let count = 0;
  for (const id of inFlightRolls.keys()) {
    if (!visibleIds.has(id)) count += 1;
  }
  return count;
}

/**
 * IDs of consumed rolls still in flight, from memory. Live ordering reads this,
 * never sessionStorage, which may be unavailable or full.
 */
export function inFlightRollIds(): readonly string[] {
  if (isSessionLocked()) return [];
  return [...inFlightRolls.keys()];
}

export function beginInFlight(rolls: readonly QueuedRoll[]): void {
  for (const roll of rolls) inFlightRolls.set(roll.id, roll);
  // A crash after the provider accepted a batch but before settlement can re-fire
  // that roll after reload; preserving not-yet-classified work favors at-least-once.
  writeRollQueue();
}

export function settleInFlight(ids: readonly string[]): void {
  if (ids.length === 0) return;
  for (const id of ids) inFlightRolls.delete(id);
  writeRollQueue();
}
