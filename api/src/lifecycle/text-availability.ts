import type { TextModelStatus } from '@atelier/shared';
import {
  currentTextConfigRevision,
  type TextModelRecord,
  type TextProviderRecord,
  type TextProviderStore,
} from '../db/textProviders';
import { TextListError } from '../providers/text/listModels';
import type { ResolvedProvider } from '../providers/text/protocol';
import { textAdapterFor } from '../providers/text/registry';
import type { ProviderLogger } from '../providers/types';

// Which configured text models their providers currently list (spec § 9.1).
// One availability poller per enabled provider with listing on: the adapter's bounded list call (1 MiB,
// redirects refused), its own shorter timeout, the last good snapshot kept on
// any failure, an empty list treated as "unknown". Unknown fails open.
//
// The service owns reconciliation: on a text config revision change it starts
// pollers for new or newly enabled providers, stops those of disabled or
// deleted ones (or with listing turned off) and restarts a poller whose base
// URL, protocol or credential changed, aborting its poll in flight.

export interface TextAvailabilityDeps {
  readonly store: TextProviderStore;
  readonly logger: ProviderLogger;
  /** 60 s in production. */
  readonly intervalMs: number;
  /** 5 s in production. */
  readonly timeoutMs: number;
}

export interface TextAvailabilityHandle {
  /** 'available' when listed, 'offline' when the provider's list lacks it, else 'unknown'. */
  statusOf(model: Pick<TextModelRecord, 'providerId' | 'modelId'>): TextModelStatus;
  /** Models the last good list returned; null = unknown (no poller, no good list yet). */
  snapshot(providerId: string): ReadonlySet<string> | null;
  /** Polls one provider now (after reconciling); resolves when that poll settles. */
  refresh(providerId: string): Promise<void>;
  /** Applies the current provider rows to the poller set; runs on its own when the revision changed. */
  reconcile(): void;
  stop(): void;
  /** Resolves once every in-flight poll has settled; call after stop(). */
  drain(): Promise<void>;
}

type RefreshFailure =
  | 'timeout'
  | 'stopped'
  | 'transport'
  | 'http_status'
  | 'invalid_body'
  | 'empty_inventory'
  | 'list_unsupported'
  | 'credential';

interface Poller {
  /** What a restart keys on: the provider's wire identity and credential. */
  readonly signature: string;
  snapshot: ReadonlySet<string> | null;
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController | null;
  inFlight: Promise<void> | null;
}

function signatureOf(provider: TextProviderRecord): string {
  return JSON.stringify([provider.protocol, provider.baseUrl, provider.auth, provider.fingerprint ?? null, provider.envVar ?? null]);
}

function polled(provider: TextProviderRecord): boolean {
  return provider.enabled && provider.listModels;
}

export function startTextAvailability(deps: TextAvailabilityDeps): TextAvailabilityHandle {
  const { store, logger, intervalMs, timeoutMs } = deps;
  const pollers = new Map<string, Poller>();
  let revision = -1;
  let stopped = false;

  // Logs carry a closed code and the HTTP status only: never the key, URL
  // credentials or the raw body.
  function warn(providerId: string, code: RefreshFailure, status?: number | null): void {
    logger.warn(
      { providerId, inventoryCode: code, ...(status === undefined || status === null ? {} : { status }) },
      'text model list refresh failed',
    );
  }

  async function poll(provider: TextProviderRecord, poller: Poller): Promise<void> {
    const ac = new AbortController();
    poller.controller = ac;
    let timedOut = false;
    const failureCode = (fallback: RefreshFailure): RefreshFailure => (
      timedOut ? 'timeout' : poller.stopped ? 'stopped' : fallback
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error('text model list timeout'));
    }, timeoutMs);
    try {
      let resolved: ResolvedProvider;
      try {
        resolved = { ...provider, credential: (await store.resolveCredential(provider)) ?? null };
      } catch {
        warn(provider.id, failureCode('credential'));
        return;
      }
      if (ac.signal.aborted) {
        warn(provider.id, failureCode('transport'));
        return;
      }
      let result;
      try {
        result = await textAdapterFor(provider.protocol).listModels(resolved, ac.signal);
      } catch (err) {
        if (err instanceof TextListError) {
          const code = err.reason === 'too_large' || err.reason === 'invalid_body'
            ? 'invalid_body'
            : err.reason === 'http_status' ? 'http_status' : err.reason === 'timeout' ? 'timeout' : 'transport';
          warn(provider.id, failureCode(code), err.status);
        } else {
          warn(provider.id, failureCode('transport'));
        }
        return;
      }
      if (poller.stopped) return;
      if (result.listUnsupported) {
        warn(provider.id, 'list_unsupported');
        return;
      }
      // An empty list is a provider mid-reload or misconfigured, not a verdict
      // that every model is gone; trusting it would drop every saved pick.
      if (result.models.length === 0) {
        warn(provider.id, 'empty_inventory');
        return;
      }
      poller.snapshot = new Set(result.models.map((model) => model.id));
    } finally {
      clearTimeout(timeout);
      if (poller.controller === ac) poller.controller = null;
    }
  }

  function runPoll(providerId: string, poller: Poller): Promise<void> {
    if (poller.timer) {
      clearTimeout(poller.timer);
      poller.timer = null;
    }
    // Read the row at poll time so a rename or toggle without a restart is seen.
    const provider = store.getProvider(providerId);
    const round = provider === null ? Promise.resolve() : poll(provider, poller);
    poller.inFlight = round;
    return round.finally(() => {
      if (poller.inFlight === round) poller.inFlight = null;
      if (!poller.stopped && poller.inFlight === null) {
        poller.timer = setTimeout(() => { void runPoll(providerId, poller); }, intervalMs);
      }
    });
  }

  function stopPoller(poller: Poller): void {
    poller.stopped = true;
    if (poller.timer) {
      clearTimeout(poller.timer);
      poller.timer = null;
    }
    poller.controller?.abort(new Error('text model list stopped'));
  }

  // Stopped pollers whose poll may still be settling; drain() waits for them.
  const retired = new Set<Poller>();

  function retire(providerId: string, poller: Poller): void {
    stopPoller(poller);
    pollers.delete(providerId);
    if (poller.inFlight) {
      retired.add(poller);
      void poller.inFlight.finally(() => retired.delete(poller));
    }
  }

  function reconcile(): void {
    if (stopped) return;
    revision = currentTextConfigRevision();
    const wanted = new Map(store.listProviders().filter(polled).map((p) => [p.id, p]));
    for (const [id, poller] of pollers) {
      const provider = wanted.get(id);
      if (provider === undefined || signatureOf(provider) !== poller.signature) retire(id, poller);
    }
    for (const [id, provider] of wanted) {
      if (pollers.has(id)) continue;
      const poller: Poller = {
        signature: signatureOf(provider),
        snapshot: null,
        stopped: false,
        timer: null,
        controller: null,
        inFlight: null,
      };
      pollers.set(id, poller);
      // First poll immediately; nobody waits for it (null = unknown).
      void runPoll(id, poller);
    }
  }

  function current(): void {
    if (!stopped && currentTextConfigRevision() !== revision) reconcile();
  }

  function snapshot(providerId: string): ReadonlySet<string> | null {
    current();
    return pollers.get(providerId)?.snapshot ?? null;
  }

  reconcile();

  return {
    statusOf(model) {
      const listed = snapshot(model.providerId);
      if (listed === null) return 'unknown';
      return listed.has(model.modelId) ? 'available' : 'offline';
    },
    snapshot,
    refresh(providerId) {
      current();
      const poller = pollers.get(providerId);
      if (poller === undefined) return Promise.resolve();
      return poller.inFlight ?? runPoll(providerId, poller);
    },
    reconcile,
    stop() {
      stopped = true;
      for (const [id, poller] of pollers) retire(id, poller);
    },
    async drain() {
      for (;;) {
        const pending = [...pollers.values(), ...retired].flatMap((p) => (p.inFlight ? [p.inFlight] : []));
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
      }
    },
  };
}
