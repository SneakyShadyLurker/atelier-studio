import { readBodyBounded, readBytesBounded } from '../_http';
import { abortableDelay, abortReason } from '../../lifecycle/abort';
import { NOOP_PROVIDER_LOGGER, type ProviderLogger } from '../types';

export interface PrivacyConfig {
  token: string | undefined;
  /** PEM trust anchor; TLS verification and hostname checks remain enabled. */
  ca: string | undefined;
}

export type ComfyFetch = (url: string, init?: RequestInit) => Promise<Response>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const oversize = (): never => { throw new PrivacyInvalidResponseError('comfyui privacy response too large'); };

export class PrivacyNotReadyError extends Error {}

export class PrivacyRequestError extends Error {
  constructor(readonly status: number, readonly retryAfterMs = 1_000, readonly workerBusy = false) { super(`comfyui privacy request failed (${status})`); }
}
export class PrivacyInvalidResponseError extends Error {}

// Owned leases, including the interval between terminal delivery and durable
// storage acknowledgment, are drained at shutdown rather than abandoned.
const activeLeases = new Set<() => Promise<void>>();
// Only releases whose bounded delivery cycle exhausted enter this set. Live
// generation and storage owners must never be canceled by admission recovery.
const exhaustedLeases = new Set<() => Promise<void>>();
let cleanupRecovery: Promise<void> | undefined;
let admissionFence = new AbortController();
// Bound unresolved cancellation closures and retry timers even when repeated
// ambiguous creations cannot reach the worker. New creation fails before POST
// until a retained release is delivered; exhausted intents remain drainable.
const MAX_OWNED_LEASES = 64;
export async function drainPrivacyLeases(): Promise<void> {
  const previous = admissionFence;
  admissionFence = new AbortController();
  previous.abort(new DOMException('comfyui admission drained', 'AbortError'));
  await Promise.allSettled([...activeLeases].map((release) => release()));
}

function waitForCleanup(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => { finish(() => { reject(abortReason(signal)); }); };
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(() => { finish(resolve); }, () => { finish(resolve); });
  });
}

async function recoverExhaustedLeases(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!cleanupRecovery && exhaustedLeases.size > 0) {
    cleanupRecovery = Promise.allSettled([...exhaustedLeases].map((release) => release()))
      .then(() => undefined).finally(() => { cleanupRecovery = undefined; });
  }
  if (cleanupRecovery) await waitForCleanup(cleanupRecovery, signal);
}

export interface MemoryOutput {
  id: string;
  bytes: number;
  mediaType: 'image/png' | 'video/mp4';
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function capabilities(status: unknown) {
  const caps = object(status) && object(status.capabilities) ? status.capabilities : {};
  const metadata = object(status) ? status : {};
  if (typeof metadata.worker_build !== 'string'
    || !/^[a-f0-9]{64}$/.test(metadata.worker_build)) throw new PrivacyNotReadyError('comfyui protocol 2 worker metadata required');
  if (!Array.isArray(metadata.allowed_nodes) || metadata.allowed_nodes.length === 0
    || metadata.allowed_nodes.some((node) => typeof node !== 'string' || !node.length)) {
    throw new PrivacyNotReadyError('comfyui invalid worker allowlist');
  }
  const allowedNodes = metadata.allowed_nodes as string[];
  if (allowedNodes.some((node, index) => index > 0 && node <= (allowedNodes[index - 1] ?? ''))) {
    throw new PrivacyNotReadyError('comfyui invalid worker allowlist');
  }
  const rawLimits = metadata.limits;
  if (!object(rawLimits)) throw new PrivacyNotReadyError('comfyui invalid worker limits');
  const positive = (key: string): number => {
    const value = rawLimits[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new PrivacyNotReadyError('comfyui invalid worker limits');
    return value;
  };
  const limits = { max_jobs: positive('max_jobs'), max_payload_bytes: positive('max_payload_bytes'),
    max_image_bytes: positive('max_image_bytes'), max_images: positive('max_images'),
    pre_submit_seconds: positive('pre_submit_seconds'), terminal_idle_seconds: positive('terminal_idle_seconds'),
    terminal_max_seconds: positive('terminal_max_seconds'),
    max_execution_seconds: positive('max_execution_seconds') };
  for (const key of ['job_status', 'image_outputs', 'preview_control', 'lease_renewal', 'job_admission', 'execution_budget', 'residency_tracking']) {
    if (caps[key] !== true) throw new PrivacyNotReadyError('comfyui protocol 2 capabilities required');
  }
  return {
    video: caps.video_outputs === true,
    allowedNodes,
    limits,
  };
}

function retryAfter(value: string | null): number {
  const numeric = value?.trim();
  const seconds = numeric && /^\d+(?:\.\d+)?$/.test(numeric) ? Number(numeric) : NaN;
  const delay = seconds * 1_000;
  return Number.isFinite(delay) ? Math.max(250, Math.min(5_000, delay)) : 1_000;
}

export function submissionNodeClass(classType: string, memoryImages: boolean): string {
  return memoryImages && classType === 'SaveImageWebsocket' ? 'AtelierSaveImages' : privateNodeClass(classType);
}

export function privateNodeClass(classType: string): string {
  switch (classType) {
    case 'LoadImage': return 'AtelierLoadImage';
    case 'LoadVideo': return 'AtelierLoadVideo';
    case 'SaveVideo': return 'AtelierSaveVideo';
    default: return classType;
  }
}

export function createPrivacyTransport(baseUrl: string, config: PrivacyConfig, logger: ProviderLogger = NOOP_PROVIDER_LOGGER) {
  const assertConfigured = () => {
    if (!baseUrl.startsWith('https://') || !config.token || !config.ca) {
      throw new Error('comfyui private TLS transport is not configured');
    }
    return { token: config.token, ca: config.ca };
  };
  const request: ComfyFetch = async (url, init = {}) => {
    const credentials = assertConfigured();
    if (new URL(url).origin !== new URL(baseUrl).origin) throw new Error('comfyui origin mismatch');
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${credentials.token}`);
    return fetch(url, { ...init, headers, redirect: 'error', tls: { ca: credentials.ca } });
  };
  const json = async (path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> => {
    const response = await request(`${baseUrl}/atelier/v1${path}`, { ...init, signal });
    if (!response.ok) {
      let workerBusy = false;
      if (response.status === 429) {
        try {
          const body: unknown = JSON.parse(await readBodyBounded(response, 1_024, { onOversize: oversize, signal }));
          workerBusy = object(body) && Object.keys(body).length === 1 && body.error === 'worker_busy';
        } catch {
          if (signal.aborted) throw abortReason(signal);
          // Proxy, oversized or malformed 429 is ambiguous after POST.
        }
      } else await response.body?.cancel();
      throw new PrivacyRequestError(response.status, retryAfter(response.headers.get('Retry-After')), workerBusy);
    }
    return JSON.parse(await readBodyBounded(response, 16_384, { onOversize: oversize, signal })) as unknown;
  };
  const handshake = async (signal: AbortSignal) => {
    const status = await json('/privacy', {}, signal);
    if (typeof status !== 'object' || status === null || !('protocol' in status)
      || status.protocol !== 2 || !('ready' in status) || status.ready !== true) {
      throw new PrivacyNotReadyError('comfyui protocol 2 privacy controls are not ready');
    }
    return capabilities(status);
  };
  return {
    fetch: request,
    handshake,
    websocket: (url: string): WebSocket => {
      const credentials = assertConfigured();
      return new WebSocket(url, { headers: { Authorization: `Bearer ${credentials.token}` }, tls: { ca: credentials.ca } });
    },
    async createJob(signal: AbortSignal, executionTimeoutMs: number, outputKind: 'image' | 'video' = 'image', onQueued?: () => void) {
      const creationSignal = AbortSignal.any([signal, admissionFence.signal]);
      const caps = await handshake(creationSignal);
      creationSignal.throwIfAborted();
      if (outputKind === 'video' && !caps.video) throw new PrivacyNotReadyError('comfyui protocol 2 video outputs required');
      const executionTimeoutSeconds = Math.ceil(executionTimeoutMs / 1_000);
      if (!Number.isFinite(executionTimeoutMs) || executionTimeoutMs <= 0 || !Number.isSafeInteger(executionTimeoutSeconds)
        || executionTimeoutSeconds > caps.limits.max_execution_seconds) {
        throw new PrivacyNotReadyError('comfyui execution budget exceeds supported limit');
      }
      const id = crypto.randomUUID();
      let releasing: Promise<void> | undefined;
      let released = false;
      let releaseRequested = false;
      let reservation: Promise<void> | undefined;
      const admission = new AbortController();
      const releasedError = new DOMException('comfyui lease released', 'AbortError');
      const assertOwned = () => { if (releaseRequested) throw releasedError; };
      const owner = new AbortController();
      let ownership: Promise<void> | undefined;
      let initialRenewal: Promise<void> | undefined;
      let ownerError: Error | undefined;
      const getOwnerError = () => ownerError;
      let ownershipStarted = false;
      let retrievalDeadline: number | undefined;
      let ownerDeadline: ReturnType<typeof setTimeout> | undefined;
      let detachAbort = () => { /* Ownership has no abort listener yet. */ };
      const stopOwnership = async () => {
        owner.abort();
        clearTimeout(ownerDeadline);
        detachAbort();
        await Promise.allSettled([initialRenewal, ownership]);
      };
      const release = (): Promise<void> => {
        releaseRequested = true;
        admission.abort(releasedError);
        if (released) return Promise.resolve();
        if (releasing) return releasing;
        // Keep failed delivery drainable. Only a confirmed DELETE or 404 ends
        // ownership; caller cancellation cannot cancel cancellation delivery.
        activeLeases.add(release);
        exhaustedLeases.delete(release);
        releasing = (async () => {
          const controller = new AbortController();
          const deadline = setTimeout(() => { controller.abort(); }, 30_000);
          try {
            await stopOwnership();
            // Drain can win while the lease POST is still in flight. Never
            // memoize DELETE success before its reservation outcome is known.
            if (reservation) await waitForCleanup(reservation, controller.signal);
            for (let attempt = 0; !controller.signal.aborted; attempt += 1) {
              try {
                const response = await request(`${baseUrl}/atelier/v1/jobs/${id}`, {
                  method: 'DELETE', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4_000)]),
                });
                await response.body?.cancel().catch(() => undefined);
                if (response.ok || response.status === 404) {
                  released = true;
                  activeLeases.delete(release);
                  exhaustedLeases.delete(release);
                  return;
                }
              } catch { /* Retry idempotent cancellation within this delivery budget. */ }
              await abortableDelay(Math.min(250 * 2 ** Math.min(attempt, 3), 2_000), controller.signal);
            }
          } catch { /* A deadline ends this attempt, not the retained release intent. */ }
          finally {
            clearTimeout(deadline);
            signal.removeEventListener('abort', onLeaseAbort);
            releasing = undefined;
          }
          exhaustedLeases.add(release);
          try { logger.warn({ event: 'comfyui_lease_release', outcome: 'exhausted' }, 'ComfyUI lease release delivery exhausted'); }
          catch { /* Cleanup delivery must never create an unhandled rejection. */ }
        })();
        return releasing;
      };
      const onLeaseAbort = () => { void release(); };
      let leaseAttempted = false;
      let previousPromptId: string | null;
      try {
        const controls = { previews: outputKind === 'image', imageOutputs: outputKind === 'image', executionTimeoutSeconds };
        // Additional admission bound inside the caller's unchanged overall
        // deadline. A lost/ambiguous POST is never replayed.
        const admissionSignal = AbortSignal.any([creationSignal, admission.signal, AbortSignal.timeout(120_000)]);
        await recoverExhaustedLeases(admissionSignal);
        let status: unknown;
        for (;;) {
          admissionSignal.throwIfAborted();
          if (activeLeases.size >= MAX_OWNED_LEASES) await recoverExhaustedLeases(admissionSignal);
          admissionSignal.throwIfAborted();
          if (activeLeases.size >= MAX_OWNED_LEASES) throw new PrivacyNotReadyError('comfyui cleanup capacity exhausted');
          leaseAttempted = true;
          let finishReservation: () => void = () => undefined;
          reservation = new Promise<void>((resolve) => { finishReservation = resolve; });
          activeLeases.add(release);
          try {
            try {
              status = await json(`/jobs/${id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(controls),
              }, admissionSignal);
            } finally {
              finishReservation();
              reservation = undefined;
            }
            assertOwned();
            break;
          } catch (error) {
            assertOwned();
            if (error instanceof PrivacyRequestError && [400, 401, 403, 409].includes(error.status)) {
              leaseAttempted = false;
              activeLeases.delete(release);
            }
            if (!(error instanceof PrivacyRequestError) || error.status !== 429 || !error.workerBusy) throw error;
            // Definite refusal created no lease. In particular, do not retain
            // cancellation intent for a request never accepted by this worker.
            leaseAttempted = false;
            activeLeases.delete(release);
            onQueued?.();
            await recoverExhaustedLeases(admissionSignal);
            await abortableDelay(error.retryAfterMs, admissionSignal);
          }
        }
        if (!object(status) || status.protocol !== 2 || status.ready !== true) {
          throw new PrivacyNotReadyError('comfyui privacy controls are not ready');
        }
        if (status.previous_prompt_id !== null && (typeof status.previous_prompt_id !== 'string' || !UUID.test(status.previous_prompt_id))) {
          throw new PrivacyInvalidResponseError('comfyui invalid previous prompt identity');
        }
        previousPromptId = status.previous_prompt_id;
        signal.throwIfAborted();
        creationSignal.throwIfAborted();
        assertOwned();
      } catch (error) {
        if (leaseAttempted) void release();
        throw error;
      }
      signal.addEventListener('abort', onLeaseAbort, { once: true });
      if (signal.aborted) { void release(); throw abortReason(signal); }
      const renew = async (renewSignal: AbortSignal) => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            const response = await json(`/jobs/${id}/renew`, { method: 'POST' },
              AbortSignal.any([renewSignal, AbortSignal.timeout(4_000)]));
            if (!object(response) || response.ok !== true) throw new PrivacyRequestError(400);
            return;
          } catch (error) {
            if (renewSignal.aborted) throw abortReason(renewSignal);
            if (attempt >= 2 || error instanceof SyntaxError
              || error instanceof PrivacyInvalidResponseError
              || (error instanceof PrivacyRequestError && error.status < 500 && error.status !== 429 && error.status !== 408)) throw error;
            await abortableDelay(250, renewSignal);
          }
        }
      };
      return {
        id,
        previousPromptId,
        signal: owner.signal,
        release,
        stopOwnership,
        outputLimit(limit: number) {
          return Math.min(limit, caps.limits.max_payload_bytes,
            outputKind === 'image' ? caps.limits.max_image_bytes : limit);
        },
        validateRequest(classes: Iterable<string>, count: number, inputs: { bytes: Uint8Array; image: boolean }[]) {
          assertOwned();
          if (!Number.isSafeInteger(count) || count < 1 || count > (outputKind === 'image' ? Math.min(4, caps.limits.max_images) : 1)) {
            throw new PrivacyNotReadyError('comfyui output count exceeds supported limit');
          }
          if ([...classes].some((kind) => !caps.allowedNodes.includes(submissionNodeClass(kind, outputKind === 'image')))) {
            throw new PrivacyNotReadyError('comfyui workflow contains prohibited node classes');
          }
          if (inputs.some((input) => input.image && input.bytes.byteLength > Math.min(50 * 1024 * 1024, caps.limits.max_image_bytes))
            || inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0) > Math.min(512 * 1024 * 1024, caps.limits.max_payload_bytes)) {
            throw new PrivacyNotReadyError('comfyui input exceeds supported byte limit');
          }
        },
        boundRetrieval(lastNonterminal: number) {
          assertOwned();
          // A terminal socket event can precede history insertion. Retention
          // stays bounded from the last confirmed nonterminal observation.
          retrievalDeadline ??= Math.min(performance.now() + 600_000,
            lastNonterminal + Math.min(600, caps.limits.terminal_max_seconds) * 1_000);
          if (performance.now() >= retrievalDeadline) throw new Error('comfyui memory retrieval expired');
        },
        async own(completionSignal: AbortSignal, initialSignal = completionSignal) {
          assertOwned();
          completionSignal.throwIfAborted();
          if (ownershipStarted) { await initialRenewal; if (ownerError) throw ownerError; return; }
          ownershipStarted = true;
          const onAbort = () => { owner.abort(abortReason(completionSignal)); };
          completionSignal.addEventListener('abort', onAbort, { once: true });
          detachAbort = () => { completionSignal.removeEventListener('abort', onAbort); };
          ownerDeadline = setTimeout(() => { void release(); }, Math.max(0,
            (retrievalDeadline ?? performance.now() + Math.min(600, caps.limits.terminal_max_seconds) * 1_000) - performance.now()));
          initialRenewal = renew(AbortSignal.any([completionSignal, initialSignal, owner.signal]));
          try { await initialRenewal; }
          catch (error) { await stopOwnership(); throw error; }
          ownership = (async () => {
            try {
              for (;;) {
                await abortableDelay(Math.min(30_000, caps.limits.terminal_idle_seconds * 500), owner.signal);
                await renew(owner.signal);
              }
            } catch (error) {
              if (!owner.signal.aborted) {
                ownerError = error instanceof Error ? error : new Error('comfyui lease renewal failed');
                owner.abort(ownerError);
              }
            } finally {
              detachAbort();
            }
          })();
        },
        async status(statusSignal: AbortSignal) {
          assertOwned();
          const status = await json(`/jobs/${id}`, {}, AbortSignal.any([statusSignal, owner.signal]));
          assertOwned();
          if (!object(status) || typeof status.state !== 'string'
            || !['leased', 'queued', 'running', 'completed', 'failed', 'released'].includes(status.state)
            || !Array.isArray(status.outputs) || status.outputs.length > 4) throw new PrivacyInvalidResponseError('comfyui invalid job status');
          const outputs: MemoryOutput[] = [];
          for (const item of status.outputs) {
            if (!object(item) || typeof item.id !== 'string' || !UUID.test(item.id)
              || typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes <= 0
              || (item.mediaType !== 'image/png' && item.mediaType !== 'video/mp4')
              || outputs.some((output) => output.id === item.id)) throw new PrivacyInvalidResponseError('comfyui invalid memory output');
            if (item.bytes > caps.limits.max_payload_bytes
              || (item.mediaType === 'image/png' && item.bytes > caps.limits.max_image_bytes)) throw new PrivacyInvalidResponseError('comfyui memory output exceeds worker limits');
            outputs.push({ id: item.id, bytes: item.bytes, mediaType: item.mediaType });
          }
          if (outputs.reduce((sum, output) => sum + output.bytes, 0) > caps.limits.max_payload_bytes) throw new PrivacyInvalidResponseError('comfyui memory output exceeds worker limits');
          return { state: status.state, outputs };
        },
        async upload(bytes: Uint8Array, uploadSignal: AbortSignal): Promise<string> {
          assertOwned();
          const asset = crypto.randomUUID();
          await json(`/jobs/${id}/inputs/${asset}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
          }, AbortSignal.any([uploadSignal, owner.signal]));
          assertOwned();
          return `${id}:${asset}`;
        },
        transform(workflow: Record<string, unknown>): void {
          assertOwned();
          for (const value of Object.values(workflow)) {
            const node = value as { class_type: string; inputs: Record<string, unknown> };
            if (node.class_type === 'SaveVideo') {
              delete node.inputs.filename_prefix;
              node.inputs.job_id = id;
            }
            if (outputKind === 'image' && node.class_type === 'SaveImageWebsocket') {
              node.inputs = { images: node.inputs.images, job_id: id };
              node.class_type = 'AtelierSaveImages';
            }
            node.class_type = privateNodeClass(node.class_type);
          }
        },
        async download(ref: { filename: string; subfolder: string; type: string; bytes?: number; mediaType?: string }, limit: number, downloadSignal: AbortSignal) {
          assertOwned();
          if (ownerError) throw ownerError;
          if (ownershipStarted && owner.signal.aborted) throw abortReason(owner.signal);
          if (ref.type !== 'atelier-memory' || ref.subfolder !== id || !UUID.test(ref.filename)) {
            throw new Error('comfyui rejected persistent output reference');
          }
          retrievalDeadline ??= performance.now() + Math.min(600, caps.limits.terminal_max_seconds) * 1_000;
          const remaining = retrievalDeadline - performance.now();
          if (remaining <= 0) throw new Error('comfyui memory retrieval expired');
          const retrievalSignal = AbortSignal.any([downloadSignal, owner.signal, AbortSignal.timeout(Math.ceil(remaining))]);
          for (let attempt = 0; ; attempt += 1) {
            const readSignal = AbortSignal.any([retrievalSignal, AbortSignal.timeout(60_000)]);
            try {
              const response = await request(`${baseUrl}/atelier/v1/jobs/${id}/outputs/${ref.filename}`, { signal: readSignal });
              if (!response.ok) {
                await response.body?.cancel();
                throw new PrivacyRequestError(response.status);
              }
              if (!response.body) throw new PrivacyInvalidResponseError('comfyui memory output missing body');
              if (ref.mediaType && response.headers.get('Content-Type')?.split(';')[0] !== ref.mediaType) {
                await response.body.cancel();
                throw new PrivacyInvalidResponseError('comfyui output media type mismatch');
              }
              const bytes = await readBytesBounded(response.body, limit, { onOversize: oversize, signal: readSignal });
              if (ref.bytes !== undefined && bytes.byteLength !== ref.bytes) throw new PrivacyInvalidResponseError('comfyui output byte count mismatch');
              const renewalError = getOwnerError();
              if (renewalError) throw renewalError;
              return bytes;
            } catch (error) {
              if (retrievalSignal.aborted) throw abortReason(retrievalSignal);
              if (attempt >= 2 || error instanceof PrivacyInvalidResponseError
                || (error instanceof PrivacyRequestError && error.status < 500 && error.status !== 408 && error.status !== 429)) throw error;
              await abortableDelay(250, retrievalSignal);
            }
          }
        },
      };
    },
  };
}

export type PrivacyJob = Awaited<ReturnType<ReturnType<typeof createPrivacyTransport>['createJob']>>;
