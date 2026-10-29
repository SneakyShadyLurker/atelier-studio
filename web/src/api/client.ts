import { BACKEND_VALUES, LATENCY_VALUES, MODEL_AVAILABILITY_REASONS, POOL_VALUES, RATIO_VALUES, REQUEST_ID_HEADER, SESSION_SCOPE_HEADER, VIDEO_DURATION_FRAMES } from '@atelier/shared';
import type {
  ApiErrorCode,
  ArchivePage,
  ArchivedTile,
  Batch,
  Collection,
  CollectionsResponse,
  DimensionTag,
  HistoryPage,
  Model,
  PromptLibraryResponse,
  PromptTemplate,
  TagDimension,
  Tile,
  VariableList,
  VariableOption,
} from '@atelier/shared';

import { removePersistedQueryClient } from '../lib/persister';
import { isMediaPair, isNumber, isRecord, isStringArray, isTileErrorCategory } from '../lib/guards';
import { GptModerationNoticeSchema } from '@atelier/shared';
import { invalidateSessionScope, isSessionLocked, sessionBinding } from '../lib/sessionScope';
import { mediaUrl } from './mediaUrl';

export class ApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly body: unknown;
  readonly requestId?: string;

  constructor(status: number, message: string, body?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = status >= 500;
    this.body = body;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

// Same-origin API prefix; the dev proxy and the edge both route `/api`.
export const API_BASE = '/api';
const AUTH_RELOAD_STORAGE_KEY = 'atelier.authReloadAt';
const AUTH_RELOAD_DEBOUNCE_MS = 10_000;
let fallbackAuthReloadAt = 0;
let sessionReloadScheduled = false;

export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${normalized}`;
}

// Build API paths from named route params so dynamic segments are encoded at
// the call site instead of relying on every caller to remember it.
export function apiPath(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (token, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`apiPath: missing param ${token}`);
    return encodeURIComponent(value);
  });
}

export function apiImageUrl(url: string): string {
  if (url.startsWith('/api/')) return mediaUrl(`${API_BASE}${url.slice('/api'.length)}`);
  if (url.startsWith('/')) return mediaUrl(`${API_BASE}${url}`);
  // Self-contained schemes are legitimate provider responses (e.g.
  // `partial_images` data: frames, blob: URLs created via URL.createObjectURL
  // for in-flight previews). Pass through unchanged — they carry no origin
  // we need to rewrite.
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  throw new Error('apiImageUrl: non-relative URL rejected');
}

export async function extractApiError(
  response: Response,
  fallback = 'request failed',
): Promise<{ message: string; body?: unknown }> {
  const text = await response.text();
  if (!text) return { message: response.statusText || fallback };
  try {
    const value = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof value.error === 'string') return { message: value.error, body: value };
    if (typeof value.message === 'string') return { message: value.message, body: value };
    return { message: text, body: value };
  } catch {
    return { message: text };
  }
}

export function responseRequestId(response: Response): string | undefined {
  return nonEmptyHeader(response.headers.get(REQUEST_ID_HEADER));
}

function nonEmptyHeader(value: string | null): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  return trimmed;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (isSessionLocked()) throw sessionChangedError();
  const binding = sessionBinding();
  const headers = new Headers(init.headers);
  let requestId = nonEmptyHeader(headers.get(REQUEST_ID_HEADER));
  if (requestId === undefined) {
    requestId = crypto.randomUUID();
    headers.set(REQUEST_ID_HEADER, requestId);
  }

  if (binding.cacheScope !== undefined) headers.set(SESSION_SCOPE_HEADER, binding.cacheScope);
  const signal = binding.cacheScope === undefined
    ? init.signal
    : (init.signal ? AbortSignal.any([init.signal, binding.signal]) : binding.signal);
  const response = await fetch(apiUrl(path), {
    ...init, credentials: init.credentials ?? 'same-origin', headers,
    ...(signal ? { signal } : {}),
  });
  // A fetch implementation or an already-buffered response may settle after
  // cancellation. Never pass that response back into the retired runtime.
  if (isSessionLocked()) {
    void response.body?.cancel().catch(() => undefined);
    throw sessionChangedError(responseRequestId(response));
  }
  const actualScope = response.headers.get(SESSION_SCOPE_HEADER);
  const changed = binding.cacheScope !== undefined && (
    (actualScope !== null && actualScope !== binding.cacheScope)
    || (response.status === 409 && await response.clone().json().then(
      (body: unknown) => isRecord(body) && body.code === ('SESSION_CHANGED' satisfies ApiErrorCode),
      () => false,
    ))
  );
  if (changed) {
    try {
      invalidateSessionScope();
    } finally {
      scheduleSessionReload();
    }
    void response.body?.cancel().catch(() => undefined);
    throw sessionChangedError(responseRequestId(response));
  }
  if (isSessionLocked()) throw sessionChangedError(responseRequestId(response));
  scheduleAuthReloadForResponse(response);
  return binding.cacheScope !== undefined && signal ? guardResponseBody(response, signal) : response;
}

function sessionChangedError(requestId?: string): ApiError {
  return new ApiError(409, 'session changed', { code: 'SESSION_CHANGED' satisfies ApiErrorCode }, requestId);
}

// Subscribe only while the BODY is consumed, including SSE. Unread responses
// must not be retained by the page-lifetime signal. Reads still reject after
// cancellation even when a source buffers data or ignores fetch aborts.
// A null-body status (204 et al.) has nothing to guard, and browsers refuse to
// rebuild one around the empty body fetch still hands it.
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

function guardResponseBody(response: Response, signal: AbortSignal): Response {
  if (!response.body || NULL_BODY_STATUSES.has(response.status)) return response;
  const source = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let subscribed = false;
  let finished = false;
  // Abort/cancel callbacks can finish the stream while a read is awaited.
  const isFinished = () => finished;
  let removeAbortListener: () => void = () => undefined;
  const cleanup = () => {
    removeAbortListener();
    reader?.releaseLock();
    reader = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      if (finished) return;
      const currentReader = reader ??= source.getReader();
      if (!subscribed) {
        subscribed = true;
        const abort = () => {
          if (finished) return;
          finished = true;
          stream.error(signal.reason);
          removeAbortListener();
          void currentReader.cancel(signal.reason).catch(() => undefined).finally(cleanup);
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        removeAbortListener = () => {
          signal.removeEventListener('abort', abort);
          removeAbortListener = () => undefined;
        };
      }
      try {
        const chunk = await currentReader.read();
        if (isFinished()) return;
        signal.throwIfAborted();
        if (chunk.done) {
          finished = true;
          cleanup();
          stream.close();
        } else stream.enqueue(chunk.value);
      } catch (error) {
        if (finished) return;
        finished = true;
        cleanup();
        stream.error(error);
      }
    },
    cancel(reason: unknown) {
      finished = true;
      removeAbortListener();
      return reader ? reader.cancel(reason).finally(cleanup) : source.cancel(reason);
    },
  }, { highWaterMark: 0 });
  const guarded = new Response(body, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
  Object.defineProperties(guarded, {
    url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
  });
  return guarded;
}

function scheduleSessionReload(): void {
  if (typeof window === 'undefined' || sessionReloadScheduled) return;
  sessionReloadScheduled = true;
  const key = 'atelier.sessionReloadAt';
  const now = Date.now();
  try {
    const last = Number(window.sessionStorage.getItem(key) ?? 0);
    if (now - last < AUTH_RELOAD_DEBOUNCE_MS) return;
    window.sessionStorage.setItem(key, String(now));
  } catch {
    // The in-memory guard still permits just one reload in this page lifetime.
  }
  // Teardown listeners run synchronously before navigation discards singletons.
  queueMicrotask(() => { window.location.reload(); });
}

export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const details = await extractApiError(response);
    throw new ApiError(response.status, details.message, details.body, responseRequestId(response));
  }
  return response;
}

function scheduleAuthReloadForResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    scheduleAuthReload();
    return;
  }
  // Any HTML body on an API path means the auth edge intercepted the request
  // (login page served inline or via redirect) — reload to re-authenticate.
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.startsWith('text/html')) {
    scheduleAuthReload();
  }
}

function scheduleAuthReload(): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  try {
    const last = Number(window.sessionStorage.getItem(AUTH_RELOAD_STORAGE_KEY) ?? 0);
    if (now - last < AUTH_RELOAD_DEBOUNCE_MS) return;
    window.sessionStorage.setItem(AUTH_RELOAD_STORAGE_KEY, String(now));
  } catch {
    if (now - fallbackAuthReloadAt < AUTH_RELOAD_DEBOUNCE_MS) return;
    fallbackAuthReloadAt = now;
  }
  void (async () => {
    try {
      await Promise.race([
        removePersistedQueryClient(sessionBinding().cacheScope),
        new Promise<void>((resolve) => { setTimeout(resolve, 500); }),
      ]);
    } finally {
      window.location.reload();
    }
  })();
}

function withJsonAccept(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  return { ...init, headers };
}

// First-party API, EXPLICITLY unvalidated: the response shape is trusted and
// cast to `T` without a runtime schema. Wrappers that want runtime validation
// call requestJsonValidated with an exported guard at their own call site —
// whether a response is validated must be visible where the request is made,
// never inferred from the path string. Protocol-critical SSE frames ARE
// validated (see api/sse.ts). Remaining plain JSON calls can still break under
// mid-deploy drift: BYOK status, generation mutations, and prompt-list
// mutation responses may deserialize stale or missing fields until migrated.
export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(path, withJsonAccept(init));
  return response.json() as Promise<T>;
}

export async function requestJsonValidated<T>(
  path: string,
  init: RequestInit = {},
  guard: (value: unknown) => value is T,
): Promise<T> {
  const response = await request(path, withJsonAccept(init));
  const value = await response.json() as unknown;
  if (guard(value)) return value;
  throw new ApiError(response.status, 'invalid response shape', { code: 'invalid-response-shape' }, responseRequestId(response));
}

export async function requestNoContent(path: string, init: RequestInit = {}): Promise<void> {
  await request(path, init);
}

function isCollection(value: unknown): value is Collection {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && isNumber(value.count)
    && isNumber(value.archivedCount)
    && isNumber(value.createdAt);
}

function isLibrarySummary(value: unknown): boolean {
  return isRecord(value)
    && isNumber(value.totalCount)
    && isNumber(value.pinnedCount)
    && isNumber(value.unsortedCount)
    && isNumber(value.archivedTotalCount)
    && isNumber(value.archivedPinnedCount)
    && isNumber(value.archivedUnsortedCount);
}

export function isCollectionsResponse(value: unknown): value is CollectionsResponse {
  return isRecord(value)
    && Array.isArray(value.items)
    && value.items.every(isCollection)
    && isLibrarySummary(value.summary);
}

const backends: ReadonlySet<string> = new Set(BACKEND_VALUES);
const latencies: ReadonlySet<string> = new Set(LATENCY_VALUES);
const pools: ReadonlySet<string> = new Set(POOL_VALUES);
const ratios: ReadonlySet<string> = new Set(RATIO_VALUES);
const durationFrames: ReadonlySet<unknown> = new Set(VIDEO_DURATION_FRAMES);
const availabilityReasons: ReadonlySet<string> = new Set(MODEL_AVAILABILITY_REASONS);

function isAvailability(value: unknown): value is Model['availability'] {
  return isRecord(value)
    && typeof value.ok === 'boolean'
    && isNumber(value.checkedAt)
    && (value.reason === undefined || (typeof value.reason === 'string' && availabilityReasons.has(value.reason)));
}

function isModel(value: unknown): value is Model {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.backend === 'string'
    && backends.has(value.backend)
    && typeof value.tag === 'string'
    && typeof value.latency === 'string'
    && latencies.has(value.latency)
    && (value.size === undefined || typeof value.size === 'string')
    && Array.isArray(value.supportedRatios)
    && value.supportedRatios.every((ratio) => typeof ratio === 'string' && ratios.has(ratio))
    && (value.defaultRatio === undefined
      || (typeof value.defaultRatio === 'string' && value.supportedRatios.includes(value.defaultRatio)))
    && (value.supportsReferenceImages === undefined || typeof value.supportsReferenceImages === 'boolean')
    // Mirrors the defaultRatio clause: element membership AND default-in-set.
    // A duration this bundle has no definition for would otherwise reach
    // DurationChip and take out the composer.
    && (value.supportedDurations === undefined
      || (Array.isArray(value.supportedDurations)
        && value.supportedDurations.every((frames) => durationFrames.has(frames))))
    && (value.defaultDuration === undefined
      || (Array.isArray(value.supportedDurations) && value.supportedDurations.includes(value.defaultDuration)))
    && (value.supportsI2V === undefined || typeof value.supportsI2V === 'boolean')
    && (value.maxRefImages === undefined || isNumber(value.maxRefImages))
    && (value.maxRefBytesPerBatch === undefined || isNumber(value.maxRefBytesPerBatch))
    && isNumber(value.concurrencyCapPerUser)
    && isNumber(value.maxCountPerBatch)
    && (value.batched === undefined || typeof value.batched === 'boolean')
    && (value.outputsVideo === undefined || typeof value.outputsVideo === 'boolean')
    && (value.defaultCount === undefined || isNumber(value.defaultCount))
    && typeof value.pool === 'string'
    && pools.has(value.pool)
    && (value.promptFormat === undefined || value.promptFormat === 'h3-motion')
    && (value.requiresKey === undefined || (isRecord(value.requiresKey) && value.requiresKey.provider === 'google'))
    && (value.availability === undefined || isAvailability(value.availability));
}

export function isModelList(value: unknown): value is readonly Model[] {
  return Array.isArray(value) && value.every(isModel);
}

function isTile(value: unknown): value is Tile {
  if (!isRecord(value) || typeof value.id !== 'string' || !isNumber(value.seed)) return false;
  if (value.refImageIds !== undefined && !isStringArray(value.refImageIds)) return false;
  if (value.status === 'loading') return true;
  if (value.status === 'failed') {
    return isTileErrorCategory(value.error) && isNumber(value.completedAt)
      && (value.moderation === undefined || GptModerationNoticeSchema.safeParse(value.moderation).success);
  }
  return value.status === 'done'
    && typeof value.url === 'string'
    && (value.thumbUrl === undefined || typeof value.thumbUrl === 'string')
    && isMediaPair(value.ext, value.mime)
    && isNumber(value.completedAt);
}

function isProvenance(value: unknown): value is NonNullable<Batch['provenance']> {
  return isRecord(value)
    && (value.templateId === null || typeof value.templateId === 'string')
    && (value.templateName === null || typeof value.templateName === 'string')
    && isNumber(value.rollSeed)
    && isRecord(value.pins)
    && Object.values(value.pins).every((pin) => typeof pin === 'string');
}

function isVideoSequenceSummary(value: unknown): value is NonNullable<Batch['sequence']> {
  return isRecord(value)
    && typeof value.id === 'string'
    && isNumber(value.segmentCount)
    && isNumber(value.totalDurationFrames)
    && (value.masterStatus === 'idle' || value.masterStatus === 'stitching' || value.masterStatus === 'ready' || value.masterStatus === 'failed')
    && (value.masterUpdatedAt === undefined || isNumber(value.masterUpdatedAt));
}

function isBatch(value: unknown): value is Batch {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.prompt === 'string'
    && typeof value.ratio === 'string'
    && ratios.has(value.ratio)
    && typeof value.modelId === 'string'
    && typeof value.modelLabel === 'string'
    && isNumber(value.createdAt)
    && (value.collectionId === null || typeof value.collectionId === 'string')
    && typeof value.pinned === 'boolean'
    && (value.status === 'queued' || value.status === 'running' || value.status === 'done')
    && (value.queueLengthAhead === undefined || isNumber(value.queueLengthAhead))
    && (value.sequenceId === undefined || typeof value.sequenceId === 'string')
    && (value.sequenceIndex === undefined || isNumber(value.sequenceIndex))
    && (value.sequence === undefined || isVideoSequenceSummary(value.sequence))
    && (value.provenance === undefined || isProvenance(value.provenance))
    && Array.isArray(value.tiles)
    && value.tiles.every(isTile);
}

function isHistoryPageOf<T>(value: unknown, itemGuard: (item: unknown) => item is T): value is HistoryPage<T> {
  return isRecord(value)
    && Array.isArray(value.items)
    && value.items.every(itemGuard)
    && (value.nextCursor === null || typeof value.nextCursor === 'string');
}

export function isBatchHistoryPage(value: unknown): value is HistoryPage<Batch> {
  return isHistoryPageOf(value, isBatch);
}

function isArchivedTile(value: unknown): value is ArchivedTile {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.batchId === 'string'
    && typeof value.prompt === 'string'
    && typeof value.modelLabel === 'string'
    && isNumber(value.seed)
    && value.status === 'done'
    && (value.refImageIds === undefined || isStringArray(value.refImageIds))
    && typeof value.url === 'string'
    && (value.thumbUrl === undefined || typeof value.thumbUrl === 'string')
    && isMediaPair(value.ext, value.mime)
    && typeof value.ratio === 'string'
    && ratios.has(value.ratio)
    && isNumber(value.completedAt)
    && isNumber(value.archivedAt);
}

export function isArchivePage(value: unknown): value is ArchivePage {
  return isHistoryPageOf(value, isArchivedTile)
    && isRecord(value)
    && (value.total === null || isNumber(value.total));
}

function isVariableOption(value: unknown): value is VariableOption {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.listId === 'string'
    && typeof value.value === 'string'
    && isStringArray(value.tagIds)
    && isNumber(value.sortOrder)
    && isNumber(value.weight);
}

function isVariableList(value: unknown): value is VariableList {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && Array.isArray(value.options)
    && value.options.every(isVariableOption)
    && isNumber(value.sortOrder)
    && isNumber(value.createdAt)
    && isNumber(value.updatedAt);
}

function isDimensionTag(value: unknown): value is DimensionTag {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.dimensionId === 'string'
    && typeof value.label === 'string'
    && isNumber(value.sortOrder);
}

function isTagDimension(value: unknown): value is TagDimension {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && Array.isArray(value.tags)
    && value.tags.every(isDimensionTag);
}

function isPromptTemplate(value: unknown): value is PromptTemplate {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.body === 'string'
    && (value.notes === undefined || typeof value.notes === 'string')
    && isNumber(value.sortOrder)
    && isNumber(value.createdAt)
    && isNumber(value.updatedAt);
}

export function isPromptLibraryResponse(value: unknown): value is PromptLibraryResponse {
  return isRecord(value)
    && Array.isArray(value.templates)
    && value.templates.every(isPromptTemplate)
    && Array.isArray(value.variableLists)
    && value.variableLists.every(isVariableList)
    && Array.isArray(value.dimensions)
    && value.dimensions.every(isTagDimension);
}
