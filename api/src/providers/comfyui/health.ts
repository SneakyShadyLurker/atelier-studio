import { abortReason } from '../../lifecycle/abort';
import { readBodyBounded } from '../_http';
import { createPrivacyTransport, type PrivacyConfig } from './privacy';

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
  return {
    handshake: coalesce((signal) => privacy.handshake(signal)),
    inventory: coalesce(async (signal) => {
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
    }),
  };
}

export type ComfyuiHealthTransport = ReturnType<typeof createComfyuiHealthTransport>;
