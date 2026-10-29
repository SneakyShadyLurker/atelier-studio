import type { ModelAvailability, ModelAvailabilityReason } from '@atelier/shared';
import type { AppLogger } from '../observability/logger';
import type { RegistryEntry } from '../providers/registry';
import type { HealthProbeCode } from '../providers/types';

const PROBE_CODES = new Set<HealthProbeCode>([
  'privacy_transport', 'privacy_not_ready', 'host_transport',
  'inventory_transport', 'inventory_invalid', 'missing_file',
  'missing_clip_type', 'missing_node_class',
]);

function safeProbeCode(code: unknown): HealthProbeCode | 'unknown' {
  return typeof code === 'string' && PROBE_CODES.has(code as HealthProbeCode)
    ? code as HealthProbeCode : 'unknown';
}

export interface HealthProbeDeps {
  registry: readonly RegistryEntry[];
  logger: AppLogger;
  intervalMs: number;
  probeTimeoutMs: number;
}

/**
 * Map a raw probe failure into the closed `ModelAvailabilityReason` vocabulary
 * defined in `@atelier/shared`. Raw `err.message` strings from `fetch()` (e.g.
 * `connect ECONNREFUSED 10.0.0.5:8189`) MUST NEVER reach the wire — the
 * `/api/models` response is read by every authenticated user. Returns
 * `undefined` only for the pre-first-probe seed state.
 *
 * `timed out` is reserved for our own probe budget. Shutdown aborts and
 * upstream failures collapse to `unavailable`.
 */
export function sanitizeProbeReason(
  _raw: unknown,
  opts: { timedOut: boolean } = { timedOut: false },
): ModelAvailabilityReason {
  if (opts.timedOut) return 'timed out';
  return 'unavailable';
}

export interface HealthProbeHandle {
  snapshot(): ReadonlyMap<string, ModelAvailability>;
  probeNow(modelId: string): Promise<ModelAvailability | undefined>;
  stop(): void;
  // Resolves when the in-flight probe round (if any) has settled. Call after
  // stop() during shutdown so a probe caught mid-fetch can't outlive
  // process.exit with an open socket — the explicitly-awaited counterpart of
  // the orchestrator drain. probeOne swallows abort into a result, so the
  // round always resolves (never rejects) and drain() settles promptly once
  // stop() has aborted the in-flight controllers.
  drain(): Promise<void>;
}

// Only entries the server actually probes show up in the snapshot. Cloud and
// mock providers are treated as always-available (their `healthCheck` is
// undefined); the wire shape omits `availability` for those, so the Composer
// treats them as enabled by default. This keeps the snapshot small (typically
// 1 entry = ComfyUI) and avoids hammering paid cloud APIs with no-op probes.
function probableEntries(registry: readonly RegistryEntry[]): readonly RegistryEntry[] {
  return registry.filter((entry) => {
    if (entry.model.pool !== 'local') return false;
    // bind({}) on non-BYOK entries returns the singleton provider — local pool
    // entries are never BYOK, so the empty deps payload is safe here. If a
    // future local-pool BYOK entry appears this skips it (no healthCheck
    // contract), and the operator will see it never shows availability data.
    const provider = entry.bind({});
    return typeof provider.healthCheck === 'function';
  });
}

export function startHealthProbe(deps: HealthProbeDeps): HealthProbeHandle {
  const { registry, logger, intervalMs, probeTimeoutMs } = deps;
  const targets = probableEntries(registry);
  const targetsById = new Map(targets.map((entry) => [entry.model.id, entry]));
  const snapshot = new Map<string, ModelAvailability>();
  // Fail-closed seeding: between Bun.serve accepting requests and the first
  // probe round completing (~2s), we'd otherwise treat probed entries as
  // available — which lets a generate request through to the local GPU
  // semaphore against a host we have no evidence is up. Seed every target
  // as offline+pending instead; the first probe overwrites within ~2s.
  const bootedAt = Date.now();
  // Pre-first-probe state: `reason` is undefined (not "pending first probe" —
  // that string used to ship on the wire which leaked process restart timing
  // to authenticated users). `pendingFirstProbe` is the internal flag used by
  // probeRound to suppress the `ok ↔ offline` log transition on the very
  // first round.
  const pendingFirstProbe = new Set<string>();
  for (const entry of targets) {
    snapshot.set(entry.model.id, { ok: false, checkedAt: bootedAt });
    pendingFirstProbe.add(entry.model.id);
  }
  // Tracks every probe's AbortController so `stop()` can abort in-flight
  // fetches deterministically — without this, a probe in its 2s timeout
  // window keeps holding a socket open past the SIGTERM drain budget
  // configured in server.ts. Cleared inside `probeOne` finally.
  const inFlight = new Set<AbortController>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Every background round and user-forced probe that hasn't settled yet.
  // `drain()` awaits all of them so shutdown cannot abandon an active probe.
  // Each operation removes itself in its own `.finally`.
  const inFlightRounds = new Set<Promise<unknown>>();
  const inFlightForced = new Map<string, Promise<ModelAvailability | undefined>>();
  const probeGenerationById = new Map<string, number>();
  const committedGenerationById = new Map<string, number>();
  const isStopped = (): boolean => stopped;

  function beginProbe(id: string): number {
    const generation = (probeGenerationById.get(id) ?? 0) + 1;
    probeGenerationById.set(id, generation);
    return generation;
  }

  async function probeOne(entry: RegistryEntry): Promise<ModelAvailability> {
    const controller = new AbortController();
    const startedAt = performance.now();
    inFlight.add(controller);
    // Distinguishes a probe-budget timeout (we own this AbortController and
    // fire it from this setTimeout) from a `stop()`-initiated abort during
    // shutdown. Only the former should report `timed out` on the wire —
    // shutdown aborts collapse to `unavailable` like any other failure.
    let timedOutByBudget = false;
    const isBudgetTimedOut = (): boolean => timedOutByBudget;
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOutByBudget = true;
      controller.abort(new Error('probe timeout'));
    }, probeTimeoutMs);
    try {
      const provider = entry.bind({});
      if (typeof provider.healthCheck !== 'function') {
        // Defensive: targets list is filtered to entries that have a probe,
        // but this guards against a future regression where the filter drifts.
        return { ok: true, checkedAt: Date.now() };
      }
      // Keep tracking the actual adapter work through shutdown drain. Some
      // adapters catch fetch aborts and return ok:false or even resolve late;
      // the owned deadline still wins when they settle.
      const result = await provider.healthCheck(controller.signal);
      const now = Date.now();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (result.ok) return { ok: true, checkedAt: now };
      logger.warn(
        { modelId: entry.model.id, probeCode: safeProbeCode(result.probeCode),
          durationMs: Math.round(performance.now() - startedAt), timedOut: false },
        'model probe reported offline',
      );
      return {
        ok: false,
        checkedAt: now,
        reason: sanitizeProbeReason(undefined),
      };
    } catch (err) {
      logger.warn(
        { modelId: entry.model.id, probeCode: isBudgetTimedOut() ? 'timeout' : isStopped() ? 'stopped' : 'unknown',
          durationMs: Math.round(performance.now() - startedAt), timedOut: timedOutByBudget },
        'model probe failed',
      );
      return {
        ok: false,
        checkedAt: Date.now(),
        reason: sanitizeProbeReason(err, { timedOut: timedOutByBudget }),
      };
    } finally {
      clearTimeout(timeout);
      inFlight.delete(controller);
    }
  }

  function storeAvailability(
    id: string,
    availability: ModelAvailability,
    generation: number,
  ): ModelAvailability {
    const committedGeneration = committedGenerationById.get(id);
    if (committedGeneration !== undefined && committedGeneration > generation) {
      return snapshot.get(id) ?? availability;
    }
    committedGenerationById.set(id, generation);
    const previous = snapshot.get(id);
    snapshot.set(id, availability);
    // Only log on an actual ok ↔ offline transition. The seed (pre-first-
    // probe) state would otherwise spam a "changed" log line for every
    // probe target on every boot when the first probe lands ok. The seed
    // is tracked via `pendingFirstProbe` (an internal Set) rather than a
    // sentinel reason string, since the wire vocabulary is now a closed
    // union and can't carry a "pending" marker.
    const wasOk = previous?.ok === true;
    const wasReal = !pendingFirstProbe.has(id);
    pendingFirstProbe.delete(id);
    if (wasReal && wasOk !== availability.ok) {
      logger.info(
        { modelId: id, ok: availability.ok, reason: availability.reason },
        'model availability changed',
      );
    }
    return availability;
  }

  async function probeRound(): Promise<void> {
    // Per-model validation stays parallel. Registry-owned ComfyUI transports
    // coalesce concurrent host reads without retaining readiness between rounds.
    const results = await Promise.all(
      targets.map(async (entry) => {
        const id = entry.model.id;
        const generation = beginProbe(id);
        return [id, generation, await probeOne(entry)] as const;
      }),
    );
    if (stopped) return;
    for (const [id, generation, availability] of results) {
      storeAvailability(id, availability, generation);
    }
  }

  function probeNow(modelId: string): Promise<ModelAvailability | undefined> {
    if (stopped) return Promise.resolve(snapshot.get(modelId));
    const existing = inFlightForced.get(modelId);
    if (existing) return existing;
    const entry = targetsById.get(modelId);
    if (!entry) return Promise.resolve(undefined);
    const generation = beginProbe(modelId);

    const forced = (async (): Promise<ModelAvailability | undefined> => {
      const availability = await probeOne(entry);
      if (isStopped()) return snapshot.get(modelId);
      return storeAvailability(modelId, availability, generation);
    })();
    inFlightForced.set(modelId, forced);
    inFlightRounds.add(forced);
    void forced.finally(() => {
      inFlightForced.delete(modelId);
      inFlightRounds.delete(forced);
    });
    return forced;
  }

  function runRound(): void {
    const round = probeRound();
    inFlightRounds.add(round);
    void round.finally(() => {
      inFlightRounds.delete(round);
      schedule();
    });
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(runRound, intervalMs);
  }

  // Kick off the first round immediately so /api/models has data within one
  // probe window of boot. Don't await — boot must complete fast.
  if (targets.length > 0) {
    runRound();
  }

  return {
    snapshot: () => snapshot,
    probeNow,
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const controller of inFlight) {
        controller.abort(new Error('health-probe stopped'));
      }
    },
    drain: async () => {
      // Snapshot to a typed array. Each operation's `.finally` removes it from
      // the set, but we don't depend on that — `allSettled` is happy to
      // re-await an already-settled promise.
      while (inFlightRounds.size > 0) {
        const pending: Promise<unknown>[] = Array.from(inFlightRounds);
        await Promise.allSettled(pending);
      }
    },
  };
}
