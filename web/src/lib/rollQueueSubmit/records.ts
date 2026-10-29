import type { QueuedRoll } from '../../store/atelier';
import { beginInFlight, settleInFlight } from '../rollQueuePersist';
import type { FireItem, PassItem, Refusal, RollRecord } from './types';

// Per-roll lifecycle records for one drain pump, and the reload-persistence
// bridge. A taken queued roll is saved "in flight" (consumed, not yet visible)
// until it reaches a fate: accepted or dropped settles it, restoration settles
// it and puts it back in the queue, and an epoch change (Clear, template
// switch) settles it without restoring. The saved copy always carries the
// latest text, so a reload never bills a paid fill again.

export type RollRecords = Map<string, RollRecord>;

/** Accepted, dropped and retired records never restore or re-submit. */
export function isTerminal(record: RollRecord): boolean {
  return record.phase === 'accepted' || record.phase === 'dropped' || record.phase === 'retired';
}

/** The saved and restored copy: the source roll with the latest text. */
function currentCopy(record: RollRecord): QueuedRoll | null {
  return record.source ? { ...record.source, text: record.item.text } : null;
}

function settle(records: readonly RollRecord[]): void {
  const keys: string[] = [];
  for (const record of records) {
    if (!record.persisted) continue;
    record.persisted = false;
    keys.push(record.key);
  }
  settleInFlight(keys);
}

/**
 * Takes a pass's items, in pass order. A key seen earlier in this pump keeps
 * its flags; its text comes from the item (a restored roll already carries its
 * fill). Queued rolls are saved in flight with one write.
 */
export function takeRecords(records: RollRecords, passItems: readonly PassItem[]): RollRecord[] {
  const taken = passItems.map(({ item, sourceRoll }): RollRecord => {
    const prior = records.get(item.key);
    const record: RollRecord = {
      key: item.key,
      source: sourceRoll,
      item,
      phase: 'taken',
      refusal: null,
      singleFillOnly: prior?.singleFillOnly ?? false,
      failedThisDrain: prior?.failedThisDrain ?? false,
      acceptedBatchId: null,
      stream: null,
      persisted: sourceRoll !== null,
    };
    records.set(item.key, record);
    return record;
  });
  const saved = taken.flatMap((record) => {
    const copy = record.persisted ? currentCopy(record) : null;
    return copy ? [copy] : [];
  });
  if (saved.length > 0) beginInFlight(saved);
  return taken;
}

/** A batch fill missed: the roll takes a single fill from now on. */
export function markSingleFillOnly(records: RollRecords, key: string): void {
  const record = records.get(key);
  if (record) record.singleFillOnly = true;
}

/** Preparation produced text (or a paid fill before backpressure): carry and save it. */
export function carryFill(record: RollRecord, item: FireItem): void {
  if (isTerminal(record)) return;
  record.item = item;
  if (record.phase === 'taken' || record.phase === 'preparing') record.phase = 'prepared';
  const copy = record.persisted ? currentCopy(record) : null;
  if (copy) beginInFlight([copy]);
}

/** The POST is about to go out; `stream` is the generation promise when known. */
export function markSubmitting(record: RollRecord, stream: Promise<unknown> | null): void {
  if (isTerminal(record)) return;
  record.phase = 'submitting';
  record.stream = stream;
}

/**
 * The server accepted (or a batch otherwise exists). Also applies to a roll
 * restored at Stop whose POST answered later; the caller then retires it.
 */
export function markAccepted(record: RollRecord, batchId: string | null): boolean {
  if (isTerminal(record)) return false;
  record.phase = 'accepted';
  record.refusal = null;
  record.acceptedBatchId = batchId;
  settle([record]);
  return true;
}

/** Refused or not submitted, without any batch: restorable at the end of the pass. */
export function markRefused(record: RollRecord, refusal: Refusal): boolean {
  if (isTerminal(record) || record.phase === 'restored') return false;
  record.phase = 'refused';
  record.refusal = refusal;
  if (refusal.kind === 'failed') record.failedThisDrain = true;
  return true;
}

/** Over-length or aborted after firing: settled and never restored. */
export function markDropped(record: RollRecord, refusal: Refusal): boolean {
  if (isTerminal(record)) return false;
  record.phase = 'dropped';
  record.refusal = refusal;
  settle([record]);
  return true;
}

/**
 * Puts every restorable queued roll back, in the given order, with its carried
 * text, and settles their saved copies. Returns the rolls to restore.
 */
export function restoreRecords(records: readonly RollRecord[]): QueuedRoll[] {
  const restored: RollRecord[] = [];
  const rolls: QueuedRoll[] = [];
  for (const record of records) {
    if (isTerminal(record) || record.phase === 'restored') continue;
    const copy = currentCopy(record);
    if (!copy) continue;
    record.phase = 'restored';
    restored.push(record);
    rolls.push(copy);
  }
  settle(restored);
  return rolls;
}

/** A roll restored at Stop whose batch exists after all: returns its id to retire. */
export function markRetired(record: RollRecord): string | null {
  if (record.phase === 'retired') return null;
  record.phase = 'retired';
  settle([record]);
  return record.source ? record.key : null;
}

/** Clear or a template switch: settle every saved copy; nothing restores. */
export function invalidateRecords(records: Iterable<RollRecord>): void {
  const all = [...records];
  for (const record of all) {
    if (!isTerminal(record) && record.source !== null) record.phase = 'dropped';
  }
  settle(all);
}

/** Settles every saved copy still held (pump exit). */
export function settleRecords(records: Iterable<RollRecord>): void {
  settle([...records]);
}

/**
 * Drops terminal records from the map, keeping only their keys: a long-lived
 * pump must not retain every accepted roll. A late answer still reaches its
 * record through the submission that holds it.
 */
export function pruneSettled(records: RollRecords, settledKeys: Set<string>): void {
  for (const [key, record] of records) {
    if (!isTerminal(record)) continue;
    records.delete(key);
    settledKeys.add(key);
  }
}
