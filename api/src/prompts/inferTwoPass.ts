import type { LibrarySnapshot, RawInferOp, SnapList } from './inferTypes';
import { resolveProposal } from './dimensionResolver';

// Each fully-formed assignOptionTags op (op verb + listIdx + optionIdx + 1-2
// tag refs) lands at ~25 output tokens once JSON-stringified. A library with
// many options can therefore project past the model's completion ceiling
// (32K) before the input snapshot itself trips the input limit — silently
// truncating the response.
// Force two-pass when EITHER input or projected output exceeds its budget.
const TOKENS_PER_ASSIGN_OP = 25;

function projectedAssignOutputTokens(optionCount: number): number {
  return optionCount * TOKENS_PER_ASSIGN_OP;
}

export function needsTwoPass(
  snapshotJson: string,
  optionCount: number,
  maxInputTokens: number,
  maxOutputBudgetTokens: number,
): boolean {
  if (Math.ceil(snapshotJson.length / 4) > maxInputTokens) return true;
  if (projectedAssignOutputTokens(optionCount) > maxOutputBudgetTokens) return true;
  return false;
}

// Pass 1 sees names + up to `sample` option values per list (taxonomy only).
// Pass 2 tags each list given the fixed taxonomy (one batch per list).
export function splitForTwoPass(
  snap: LibrarySnapshot,
  sample: number,
): { taxonomySnap: LibrarySnapshot; listBatches: LibrarySnapshot['lists'][] } {
  const taxonomySnap: LibrarySnapshot = {
    dimensions: snap.dimensions,
    lists: snap.lists.map((list) => ({ ...list, options: list.options.slice(0, sample) })),
  };
  return { taxonomySnap, listBatches: snap.lists.map((list) => [list]) };
}

// Default chunk size for Pass-2 dispatch. 30 options × ~25 tokens per
// assignOptionTags op ≈ 750 output tokens per call — comfortably under any
// reasoning model's per-call ceiling, and small enough that attention doesn't
// degrade across a wall of options. The whole-library `outfit` (104) /
// `Job` (96) / `location` (71) batches that were silently bottoming out on
// coverage now split into 3-4 calls that fan out under runBatchesParallel.
export const DEFAULT_CHUNK_SIZE = 30;

// A single per-list, per-slice batch for Pass 2. The `optionOffset` is the
// global option index of the first option in `list.options`; the model sees
// LOCAL indices (0..list.options.length-1) and remapBatchOps rewrites them
// back to global on the way out.
export interface ChunkedBatch {
  list: SnapList;
  optionOffset: number;
}

// Splits each Pass-2 list into one or more chunks of at most `chunkSize`
// options. Lists shorter than the chunk size produce a single chunk with
// offset 0. The original list metadata (id, name) is preserved on every
// chunk; options in the slice are re-indexed to LOCAL 0..N-1 so the model
// sees a consistent integer scheme regardless of which chunk is in flight.
// remapChunkOps rewrites the local optionIdx back to the global space using
// `optionOffset`. Returned in stable order: list 0 chunks first, list 1
// chunks second, etc.
export function chunkListBatches(
  lists: readonly SnapList[],
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): ChunkedBatch[] {
  const size = Math.max(1, chunkSize);
  const out: ChunkedBatch[] = [];
  for (const list of lists) {
    if (list.options.length <= size) {
      out.push({ list, optionOffset: 0 });
      continue;
    }
    for (let start = 0; start < list.options.length; start += size) {
      const slice = list.options.slice(start, start + size).map((o, localIdx) => ({
        ...o,
        idx: localIdx,
      }));
      out.push({
        list: { ...list, options: slice },
        optionOffset: start,
      });
    }
  }
  return out;
}

// Variant of remapBatchOps that also adds an `optionOffset` to every
// assignOptionTags op's `optionIdx`. Used by the chunked dispatch path: the
// model sees local 0..N indices into the slice; we rewrite them back to the
// list's global option index space before resolveProposal consumes them.
//
// `originalListIdx` is the global list idx (chunks share it). Out-of-range
// (sliceLen-overflow) optionIdxs are dropped rather than corrupting list[0].
export function remapChunkOps(
  ops: readonly RawInferOp[],
  originalListIdx: number,
  optionOffset: number,
  sliceLen: number,
): RawInferOp[] {
  const out: RawInferOp[] = [];
  for (const op of ops) {
    if (op.op !== 'assignOptionTags') {
      out.push(op);
      continue;
    }
    if (op.optionIdx < 0 || op.optionIdx >= sliceLen) continue;
    out.push({
      ...op,
      listIdx: originalListIdx,
      optionIdx: op.optionIdx + optionOffset,
    });
  }
  return out;
}

// Pass 2 addresses the actual accepted taxonomy, whose indices can shift
// after merges or rejected creations. Resolve through stable dimension IDs
// before combining with Pass 1 against the original snapshot. New dimensions
// use the preview's synthetic identity; their added tags fold into the accepted
// creation. Pass-1 ops are mutated in place, so the caller owns that array.
export function reconcilePass2AddTags(
  pass1Ops: RawInferOp[],
  pass2Ops: readonly RawInferOp[],
  original: LibrarySnapshot,
  enriched: LibrarySnapshot,
): RawInferOp[] {
  const acceptedCreationById = new Map<string, Extract<RawInferOp, { op: 'createDimension' }>>();
  for (const bundle of resolveProposal(pass1Ops, original).rawBundles) {
    for (const [index, op] of bundle.ops.entries()) {
      if (op.op !== 'createDimension') continue;
      const ordinal = bundle.opOrder?.[index];
      const originalOp = ordinal === undefined ? undefined : pass1Ops[ordinal];
      if (originalOp?.op === 'createDimension') acceptedCreationById.set(`new:${op.name}`, originalOp);
    }
  }
  const originalIdxById = new Map(original.dimensions.map((dim) => [dim.id, dim.idx]));
  const originalIdx = (idx: number): number | undefined => {
    const dim = enriched.dimensions[idx];
    return dim === undefined ? undefined : originalIdxById.get(dim.id);
  };
  const out: RawInferOp[] = [];
  for (const op of pass2Ops) {
    if (op.op === 'addTags') {
      const idx = originalIdx(op.dimIdx);
      if (idx !== undefined) {
        out.push({ ...op, dimIdx: idx });
        continue;
      }
      const dim = enriched.dimensions[op.dimIdx];
      const creation = dim && acceptedCreationById.get(dim.id);
      if (creation?.op === 'createDimension') {
        const existing = new Set(creation.tags);
        for (const label of op.tags) {
          if (!existing.has(label)) {
            creation.tags.push(label);
            existing.add(label);
          }
        }
      }
      continue;
    }
    if (op.op === 'renameDimension') {
      const idx = originalIdx(op.dimIdx);
      if (idx !== undefined) out.push({ ...op, dimIdx: idx });
      continue;
    }
    if (op.op === 'mergeDimensions') {
      const fromIdx = originalIdx(op.fromIdx);
      const intoIdx = originalIdx(op.intoIdx);
      if (fromIdx !== undefined && intoIdx !== undefined) out.push({ ...op, fromIdx, intoIdx });
      continue;
    }
    out.push(op);
  }
  return out;
}

// Remap each batch op's per-batch `listIdx` (0..batchLen-1, what the model
// emits because it only saw the batch's lists) back to its ORIGINAL idx in
// the full snapshot. Without this, every per-list batch's assignOptionTags
// resolves to snap.lists[0] downstream — silently overwriting list[0]'s
// options with assignments meant for list[1..N]. Ops that
// don't carry a listIdx (createDimension/addTags/renameDimension/
// mergeDimensions) pass through untouched. Out-of-range listIdx is treated
// as misaddressed and dropped rather than corrupting list[0].
export function remapBatchOps(
  ops: readonly RawInferOp[],
  batch: readonly SnapList[],
): RawInferOp[] {
  const out: RawInferOp[] = [];
  for (const op of ops) {
    if (op.op !== 'assignOptionTags') {
      out.push(op);
      continue;
    }
    const original = batch[op.listIdx];
    if (!original) continue;
    out.push({ ...op, listIdx: original.idx });
  }
  return out;
}

// Runs N task thunks with at most `concurrency` in flight, preserving result
// order. A task that resolves to `null` is treated as a failure: no further
// tasks are dispatched, and the whole call resolves to `null` once already-
// in-flight tasks settle.
//
// On first failure, `options.onFirstFailure?.()` fires synchronously inside
// the worker that observed the null. Callers wire this to abort the
// AbortSignal their tasks close over — in-flight upstream fetches reject
// immediately instead of running to completion (and burning compute /
// tokens) after the SSE response has already been resolved to an error.
// Workers swallow the resulting AbortError as long as `state.failed` is
// already set, so the deliberate cancellation never propagates out as a
// caller-visible throw.
//
// Two-pass + parallel dispatch is the structural fix for the 522-option
// library that timed out at the 300s upstream watchdog: each batch becomes a
// small per-list call, and several batches run concurrently, so wallclock no
// longer scales linearly with list count.
export async function runBatchesParallel<T>(
  tasks: readonly (() => Promise<T | null>)[],
  concurrency: number,
  options?: { onFirstFailure?: () => void },
): Promise<T[] | null> {
  if (tasks.length === 0) return [];
  // Queue holds tasks paired with their original index so workers can
  // shift() concurrently and still know where to write each result.
  const queue: { run: () => Promise<T | null>; index: number }[] =
    tasks.map((run, index) => ({ run, index }));
  const results: (T | null)[] = new Array<T | null>(tasks.length);
  // `failed` lives on an object so the closure mutation isn't narrowed away
  // by typescript-eslint's no-unnecessary-condition flow analysis (which
  // doesn't follow `let` reassignments through awaited closures).
  const state = { failed: false };
  const cap = Math.max(1, Math.min(concurrency, tasks.length));
  let firstFailureFired = false;
  const triggerFailure = (): void => {
    state.failed = true;
    if (firstFailureFired) return;
    firstFailureFired = true;
    options?.onFirstFailure?.();
  };
  const worker = async (): Promise<void> => {
    while (!state.failed) {
      const job = queue.shift();
      if (!job) return;
      try {
        const r = await job.run();
        if (r === null) { triggerFailure(); return; }
        results[job.index] = r;
      } catch (err) {
        // A sibling worker may have triggered onFirstFailure, which the
        // caller wired to abort the upstream signal — our in-flight fetch
        // then rejected with AbortError. Drain quietly in that case; only
        // re-throw if this exception arrived BEFORE any failure was
        // observed (real bug / non-abort upstream throw). ESLint's
        // no-unnecessary-condition flow analysis still narrows
        // `state.failed` to `false` here because we entered the loop with
        // !state.failed and it doesn't model mutations across awaits in a
        // sibling closure — the runtime check is real.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (state.failed) return;
        triggerFailure();
        throw err;
      }
    }
  };
  // allSettled (not Promise.all) so every worker is awaited even after one
  // rejects — otherwise a sibling's later non-abort rejection escapes as an
  // unhandledRejection. Re-throw the first real failure deliberately.
  const settled = await Promise.allSettled(Array.from({ length: cap }, () => worker()));
  const rejected = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;
  if (state.failed) return null;
  return results as T[];
}

export interface PartialBatchResult<T> {
  readonly results: readonly (T | null)[];
  readonly failedIndexes: readonly number[];
}

export async function runBatchesPartial<T>(
  tasks: readonly (() => Promise<T | null>)[],
  concurrency: number,
  options?: {
    readonly onTaskComplete?: (index: number, ok: boolean) => void;
    readonly signal?: AbortSignal;
  },
): Promise<PartialBatchResult<T>> {
  if (tasks.length === 0) return { results: [], failedIndexes: [] };
  const results: (T | null)[] = new Array<T | null>(tasks.length).fill(null);
  const completed = new Array<boolean>(tasks.length).fill(false);
  const queue: { run: () => Promise<T | null>; index: number }[] =
    tasks.map((run, index) => ({ run, index }));
  const cap = Math.max(1, Math.min(concurrency, tasks.length));
  const signal = options?.signal;
  const stop = () => signal?.aborted === true;

  const worker = async (): Promise<void> => {
    while (!stop()) {
      const job = queue.shift();
      if (!job) return;
      const result = await job.run();
      results[job.index] = result;
      completed[job.index] = true;
      options?.onTaskComplete?.(job.index, result !== null);
    }
  };

  const settled = await Promise.allSettled(Array.from({ length: cap }, () => worker()));
  // Workers have no onFirstFailure drain, so two genuine rejections can land in
  // the same settle. Throw a lone reason verbatim (preserves error identity for
  // the caller); aggregate ≥2 so every reason reaches the route's `{ err }` log
  // instead of only the first.
  const reasons = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r): unknown => r.reason);
  if (reasons.length === 1) throw reasons[0];
  if (reasons.length > 1) throw new AggregateError(reasons, `${String(reasons.length)} infer batch workers rejected`);

  const failedIndexes: number[] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    if (!completed[i] || results[i] === null) failedIndexes.push(i);
  }
  return { results, failedIndexes };
}
