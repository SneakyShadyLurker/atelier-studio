import type { Database } from 'bun:sqlite';
import type { Config } from '../config';
import { reportIfCorruption } from '../db/integrity';
import type { AppLogger } from '../observability/logger';
import { findModel } from '../providers/registry';
import { countPromptWords, KREA_PROMPT_CONDENSE_TRIGGER_WORDS, promptWordBudgetForModel } from '../prompts/promptBudget';
import { condenseBatchPrompt } from './condenseBatchPrompt';
import * as queue from './queue';
import { getBatchForUser, preRegisterBatch, setBatchDonePromise, unregisterBatch, type BatchEntry } from './registry';

const MAX_PREPARERS = 2;

interface PreparationRuntime {
  readonly db: Database;
  readonly config: Config;
  readonly logger: AppLogger;
  readonly kickLocalQueue: () => void;
}

interface PreparationJob {
  readonly runtime: PreparationRuntime;
  readonly entry: queue.QueueEntry;
  readonly original: string;
  readonly registered: BatchEntry;
  readonly done: Promise<void>;
  readonly finish: () => void;
}

let runtime: PreparationRuntime | null = null;
let unsubscribe: (() => void) | undefined;
const jobs = new Set<PreparationJob>();

export function needsQueuedPromptPreparation(modelId: string, prompt: string): boolean {
  return promptWordBudgetForModel(modelId) !== null
    && countPromptWords(prompt) > KREA_PROMPT_CONDENSE_TRIGGER_WORDS;
}

function current(job: PreparationJob): boolean {
  return runtime === job.runtime && job.entry.epoch === queue.currentEpoch();
}

function livePrompt(configured: PreparationRuntime, entry: queue.QueueEntry): string | undefined {
  return configured.db.query<{ prompt: string }, [string, string]>(
    `SELECT prompt FROM batches b WHERE id = ? AND user_id = ?
       AND status = 'queued' AND archived_at IS NULL
       AND EXISTS (SELECT 1 FROM tiles t WHERE t.batch_id = b.id
         AND t.user_id = b.user_id AND t.status = 'loading' AND t.archived_at IS NULL)`,
  ).get(entry.batchId, entry.userId)?.prompt;
}

function logFailure(configured: PreparationRuntime, error: unknown): void {
  if (!reportIfCorruption(error, configured.logger, { phase: 'queued_prompt_preparation' })) {
    configured.logger.error({ err: error }, 'queued prompt preparation failed');
  }
}

export function configureQueuedPromptPreparation(next: PreparationRuntime): void {
  unsubscribe?.();
  for (const job of jobs) job.registered.batchController.abort();
  runtime = next;
  unsubscribe = queue.subscribeQueueChanges(() => { prepareQueuedPrompts(next.db); });
}

export function stopQueuedPromptPreparation(): Promise<unknown[]> {
  runtime = null;
  unsubscribe?.();
  unsubscribe = undefined;
  for (const job of jobs) job.registered.batchController.abort();
  return Promise.allSettled([...jobs].map((job) => job.done));
}

// Called synchronously before local admission: mark EVERY long prompt pending
// before starting any asynchronous work, including reconstructed queue rows.
export function prepareQueuedPrompts(db: Database): boolean {
  const configured = runtime;
  if (configured?.db !== db) return false;
  for (const job of jobs) {
    if (!current(job) || !queue.entries('local').some((entry) =>
      entry.batchId === job.entry.batchId && entry.epoch === job.entry.epoch)) {
      job.registered.batchController.abort();
    }
  }
  try {
    for (const entry of [...queue.entries('local')]) {
      if (entry.promptPreparation !== undefined) continue;
      // An old epoch/runtime can still own this batch's registry controller
      // while its canceled provider unwinds. Keep even a newly short prompt
      // pending until that owner retires, then use a fresh controller.
      const previousOwner = [...jobs].some((job) => job.entry.batchId === entry.batchId);
      if (previousOwner) {
        queue.setPromptPreparation(entry.batchId, entry.epoch, 'pending');
        continue;
      }
      const prompt = livePrompt(configured, entry);
      if (prompt === undefined) { queue.removeById('local', entry.batchId); continue; }
      const registered = findModel(entry.modelId, configured.config);
      const eligible = registered?.model.pool === 'local'
        && configured.config.LOCAL_MODELS_USERS.has(entry.userId);
      const needsPreparation = eligible && needsQueuedPromptPreparation(entry.modelId, prompt);
      queue.setPromptPreparation(entry.batchId, entry.epoch, needsPreparation ? 'pending' : 'ready');
    }
    for (const entry of queue.entries('local')) {
      if (jobs.size >= MAX_PREPARERS) break;
      if (entry.promptPreparation !== 'pending' || [...jobs].some((job) => job.entry.batchId === entry.batchId)) continue;
      const original = livePrompt(configured, entry);
      if (original === undefined) continue;
      const registered = preRegisterBatch(entry.batchId, entry.userId);
      let finish: () => void = () => undefined;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const job: PreparationJob = { runtime: configured, entry, original, registered, done, finish };
      jobs.add(job);
      setBatchDonePromise(entry.batchId, done);
      void runPreparation(job);
    }
  } catch (error) {
    logFailure(configured, error);
    // A transient preparation read must not consume the last dispatch wakeup.
    // Fail open once for unowned entries; normal dequeue revalidates them.
    // Owners from every runtime/epoch keep their controller until retirement.
    const owned = new Set([...jobs].map((job) => job.entry.batchId));
    for (const entry of queue.entries('local')) {
      queue.setPromptPreparation(entry.batchId, entry.epoch, owned.has(entry.batchId) ? 'pending' : 'ready');
    }
  }
  return true;
}

async function runPreparation(job: PreparationJob): Promise<void> {
  const { entry, registered, runtime: configured } = job;
  let ready = false;
  let retry = false;
  try {
    const prompt = await condenseBatchPrompt(job.original, entry.modelId, {
      ...configured, userId: entry.userId, signal: registered.batchController.signal,
    });
    if (!current(job) || registered.batchController.signal.aborted) return;
    if (prompt === job.original) ready = livePrompt(configured, entry) === job.original;
    else {
      const result = configured.db.query(
        `UPDATE batches SET prompt = ? WHERE id = ? AND user_id = ? AND prompt = ?
           AND status = 'queued' AND archived_at IS NULL
           AND EXISTS (SELECT 1 FROM tiles t WHERE t.batch_id = batches.id
             AND t.user_id = batches.user_id AND t.status = 'loading' AND t.archived_at IS NULL)`,
      ).run(prompt, entry.batchId, entry.userId, job.original);
      ready = result.changes > 0;
    }
    if (!ready) {
      retry = livePrompt(configured, entry) !== undefined;
      if (!retry) queue.removeById('local', entry.batchId);
    }
  } catch (error) {
    if (current(job) && !registered.batchController.signal.aborted) {
      logFailure(configured, error);
      ready = true; // Fail open; dequeue still revalidates ownership/liveness.
    }
  } finally {
    jobs.delete(job);
    if (getBatchForUser(entry.batchId, entry.userId) === registered) unregisterBatch(entry.batchId);
    job.finish();
    // Retire the preparer's registry entry BEFORE readiness can dispatch a
    // pipeline under the same batch id. Late cleanup cannot unregister it.
    if (current(job) && !registered.batchController.signal.aborted) {
      if (ready) queue.setPromptPreparation(entry.batchId, entry.epoch, 'ready');
      else if (retry) queue.setPromptPreparation(entry.batchId, entry.epoch, undefined);
    }
    queueMicrotask(() => {
      const active = runtime;
      if (!active) return;
      try {
        if (prepareQueuedPrompts(active.db)) active.kickLocalQueue();
      } catch (error) { logFailure(active, error); }
    });
  }
}
