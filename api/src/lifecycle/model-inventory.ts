import { z } from 'zod';
import type { AppLogger } from '../observability/logger';

// CLIProxyAPI's OpenAI-compatible inventory. Only `data[].id` is load-bearing;
// zod objects strip unknown keys, so `object`, `created`, `owned_by` and any
// future field are tolerated.
const ModelsResponse = z.object({
  data: z.array(z.object({ id: z.string() })),
});

const MODELS_PATH = '/v1/models';

export interface ModelInventoryDeps {
  baseUrl: string;
  token: string;
  logger: AppLogger;
  intervalMs: number;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface ModelInventoryHandle {
  /** Model ids from the last successful fetch; `null` until the first one lands. */
  snapshot(): ReadonlySet<string> | null;
  stop(): void;
  // Resolves once the in-flight refresh (if any) has settled; call after stop().
  drain(): Promise<void>;
}

type RefreshFailure = 'timeout' | 'stopped' | 'transport' | 'http_status' | 'invalid_body' | 'empty_inventory';

export function startModelInventory(deps: ModelInventoryDeps): ModelInventoryHandle {
  const { logger, intervalMs, timeoutMs } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const url = `${deps.baseUrl.replace(/\/+$/, '')}${MODELS_PATH}`;
  let snapshot: ReadonlySet<string> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let controller: AbortController | null = null;

  // A failed refresh keeps the last good snapshot. Logs carry a closed code and
  // the HTTP status only: never the token, URL credentials or the raw body.
  function warn(code: RefreshFailure, status?: number): void {
    logger.warn(
      { inventoryCode: code, ...(status !== undefined ? { status } : {}) },
      'cliproxy model inventory refresh failed',
    );
  }

  async function refresh(): Promise<void> {
    const ac = new AbortController();
    controller = ac;
    let timedOut = false;
    // Read through a function: the flags flip in callbacks, which control-flow
    // narrowing cannot see.
    const failureCode = (fallback: RefreshFailure): RefreshFailure => (
      timedOut ? 'timeout' : stopped ? 'stopped' : fallback
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error('model inventory timeout'));
    }, timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${deps.token}`, Accept: 'application/json' },
          signal: ac.signal,
        });
      } catch {
        warn(failureCode('transport'));
        return;
      }
      if (!response.ok) {
        // Release the socket without reading the (possibly echoing) body.
        void response.body?.cancel().catch(() => undefined);
        warn('http_status', response.status);
        return;
      }
      let parsed: z.infer<typeof ModelsResponse>;
      try {
        const result = ModelsResponse.safeParse(await response.json());
        if (!result.success) {
          warn('invalid_body', response.status);
          return;
        }
        parsed = result.data;
      } catch {
        warn(failureCode('invalid_body'), response.status);
        return;
      }
      if (stopped) return;
      // An empty list is a proxy mid-reload or misconfigured, not a verdict
      // that every model is gone; trusting it would drop every saved pin.
      if (parsed.data.length === 0) {
        warn('empty_inventory', response.status);
        return;
      }
      snapshot = new Set(parsed.data.map((model) => model.id));
    } finally {
      clearTimeout(timeout);
      if (controller === ac) controller = null;
    }
  }

  function runRefresh(): void {
    const round = refresh();
    inFlight = round;
    void round.finally(() => {
      if (inFlight === round) inFlight = null;
      schedule();
    });
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(runRefresh, intervalMs);
  }

  // First refresh immediately; boot does not wait for it (null = unknown).
  runRefresh();

  return {
    snapshot: () => snapshot,
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      controller?.abort(new Error('model inventory stopped'));
    },
    drain: async () => {
      while (inFlight) await inFlight;
    },
  };
}
