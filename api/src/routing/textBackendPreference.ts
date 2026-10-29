import type { Database } from 'bun:sqlite';
import type {
  AiFillBackend,
  TextBackendEfforts,
  TextBackendOverrides,
  TextBackendWorkload,
  TextReasoningEffort,
} from '@atelier/shared';
import {
  AI_FILL_BACKEND_VALUES,
  isVisionTextBackend,
  TEXT_BACKEND_WORKLOADS,
  textBackendReasoningEfforts,
} from '@atelier/shared';
import { ensureUser } from '../db/users';
import { isSunburstModel } from '../prompts/gptSystemPrompt';
import { isTextBackendUnavailable } from './textBackendAvailability';

interface OverrideRow {
  readonly workload: string;
  readonly backend: string;
  readonly effort: string | null;
}

/** Single validator over the backend union for values read back from the DB. */
function isStoredBackend(backend: string): backend is AiFillBackend {
  return (AI_FILL_BACKEND_VALUES as readonly string[]).includes(backend);
}

function isStoredWorkload(workload: string): workload is TextBackendWorkload {
  return (TEXT_BACKEND_WORKLOADS as readonly string[]).includes(workload);
}

/** A stored effort counts only while it is still valid for its row's backend. */
function storedEffortFor(backend: AiFillBackend, effort: string | null): TextReasoningEffort | null {
  if (effort === null) return null;
  return textBackendReasoningEfforts(backend).find((value) => value === effort) ?? null;
}

function readRows(db: Database, userId: string): readonly OverrideRow[] {
  return db
    .query<OverrideRow, [string]>('SELECT workload, backend, effort FROM user_text_backends WHERE user_id = ?')
    .all(userId);
}

/**
 * Absent rows mean automatic routing — there is deliberately no stored 'auto' value.
 * Rows for a workload that no longer exists stay inert rather than reaching the wire.
 */
export function readTextBackendOverrides(db: Database, userId: string): TextBackendOverrides {
  const overrides: TextBackendOverrides = {};
  for (const row of readRows(db, userId)) {
    if (isStoredWorkload(row.workload) && isStoredBackend(row.backend)) {
      overrides[row.workload] = row.backend;
    }
  }
  return overrides;
}

/** Pinned efforts, keyed like the overrides they belong to; absent = backend default. */
export function readTextBackendEfforts(db: Database, userId: string): TextBackendEfforts {
  const efforts: TextBackendEfforts = {};
  for (const row of readRows(db, userId)) {
    if (!isStoredWorkload(row.workload) || !isStoredBackend(row.backend)) continue;
    const effort = storedEffortFor(row.backend, row.effort);
    if (effort !== null) efforts[row.workload] = effort;
  }
  return efforts;
}

/**
 * Pins `backend` for `workload`, or clears the pin (and its effort) when null.
 * `effort` undefined keeps the stored effort while the new backend still
 * accepts it; null clears it. Callers validate an explicit effort against
 * `textBackendReasoningEfforts(backend)` first.
 */
export function writeTextBackendOverride(
  db: Database,
  userId: string,
  workload: TextBackendWorkload,
  backend: AiFillBackend | null,
  effort?: TextReasoningEffort | null,
  now: number = Date.now(),
): void {
  if (backend === null) {
    db.query('DELETE FROM user_text_backends WHERE user_id = ? AND workload = ?').run(userId, workload);
    return;
  }
  const nextEffort = effort === undefined
    ? storedEffortFor(backend, db
        .query<{ effort: string | null }, [string, string]>(
          'SELECT effort FROM user_text_backends WHERE user_id = ? AND workload = ?',
        )
        .get(userId, workload)?.effort ?? null)
    : effort;
  // The FK to users(id) requires the row.
  ensureUser(db, userId);
  db.query(`
    INSERT INTO user_text_backends (user_id, workload, backend, effort, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, workload) DO UPDATE SET
      backend = excluded.backend,
      effort = excluded.effort,
      updated_at = excluded.updated_at
  `).run(userId, workload, backend, nextEffort, now);
}

export interface ResolveTextBackendOptions {
  /** Validated image target, when the workload belongs to an image workflow. */
  readonly targetModelId?: string;
  /** Target image model's pool; unknown targets cannot use the cloud-only backend. */
  readonly targetPool?: 'cloud' | 'local';
  /** The call carries an image, so only a vision-capable backend may hold it. */
  readonly visionRequired?: boolean;
}

/**
 * Backends automatic routing may select: Kimi, and GPT for cloud image targets.
 * Every other backend is user-selectable only, and this type makes any of them
 * as an automatic target fail to compile rather than relying on convention.
 */
export type AutoTextBackend = Extract<AiFillBackend, 'kimi' | 'gpt'>;

/**
 * Single source of truth for per-workload text-backend routing. Every call
 * site supplies its automatic decision as `auto`.
 * Sunburst's validated cloud context is fixed before considering preferences.
 * 1. Read the stored override, which is authoritative and uniform on every backend,
 *    unless the proxy inventory currently lacks its model (then it is absent).
 * 2. GPT is never a stored preference (the settings PUT rejects it): a legacy
 *    GPT row routes as Auto on every target, including BYOK cloud targets.
 *    Sunburst reaches GPT only through the fixed context above. Apply the
 *    cloud-only constraint against `targetPool`, never an image model name:
 *    local or unknown targets replace a GPT Auto with Kimi.
 * 3. If vision is required, use a vision-capable override, then a vision-capable
 *    Auto, then Kimi. Otherwise use the eligible override or Auto unchanged.
 */
export function resolveTextBackend(
  db: Database,
  userId: string,
  workload: TextBackendWorkload,
  auto: AutoTextBackend,
  opts?: ResolveTextBackendOptions,
): AiFillBackend {
  // Sunburst's associated text work is fixed to GPT, independently of stored preferences.
  if (opts?.targetPool === 'cloud' && isSunburstModel(opts.targetModelId)) return 'gpt';
  const row = db
    .query<{ backend: string }, [string, string]>(
      'SELECT backend FROM user_text_backends WHERE user_id = ? AND workload = ?',
    )
    .get(userId, workload);
  let override = row && isStoredBackend(row.backend) ? row.backend : null;
  // A pin whose model the proxy does not currently serve routes as Auto.
  if (override !== null && isTextBackendUnavailable(override)) override = null;
  if (override === 'gpt') override = null;
  if (opts?.targetPool !== 'cloud' && auto === 'gpt') auto = 'kimi';
  if (opts?.visionRequired === true) {
    return override !== null && isVisionTextBackend(override)
      ? override
      : isVisionTextBackend(auto) ? auto : 'kimi';
  }
  return override ?? auto;
}

/**
 * The user's pinned effort for a workload, applied only when `backend` — the
 * backend actually serving this call after `resolveTextBackend` or an explicit
 * request pin — is the pinned one and that pin is still routable. An Auto,
 * unavailable-pin or vision route keeps that backend's own default effort,
 * even when Auto lands on the same backend as a discarded pin.
 */
export function resolveTextBackendEffort(
  db: Database,
  userId: string,
  workload: TextBackendWorkload,
  backend: AiFillBackend,
): TextReasoningEffort | undefined {
  const row = db
    .query<{ backend: string; effort: string | null }, [string, string]>(
      'SELECT backend, effort FROM user_text_backends WHERE user_id = ? AND workload = ?',
    )
    .get(userId, workload);
  if (row?.backend !== backend || isTextBackendUnavailable(backend)) return undefined;
  return storedEffortFor(backend, row.effort) ?? undefined;
}
