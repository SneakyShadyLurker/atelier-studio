import { abortReason } from '../../lifecycle/abort';
import { readBodyBounded } from '../_http';
import { createPrivacyTransport, type PrivacyConfig } from './privacy';

/**
 * How long one `/object_info` read may serve later probe rounds of the same
 * worker boot. Building that document stalls the host's event loop, yet weight
 * files can appear or disappear without a worker restart, so reuse stays short.
 */
export const INVENTORY_REUSE_MS = 5 * 60_000;

export interface InventoryOptions {
  /** `boot_id` from this round's handshake; undefined means the worker sent none. */
  bootId?: string | undefined;
  /** Ignore any reusable read, as a user-forced probe does. */
  fresh?: boolean | undefined;
}

/** One registry host and credential owner. Only concurrent reads are shared. */
export function createComfyuiHealthTransport(baseUrl: string, config: PrivacyConfig, limit: number) {
  const privacy = createPrivacyTransport(baseUrl, config);
  function coalesce<T>(read: (signal: AbortSignal) => Promise<T>) {
    let flight: { controller: AbortController; promise: Promise<T>; subscribers: number } | undefined;
    return (signal: AbortSignal): Promise<T> => {
      if (signal.aborted) return Promise.reject(abortReason(signal));
      if (!flight) {
        const controller = new AbortController();
        const current = { controller, subscribers: 0,
          promise: read(AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)])) };
        current.promise = current.promise.finally(() => { if (flight === current) flight = undefined; });
        flight = current;
      }
      const current = flight;
      current.subscribers += 1;
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          current.subscribers -= 1;
          if (current.subscribers === 0 && flight === current) {
            flight = undefined;
            current.controller.abort();
          }
          callback();
        };
        const onAbort = () => { finish(() => { reject(abortReason(signal)); }); };
        signal.addEventListener('abort', onAbort, { once: true });
        current.promise.then((value) => { finish(() => { resolve(value); }); },
          (error: unknown) => { finish(() => { reject(error instanceof Error ? error : new Error('comfyui health read failed')); }); });
      });
    };
  }
  // The last good inventory, keyed by the worker boot it was read under. Only
  // the inventory is reused; the privacy handshake still runs every round.
  let reusable: { bootId: string; readAt: number; value: object } | undefined;
  const handshake = coalesce(async (signal) => {
    try { return await privacy.handshake(signal); }
    catch (error) {
      // A worker that failed its handshake may have restarted or changed
      // underneath us, so the next good round reads the inventory again.
      reusable = undefined;
      throw error;
    }
  });
  const readInventory = coalesce(async (signal) => {
    const response = await privacy.fetch(`${baseUrl.replace(/\/+$/, '')}/object_info`, { signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`comfyui /object_info returned ${response.status}`);
    }
    const body = await readBodyBounded(response, limit, {
      signal, onOversize: () => { throw new Error('comfyui inventory too large'); },
    });
    try { return JSON.parse(body) as unknown; }
    catch { return null; }
  });
  return {
    handshake,
    async inventory(signal: AbortSignal, options: InventoryOptions = {}): Promise<unknown> {
      const { bootId, fresh = false } = options;
      signal.throwIfAborted();
      const cached = reusable;
      if (!fresh && bootId !== undefined && cached?.bootId === bootId && Date.now() - cached.readAt < INVENTORY_REUSE_MS) {
        return cached.value;
      }
      // A read that fails, or yields no usable document, must not leave an
      // older entry to be served by a later round.
      reusable = undefined;
      const readAt = Date.now();
      const value = await readInventory(signal);
      if (bootId !== undefined && typeof value === 'object' && value !== null) reusable = { bootId, readAt, value };
      return value;
    },
  };
}

export type ComfyuiHealthTransport = ReturnType<typeof createComfyuiHealthTransport>;
