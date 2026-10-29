import { NOOP_PROVIDER_LOGGER, type HealthResult, type Provider, type ProviderGenerateOptions, type ProviderLogger, type ProviderProgress, type ProviderRequest, type ProviderResult } from './types';
import {
  readBodyBounded as readBodyBoundedShared,
  tryParseJson,
} from './_http';
import { abortableDelay, abortReason } from '../lifecycle/abort';
import { sniffImage } from '../storage/imageSniff';
import { sniffVideo } from '../storage/sniffVideo';
import {
  COMFYUI_FREE_PATH,
  COMFYUI_PROMPT_PATH,
  COMFYUI_SYSTEM_STATS_PATH,
  COMFYUI_WS_PATH,
} from './comfyui.config';
import { buildWorkflow } from './comfyui/template';
import { createPrivacyTransport, drainPrivacyLeases, privateNodeClass, submissionNodeClass, PrivacyNotReadyError, PrivacyRequestError, PrivacyInvalidResponseError, type PrivacyConfig, type PrivacyJob, type ComfyFetch } from './comfyui/privacy';
import { snapVideoFrameGrid } from '@atelier/shared';
import { createComfyuiHealthTransport, type ComfyuiHealthTransport } from './comfyui/health';

export interface ComfyuiProviderConfig {
  baseUrl: string;
  /** Operational events; defaults to a no-op logger. */
  logger?: ProviderLogger;
  privacy: PrivacyConfig;
  /** Registry-scoped concurrent host reads, with this host's fixed credentials. */
  healthTransport?: ComfyuiHealthTransport;
  // Raw workflow JSON text with `{{prompt}}` / `{{seed}}` / `{{width}}` /
  // `{{height}}` placeholders. Read once at process start by the registry; the
  // adapter doesn't touch the filesystem so tests can inject a stub workflow.
  workflowText: string;
  // Hard ceiling on bytes the adapter buffers from any single HTTP response
  // (submission, inventory, error bodies). A misbehaving upstream
  // returning unbounded data would otherwise blow through RAM.
  maxResponseBytes: number;
  /** SaveImage node id in this model's workflow graph. */
  saveImageNodeId: string;
  /** Defaults to image when omitted. Video models fetch and sniff mp4 outputs. */
  outputKind?: 'image' | 'video';
  /** Per-workflow required placeholders for buildWorkflow validation. */
  requiredPlaceholders: readonly string[];
  /**
   * Base-sampler step count used when a request carries no `steps` override.
   * Fills `{{steps}}` in every graph of this model.
   */
  defaultSteps?: number;
  /**
   * Continuation graph for this host — anchors the previous segment's tail
   * with MiniMaxH3AddGuide instead of a still first_frame. Present only where
   * the host's ComfyUI ships that node; absent means extensions transparently
   * take the still-frame graph above.
   */
  extendWorkflowText?: string;
  extendRequiredPlaceholders?: readonly string[];
  /** Face-reference graph; absent means this host cannot take image references. */
  referenceWorkflowText?: string;
  referenceRequiredPlaceholders?: readonly string[];
  /** This model's ratio→dims map. */
  ratioDims: Record<string, { width: number; height: number } | undefined>;
  /** Model id — used to gate the safety-placeholder detector (Task 6). */
  modelId: string;
  /** Residency identity for eviction decisions. Defaults to modelId. */
  residencyKey?: string;
  /** Weight filenames that must be registered on the host for this model to be usable. */
  requiredModelFiles: readonly string[];
  /**
   * CLIPLoader `type` string required by this workflow. If set, healthCheck
   * verifies the host's CLIPLoader type enum contains it. A host can have all
   * weight files but an old ComfyUI build that lacks the type, causing a
   * node-validation failure at /prompt.
   */
  requiredClipType?: string;
}

interface ImageRef {
  filename: string;
  subfolder: string;
  type: string;
  bytes?: number;
  mediaType?: string;
}

type OutputKind = 'image' | 'video';

export class ComfyuiUpstreamError extends Error {
  readonly status: number;
  declare readonly body: unknown;

  constructor(message: string, status: number, body: unknown = null) {
    // Classification may inspect a bounded body in memory. The logger projects
    // Errors to status only; the raw body is never enumerable or logged.
    super(formatMessageWithBody(message, body));
    this.name = 'ComfyuiUpstreamError';
    this.status = status;
    Object.defineProperty(this, 'body', { value: body, enumerable: false });
  }
}

const COMFYUI_BODY_IN_MESSAGE_CAP = 1024;

function formatMessageWithBody(message: string, body: unknown): string {
  if (body === null || body === undefined) return message;
  let bodyText: string;
  try {
    bodyText = typeof body === 'string' ? body : JSON.stringify(body);
  } catch {
    bodyText = '<unserializable body>';
  }
  if (bodyText.length > COMFYUI_BODY_IN_MESSAGE_CAP) {
    bodyText = `${bodyText.slice(0, COMFYUI_BODY_IN_MESSAGE_CAP)}…[truncated]`;
  }
  return `${message} | body: ${bodyText}`;
}

export class ComfyuiResponseTooLargeError extends Error {
  readonly status = 500;
  readonly limit: number;
  readonly seenBytes: number;

  constructor(limit: number, seenBytes: number) {
    super(`ComfyUI response exceeded ${limit} bytes (saw ${seenBytes})`);
    this.name = 'ComfyuiResponseTooLargeError';
    this.limit = limit;
    this.seenBytes = seenBytes;
  }
}

function failedTerminals(req: ProviderRequest, error: unknown): ProviderResult[] {
  const count = req.count ?? 1;
  return Array.from({ length: count }, (_, index) => ({
    status: 'failed' as const,
    error,
    seed: req.seed,
    index,
  }));
}

// A warm-path hint is valid only if the worker confirms that this successful
// prompt was its last submission, including attempts from other producers.
const residentKeyByHost = new Map<string, { key: string; promptId: string }>();

// Test-only: reset the per-host resident-model tracker between cases so a reused
// ephemeral port from a prior test server can't make a model switch look like a
// no-op (and vice versa). Never call this in production code.
export function __resetComfyuiResidentModels(): void {
  residentKeyByHost.clear();
}

// Fraction of total VRAM that must be free before we consider the card cleared
// enough to load a fresh model set. Measured under --highvram: with a prior t2i
// model resident the card reports ~0.6 free; after a full /free it reports
// ~0.99 free. 0.85 sits cleanly between the two, so it discriminates
// "evicted" from "still resident" — do NOT lower it: ~0.4 free (a resident
// video-sized model) would still pass with the t2i model resident → the OOM we
// fix here.
const VRAM_CLEARED_FRACTION = 0.85;
const VRAM_POLL_INTERVAL_MS = 1_000;
const VRAM_POLL_TIMEOUT_MS = 30_000;

// Unload models the host is holding in VRAM (POST /free) and wait until that
// actually takes effect. /free only sets a queue flag that ComfyUI's prompt
// worker processes AFTER any already-dequeued prompt, so we cannot submit
// /prompt until /system_stats CONFIRMS the drop — otherwise the new model loads
// on top of the old one. Best-effort: a missing /free, or VRAM that never
// confirms clear within the timeout, proceeds anyway (no worse than the prior
// OOM behavior) but is logged so the failure is visible in prod.
function logEvictionTimeout(logger: ProviderLogger): void {
  logger.warn(
    { event: 'comfyui_vram_evict', outcome: 'poll_timeout', timeoutMs: VRAM_POLL_TIMEOUT_MS },
    'submitting prompt without confirmed VRAM headroom',
  );
}

async function evictResidentModels(
  baseUrl: string,
  maxResponseBytes: number,
  signal: AbortSignal,
  logger: ProviderLogger,
  request: ComfyFetch,
): Promise<void> {
  // Bound the entire eviction phase, including response-body reads. The old
  // loop checked Date.now() only after /system_stats JSON had fully buffered,
  // so a stalled or unbounded body could hold the single local slot until the
  // 10/20-minute generation timeout instead of this 30-second ceiling.
  const evictionSignal = AbortSignal.any([signal, AbortSignal.timeout(VRAM_POLL_TIMEOUT_MS)]);
  try {
    const res = await request(`${baseUrl}${COMFYUI_FREE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: evictionSignal,
    });
    if (!res.ok) {
      logger.warn({ event: 'comfyui_vram_evict', outcome: 'free_not_ok', status: res.status }, 'ComfyUI /free failed');
      return;
    }
    const deadline = Date.now() + VRAM_POLL_TIMEOUT_MS;
    for (;;) {
      if (evictionSignal.aborted) throw abortReason(evictionSignal);
      if (await vramCleared(baseUrl, maxResponseBytes, evictionSignal, request)) return;
      if (Date.now() >= deadline) {
        logEvictionTimeout(logger);
        return;
      }
      await abortableDelay(VRAM_POLL_INTERVAL_MS, evictionSignal);
    }
  } catch (error) {
    if (signal.aborted) throw error;
    logEvictionTimeout(logger);
  }
}

// Returns true ONLY when /system_stats positively confirms the card is mostly
// free. A non-ok response, unreadable body, or missing device reading returns
// FALSE so the caller keeps polling (and retries the read) rather than
// submitting /prompt on no evidence — the stats read is the only proof we have
// that /free actually unloaded the resident model. Abort propagates promptly.
async function vramCleared(
  baseUrl: string,
  maxResponseBytes: number,
  signal: AbortSignal,
  request: ComfyFetch,
): Promise<boolean> {
  let stats: { devices?: unknown };
  try {
    const res = await request(`${baseUrl}${COMFYUI_SYSTEM_STATS_PATH}`, { method: 'GET', signal });
    if (!res.ok) return false; // can't measure → not confirmed, keep polling
    const body = await readBodyBounded(res, maxResponseBytes, signal);
    const parsed = tryParseJson(body);
    if (!isObject(parsed)) return false;
    stats = parsed;
  } catch (error) {
    if (signal.aborted) throw error; // honor cancellation promptly
    return false; // measurement failed → not confirmed, keep polling
  }
  const device = Array.isArray(stats.devices) ? (stats.devices[0] as unknown) : undefined;
  const total = isObject(device) && typeof device.vram_total === 'number' ? device.vram_total : 0;
  const free = isObject(device) && typeof device.vram_free === 'number' ? device.vram_free : 0;
  if (total <= 0) return false; // no usable reading → keep polling
  return free >= total * VRAM_CLEARED_FRACTION;
}

// Walk every loader class's required-input enum arrays and collect all
// registered filenames. ComfyUI's /object_info shape:
//   { ClassName: { input: { required: { field_name: [[opt1, opt2, ...], ...] } } } }
function collectRegisteredModelFiles(info: unknown): Set<string> {
  const found = new Set<string>();
  if (!isObject(info)) return found;
  for (const cls of Object.values(info)) {
    if (!isObject(cls)) continue;
    const input = (cls as { input?: unknown }).input;
    if (!isObject(input)) continue;
    const required = (input as { required?: unknown }).required;
    if (!isObject(required)) continue;
    for (const field of Object.values(required)) {
      if (!Array.isArray(field)) continue;
      const options: unknown = field[0];
      if (!Array.isArray(options)) continue;
      for (const opt of options) {
        if (typeof opt === 'string') found.add(opt);
      }
    }
  }
  return found;
}

// Extract the CLIPLoader type enum from /object_info. ComfyUI's shape:
//   { CLIPLoader: { input: { required: { type: [[type1, type2, ...], ...] } } } }
// Returns the set of supported type strings for the CLIPLoader node.
function extractClipLoaderTypes(info: unknown): Set<string> {
  const found = new Set<string>();
  if (!isObject(info)) return found;
  const clipLoader = info.CLIPLoader;
  if (!isObject(clipLoader)) return found;
  const input = (clipLoader as { input?: unknown }).input;
  if (!isObject(input)) return found;
  const required = (input as { required?: unknown }).required;
  if (!isObject(required)) return found;
  const typeField = (required as { type?: unknown }).type;
  if (!Array.isArray(typeField)) return found;
  const options: unknown = typeField[0];
  if (!Array.isArray(options)) return found;
  for (const opt of options) {
    if (typeof opt === 'string') found.add(opt);
  }
  return found;
}

// The class_type of this workflow's terminal output node (SaveImageWebsocket
// for image graphs, SaveVideo for video). healthCheck verifies it is registered
// on the host so a rebuilt/fresh ComfyUI missing a node class fails readiness
// instead of erroring at /prompt. Returns null when the workflow can't be parsed
// or the node is absent (test stubs) — in which case the check is skipped.
function extractTerminalNodeClass(workflowText: string, saveImageNodeId: string): string | null {
  try {
    const graph = JSON.parse(workflowText) as Record<string, unknown>;
    const node = graph[saveImageNodeId];
    if (!isObject(node)) return null;
    const cls = (node as { class_type?: unknown }).class_type;
    return typeof cls === 'string' && cls.length > 0 ? cls : null;
  } catch {
    return null;
  }
}

// Every class_type the workflow references, terminal node included. The terminal
// check above only ever covered the output node, which left MID-graph custom
// nodes invisible to readiness: a graph that depends on a class the host does
// not register still passed readiness and then failed every job at /prompt.
// This was written when the attention patch was KJNodes' PathchSageAttentionKJ,
// a third-party pack that can silently fail to import after a ComfyUI update.
// Every graph is core-only now, but the check still earns its keep:
// a core node newer than the host's ComfyUI build simply does not exist there.
// Derived from the graph rather than declared
// per-binding so it cannot drift when a workflow is edited. Returns an empty set
// for unparseable/stub graphs, which skips the check.
function extractNodeClasses(workflowText: string): ReadonlySet<string> {
  const classes = new Set<string>();
  try {
    const graph: unknown = JSON.parse(workflowText);
    if (!isObject(graph)) return classes;
    for (const node of Object.values(graph)) {
      if (!isObject(node)) continue;
      const cls = (node as { class_type?: unknown }).class_type;
      if (typeof cls === 'string' && cls.length > 0) classes.add(cls);
    }
  } catch {
    return classes;
  }
  return classes;
}

export function createComfyuiProvider(config: ComfyuiProviderConfig): Provider {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const wsBase = toWsUrl(baseUrl);
  const privacy = createPrivacyTransport(baseUrl, config.privacy, config.logger);
  const request = privacy.fetch;
  const health = config.healthTransport ?? createComfyuiHealthTransport(baseUrl, config.privacy, config.maxResponseBytes);
  const { maxResponseBytes, workflowText, saveImageNodeId, requiredPlaceholders, ratioDims, modelId, requiredModelFiles, requiredClipType } = config;
  const residencyKey = config.residencyKey ?? modelId;
  const logger = config.logger ?? NOOP_PROVIDER_LOGGER;
  const outputKind = config.outputKind ?? 'image';
  const rawTerminalNodeClass = extractTerminalNodeClass(workflowText, saveImageNodeId);
  const terminalNodeClass = rawTerminalNodeClass !== null ? privateNodeClass(rawTerminalNodeClass) : null;
  const workflowNodeClasses = new Set(extractNodeClasses(workflowText));
  const referenceWorkflowText = config.referenceWorkflowText;
  const referenceRequiredPlaceholders = config.referenceRequiredPlaceholders ?? requiredPlaceholders;
  if (referenceWorkflowText !== undefined) {
    for (const cls of extractNodeClasses(referenceWorkflowText)) workflowNodeClasses.add(cls);
  }
  const extendWorkflowText = config.extendWorkflowText;
  const extendRequiredPlaceholders = config.extendRequiredPlaceholders ?? requiredPlaceholders;
  if (extendWorkflowText !== undefined) {
    for (const cls of extractNodeClasses(extendWorkflowText)) workflowNodeClasses.add(cls);
  }
  const requiredNodeClasses = [...workflowNodeClasses].map(privateNodeClass);

  return {
    id: 'comfyui',
    backend: 'local',
    async healthCheck(signal: AbortSignal): Promise<HealthResult> {
      // Authenticated private readiness is an uncached host check.
      // 2. Model-file presence — query /object_info and confirm each
      //    requiredModelFiles entry appears in any loader's registered enum.
      //    Skipped when requiredModelFiles is empty (test helpers).
      // 3. CLIPLoader type support — if requiredClipType is set, verify the
      //    host's CLIPLoader type enum includes it. A host can have the weight
      //    files but an old ComfyUI build that lacks the custom CLIP type causes
      //    a node-validation failure at /prompt, not at this health check.
      // 4. Node-class registration — every class_type the workflow references
      //    must be registered on the host, so a custom-node pack that failed to
      //    import (for example, KJNodes) fails readiness instead of failing every
      //    job at /prompt.
      try {
        const metadata = await health.handshake(signal);
        if (outputKind === 'video' && !metadata.video) throw new PrivacyNotReadyError('comfyui protocol 2 video outputs required');
        if (requiredNodeClasses.some((kind) => !metadata.allowedNodes.includes(submissionNodeClass(kind, outputKind === 'image')))) {
          return { ok: false, reason: 'comfyui workflow contains prohibited node classes', probeCode: 'privacy_not_ready' };
        }
      }
      catch (err) {
        return { ok: false, reason: 'comfyui privacy controls unavailable',
          probeCode: err instanceof PrivacyNotReadyError ? 'privacy_not_ready' : 'privacy_transport' };
      }
      if (
        requiredModelFiles.length === 0
        && requiredClipType === undefined
        && terminalNodeClass === null
        && workflowNodeClasses.size === 0
      ) {
        return { ok: true };
      }
      try {
        const info = await health.inventory(signal);
        if (typeof info !== 'object' || info === null) {
          return { ok: false, reason: 'comfyui /object_info returned non-object body', probeCode: 'inventory_invalid' };
        }
        if (requiredModelFiles.length > 0) {
          const registered = collectRegisteredModelFiles(info);
          const missing = requiredModelFiles.filter((f) => !registered.has(f));
          if (missing.length > 0) {
            return { ok: false, reason: `model files not loaded: ${missing.join(', ')}`, probeCode: 'missing_file' };
          }
        }
        if (requiredClipType !== undefined) {
          const clipTypes = extractClipLoaderTypes(info);
          if (!clipTypes.has(requiredClipType)) {
            return { ok: false, reason: `clip type '${requiredClipType}' not supported by this ComfyUI build`, probeCode: 'missing_clip_type' };
          }
        }
        const activeTerminalClass = terminalNodeClass === null ? null : submissionNodeClass(terminalNodeClass, outputKind === 'image');
        if (activeTerminalClass !== null && !(activeTerminalClass in info)) {
          return { ok: false, reason: `terminal node class '${terminalNodeClass}' not registered on this ComfyUI build`, probeCode: 'missing_node_class' };
        }
        const missingClasses = requiredNodeClasses.map((cls) => submissionNodeClass(cls, outputKind === 'image'))
          .filter((cls) => !(cls in info));
        if (missingClasses.length > 0) {
          return { ok: false, reason: `node classes not registered on this ComfyUI build: ${missingClasses.join(', ')}`, probeCode: 'missing_node_class' };
        }
        return { ok: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, reason, probeCode: 'inventory_transport' };
      }
    },
    async *generate(
      req: ProviderRequest,
      signal: AbortSignal,
      options?: ProviderGenerateOptions,
    ): AsyncIterable<ProviderResult> {
      let privateJob: PrivacyJob | undefined;
      let storagePending = false;
      const terminalIndices = new Set<number>();
      try {
        const dims = ratioDims[req.ratio];
        if (!dims) {
          yield* failedTerminals(req, `unsupported ratio: ${req.ratio}`);
          return;
        }

        // A continuation runs the AddGuide graph when this host has one; every
        // other case (first segment, or a host without the node) keeps the
        // still-frame graph, which is what makes the fallback silent.
        const useExtendGraph = outputKind === 'video'
          && req.i2vContext !== undefined
          && extendWorkflowText !== undefined;
        const reference = outputKind === 'image' ? req.refImages?.[0] : undefined;
        if (reference !== undefined && referenceWorkflowText === undefined) {
          yield* failedTerminals(req, `model '${modelId}' has no face-reference graph`);
          return;
        }
        const activeWorkflowText = reference !== undefined && referenceWorkflowText !== undefined
          ? referenceWorkflowText : useExtendGraph ? extendWorkflowText : workflowText;
        const activePlaceholders = reference !== undefined
          ? referenceRequiredPlaceholders : useExtendGraph ? extendRequiredPlaceholders : requiredPlaceholders;
        const contextFrames = useExtendGraph ? (req.i2vContext?.contextFrames ?? 0) : 0;

        // Reserving the lease is also the generation-time privacy handshake.
        // It keeps the worker alive throughout model eviction, before uploads.
        if (options?.executionTimeoutMs === undefined) throw new PrivacyNotReadyError('comfyui execution budget required');
        privateJob = await privacy.createJob(signal, options.executionTimeoutMs, outputKind);
        const inputs = reference !== undefined ? [{ bytes: reference.bytes, image: true }]
          : useExtendGraph && req.i2vContext ? [{ bytes: req.i2vContext.bytes, image: false }]
          : activePlaceholders.includes('{{sourceImage}}') && req.i2vSource ? [{ bytes: req.i2vSource.bytes, image: true }] : [];
        privateJob.validateRequest(extractNodeClasses(activeWorkflowText), req.count ?? 1, inputs);
        const resident = residentKeyByHost.get(baseUrl);
        if (resident?.key !== residencyKey || resident.promptId !== privateJob.previousPromptId) {
          // A failed switch or an intervening producer must never leave a
          // reusable hint for weights which may already have changed.
          residentKeyByHost.delete(baseUrl);
          await evictResidentModels(baseUrl, maxResponseBytes, AbortSignal.any([signal, privateJob.signal]), logger, request);
        }

        let sourceImage: string | undefined;
        let referenceImage: string | undefined;
        let contextVideo: string | undefined;
        // Only graphs that declare a {{sourceImage}} placeholder (I2V) need a
        // source still; the T2V graph conditions on {{prompt}} alone, and the
        // continuation graph on {{contextVideo}}.
        if (reference !== undefined) {
          try {
            referenceImage = await privateJob.upload(reference.bytes, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            yield* failedTerminals(req, toErrorPayload(error));
            return;
          }
        } else if (outputKind === 'video' && activePlaceholders.includes('{{contextVideo}}')) {
          if (req.i2vContext === undefined) {
            yield* failedTerminals(req, 'comfyui video continuation requires a context clip');
            return;
          }
          try {
            contextVideo = await privateJob.upload(req.i2vContext.bytes, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            yield* failedTerminals(req, toErrorPayload(error));
            return;
          }
        } else if (outputKind === 'video' && activePlaceholders.includes('{{sourceImage}}')) {
          if (req.i2vSource === undefined) {
            yield* failedTerminals(req, 'comfyui video generation requires an i2v source');
            return;
          }
          try {
            sourceImage = await privateJob.upload(req.i2vSource.bytes, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            yield* failedTerminals(req, toErrorPayload(error));
            return;
          }
        }

        let workflow: Record<string, unknown>;
        try {
          workflow = buildWorkflow(activeWorkflowText, {
            prompt: req.prompt,
            seed: req.seed,
            width: dims.width,
            height: dims.height,
            count: req.count ?? 1,
            ...(req.motionPrompt !== undefined ? { motionPrompt: req.motionPrompt } : {}),
            ...(sourceImage !== undefined ? { sourceImage } : {}),
            ...(referenceImage !== undefined ? { referenceImage } : {}),
            ...(contextVideo !== undefined ? { contextVideo } : {}),
            // The user's per-model override, resolved once per batch, else the
            // row default; buildWorkflow throws if a graph declares {{steps}}
            // and neither is present.
            ...((req.steps ?? config.defaultSteps) !== undefined
              ? { steps: req.steps ?? config.defaultSteps }
              : {}),
            // Video rows declare {{videoFrames}}; buildWorkflow throws if the
            // template needs it and the request never carried one. A continuation
            // renders its context head ON TOP of the requested clip length, so
            // what the user picked is what survives the stitcher's trim.
            ...(req.durationFrames !== undefined
              ? {
                  videoFrames: contextFrames > 0
                    ? snapVideoFrameGrid(req.durationFrames + contextFrames)
                    : req.durationFrames,
                }
              : {}),
          }, activePlaceholders);
        } catch (error) {
          yield* failedTerminals(req, toErrorPayload(error));
          return;
        }

        privateJob.transform(workflow);

        let result: JobResult;
        const jobController = new AbortController();
        const jobSignal = AbortSignal.any([signal, jobController.signal, privateJob.signal]);
        let runningJob: Promise<void> | undefined;
        try {
          type JobStreamEvent =
            | { kind: 'preview'; preview: ComfyPreview }
            | { kind: 'outcome'; outcome: { ok: true; result: JobResult } | { ok: false; error: unknown } };
          const events: JobStreamEvent[] = [];
          let wake: (() => void) | null = null;
          runningJob = runJob({
            baseUrl,
            wsBase,
            request,
            privacy,
            privateJob,
            workflow,
            maxResponseBytes,
            saveImageNodeId,
            outputKind,
            expectedCount: req.count ?? 1,
            ownerSignal: signal,
            signal: jobSignal,
            onProgress: options.onProgress,
            onPreview: (preview) => {
              events.push({ kind: 'preview', preview });
              const resolve = wake;
              wake = null;
              resolve?.();
            },
          }).then(
            (jobResult) => ({ ok: true as const, result: jobResult }),
            (error: unknown) => ({ ok: false as const, error }),
          ).then((outcome) => {
            events.push({ kind: 'outcome', outcome });
            const resolve = wake;
            wake = null;
            resolve?.();
          });

          for (;;) {
            const event = events.shift();
            if (!event) {
              await new Promise<void>((resolve) => { wake = resolve; });
              continue;
            }
            if (event.kind === 'preview') {
              yield {
                status: 'partial',
                preview: event.preview.preview,
                index: event.preview.index,
                batchIndex: 0,
                seed: req.seed,
              };
              continue;
            }
            if (!event.outcome.ok) throw event.outcome.error;
            result = event.outcome.result;
            break;
          }
          await runningJob;
        } catch (error) {
          if (signal.aborted) throw error;
          yield* failedTerminals(req, toErrorPayload(error));
          return;
        } finally {
          // If a consumer stops after a preview instead of draining the provider
          // iterator, unwind the websocket job rather than leaving GPU work and
          // listeners detached from an owner.
          jobController.abort(new DOMException('provider iterator closed', 'AbortError'));
          await runningJob;
        }

        residentKeyByHost.set(baseUrl, { key: residencyKey, promptId: privateJob.id });

        if (result.kind === 'video') {
          const video = result.refs[0];
          if (video === undefined) {
            yield { status: 'failed', error: 'comfyui returned no video output', seed: req.seed, index: 0 };
            return;
          }
          let bytes: Uint8Array;
          try {
            bytes = await privateJob.download(video, privateJob.outputLimit(maxResponseBytes), signal);
          } catch (error) {
            if (signal.aborted) throw error;
            yield { status: 'failed', error: toErrorPayload(error), seed: req.seed, index: 0 };
            return;
          }

          if (sniffVideo(bytes) !== 'mp4') {
            yield { status: 'failed', error: 'comfyui returned non-MP4 bytes', seed: req.seed, index: 0 };
            return;
          }

          storagePending = true;
          terminalIndices.add(0);
          yield { status: 'ready', bytes, ext: 'mp4', mime: 'video/mp4', seed: req.seed, index: 0, contextFrames, afterStored: privateJob.release };
          return;
        }

        // Per-image failures retain the requested index for tile settlement.
        const job = privateJob;
        const images = result.images;
        const validImages = images.map((bytes) => sniffImage(bytes)?.mime === 'image/png');
        const pendingStores = new Set(validImages.flatMap((valid, i) => valid ? [i] : []));
        for (const [i, bytes] of images.entries()) {
          terminalIndices.add(i);
          if (!validImages[i]) {
            yield { status: 'failed', error: 'comfyui returned non-PNG bytes', seed: req.seed, index: i };
            continue;
          }

          storagePending = true;
          yield { status: 'ready', bytes, ext: 'png', mime: 'image/png', seed: req.seed, index: i, afterStored: async () => {
            pendingStores.delete(i);
            if (pendingStores.size === 0) await job.release();
          } };
        }

        // Completeness: if the upstream delivered fewer images than requested,
        // fail the missing indices explicitly rather than silently yielding a
        // short batch (the orchestrator maps each index 1:1 onto a tile).
        const expectedCount = req.count ?? 1;
        for (let i = images.length; i < expectedCount; i += 1) {
          terminalIndices.add(i);
          yield { status: 'failed', error: 'comfyui returned fewer images than requested', seed: req.seed, index: i };
        }
      } catch (error) {
        if (signal.aborted) throw error;
        for (const failed of failedTerminals(req, toErrorPayload(error))) {
          if (!terminalIndices.has(failed.index)) yield failed;
        }
      } finally {
        // The orchestrator closes its iterator on a terminal BEFORE writeAtomic.
        // Unacknowledged terminals expire on the worker if storage/API fails.
        if (privateJob && !storagePending) trackPrivateRelease(privateJob);
      }
    },
  };
}

interface RunJobArgs {
  request: ComfyFetch;
  privacy: ReturnType<typeof createPrivacyTransport>;
  privateJob: PrivacyJob;
  baseUrl: string;
  wsBase: string;
  workflow: Record<string, unknown>;
  maxResponseBytes: number;
  saveImageNodeId: string;
  outputKind: OutputKind;
  expectedCount: number;
  ownerSignal: AbortSignal;
  signal: AbortSignal;
  onProgress?: ProviderGenerateOptions['onProgress'];
  onPreview?: (preview: ComfyPreview) => void;
}

interface ComfyPreview {
  preview: string;
  index: number;
}

interface ParsedBinaryImage {
  bytes: Uint8Array;
  mime: 'image/jpeg' | 'image/png';
}

interface ParsedBinaryEnvelope {
  payloadOffset: number;
  declaredMime: ParsedBinaryImage['mime'] | null;
  promptId?: string;
  nodeId?: string;
}

const COMFYUI_PREVIEW_IMAGE_EVENT = 1;
const COMFYUI_PREVIEW_WITH_METADATA_EVENT = 4;
const COMFYUI_PREVIEW_MAX_BYTES = 512 * 1024;
const COMFYUI_PREVIEW_PASSES = 5;

function parseComfyBinaryEnvelope(buf: Uint8Array): ParsedBinaryEnvelope | null {
  if (buf.byteLength <= 8) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eventType = view.getUint32(0, false);

  if (eventType === COMFYUI_PREVIEW_IMAGE_EVENT) {
    const imageType = view.getUint32(4, false);
    const declaredMime = imageType === 1 ? 'image/jpeg' : imageType === 2 ? 'image/png' : null;
    return declaredMime === null ? null : { payloadOffset: 8, declaredMime };
  }

  if (eventType === COMFYUI_PREVIEW_WITH_METADATA_EVENT) {
    const metadataLength = view.getUint32(4, false);
    const payloadOffset = 8 + metadataLength;
    if (payloadOffset >= buf.byteLength) return null;
    try {
      const metadataText = new TextDecoder().decode(buf.subarray(8, payloadOffset));
      const metadata = JSON.parse(metadataText) as unknown;
      if (!isObject(metadata) || typeof metadata.prompt_id !== 'string'
        || typeof metadata.node_id !== 'string' || metadata.node_id.length === 0) return null;
      return { payloadOffset, declaredMime: null, promptId: metadata.prompt_id, nodeId: metadata.node_id };
    } catch {
      return null;
    }
  }

  return null;
}

function parseComfyBinaryImage(buf: Uint8Array, envelope = parseComfyBinaryEnvelope(buf)): ParsedBinaryImage | null {
  if (envelope === null) return null;
  const bytes = buf.subarray(envelope.payloadOffset);
  const sniffed = sniffImage(bytes);
  if (sniffed?.mime !== 'image/png' && sniffed?.mime !== 'image/jpeg') return null;
  if (envelope.declaredMime !== null && envelope.declaredMime !== sniffed.mime) return null;
  return { bytes, mime: sniffed.mime };
}

// Output bytes and references come only from authoritative lease status.
type JobResult =
  | { kind: 'video'; refs: ImageRef[] }
  | { kind: 'imageBytes'; images: Uint8Array[] };

async function runJob(args: RunJobArgs): Promise<JobResult> {
  const { baseUrl, wsBase, workflow, maxResponseBytes, saveImageNodeId, outputKind, signal, onProgress, onPreview } = args;
  const clientId = crypto.randomUUID();
  const request = args.request;

  // Subscribe before submission: a warm graph can finish before HTTP headers.
  // The lease gives frames a stable identity even if acknowledgment is lost.
  const promptId = args.privateJob.id;
  const state = { settled: false };
  let currentNode: string | null = null;
  let currentProgress: number | null = null;
  const knownNodes = new Set(Object.keys(workflow));
  const samplerClasses = new Set(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced']);
  const samplerNodes = new Set(Object.entries(workflow)
    .filter(([, node]) => isObject(node) && typeof node.class_type === 'string' && samplerClasses.has(node.class_type))
    .map(([nodeId]) => nodeId));
  for (const raw of Object.values(workflow)) {
    if (!isObject(raw) || !isObject(raw.inputs)) continue;
    for (const edge of Object.values(raw.inputs)) {
      if (Array.isArray(edge) && typeof edge[0] === 'string' && typeof edge[1] === 'number') knownNodes.add(edge[0]);
    }
  }
  let lastPreviewPass = -1;
  let previewIndex = 0;
  const isImageMode = outputKind !== 'video';

  const wsUrl = `${wsBase}${COMFYUI_WS_PATH}?clientId=${clientId}`;
  let ws = args.privacy.websocket(wsUrl);
  // Native latent previews arrive as binary image frames, optionally carrying
  // prompt/node metadata. Pin arraybuffer for deterministic preview decoding.
  ws.binaryType = 'arraybuffer';
  const handleBinary = (buf: Uint8Array) => {
    if (state.settled || !isImageMode) return;
    const envelope = parseComfyBinaryEnvelope(buf);
    if (envelope?.promptId !== undefined && (envelope.promptId !== promptId
      || typeof envelope.nodeId !== 'string' || envelope.nodeId !== currentNode || !knownNodes.has(envelope.nodeId))) return;
    const image = parseComfyBinaryImage(buf, envelope);
    if (image === null) return;
    if (currentNode !== saveImageNodeId) {
      // ComfyUI's built-in latent previewer intentionally decodes x0[:1], so
      // a batched sampler preview belongs to batch image 0 only. Emit at most
      // five progress buckets; these are transient SSE frames and should not
      // crowd out terminal delivery or retain megabytes in slow clients.
      if (currentNode === null || image.bytes.byteLength > COMFYUI_PREVIEW_MAX_BYTES) return;
      const pass = currentProgress === null
        ? Math.min(previewIndex, COMFYUI_PREVIEW_PASSES - 1)
        : Math.min(COMFYUI_PREVIEW_PASSES - 1, Math.floor(currentProgress * COMFYUI_PREVIEW_PASSES));
      if (pass <= lastPreviewPass || previewIndex >= COMFYUI_PREVIEW_PASSES) return;
      lastPreviewPass = pass;
      const index = previewIndex;
      previewIndex += 1;
      onPreview?.({
        preview: `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}`,
        index,
      });
      return;
    }
  };
  let cleanup: () => void = () => undefined;
  const submissionController = new AbortController();
  const workController = new AbortController();
  const workSignal = AbortSignal.any([signal, workController.signal]);
  const isJobAborted = () => signal.aborted;
  const isWorkAborted = () => workSignal.aborted;
  let completionError: Error | undefined;
  let submissionRejection: ComfyuiUpstreamError | undefined;
  let reconciliation: Promise<void> | undefined;
  let reconnecting: Promise<void> | undefined;
  let detachSocket = () => { /* No socket listeners attached yet. */ };
  let postAttempted = false;
  const hasPostAttempted = () => postAttempted;
  let lastNonterminalAt = performance.now();
  let terminalHint = false;
  let wakeRequested = false;
  let wakeStatus: (() => void) | undefined;
  const reconcileNow = () => { terminalHint = true; wakeRequested = true; wakeStatus?.(); };
  const waitForStatus = async (retryingStatus: boolean) => {
    if (retryingStatus) {
      // Terminal hints cannot shorten transient-failure tolerance. Only a
      // successful status read can resume fast history-lag reconciliation.
      wakeRequested = false;
      await abortableDelay(1_000, workSignal);
      wakeRequested = false;
      return;
    }
    if (wakeRequested) { wakeRequested = false; return; }
    const wake = new AbortController();
    wakeStatus = () => { wake.abort(); };
    try { await abortableDelay(terminalHint ? 100 : 1_000, AbortSignal.any([workSignal, wake.signal])); }
    catch (error) { if (workSignal.aborted) throw error; }
    finally { wakeStatus = undefined; wakeRequested = false; }
  };
  try {
    // Defensive: in the microtask window between waitForOpen resolving and
    // the abort listener below being attached, a freshly-aborted composed
    // signal would otherwise fall through to the POST's AbortError. This
    // keeps the failure category aligned with the abort intent.
    if (signal.aborted) throw abortReason(signal);

    let resolveResult: (value: JobResult) => void;
    let rejectResult: (reason: Error) => void;
    const resultPromise = new Promise<JobResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // Completion can fail while /prompt headers or body are still pending.
    // Observe rejection immediately; the scoped lease already owns cleanup.
    void resultPromise.catch(() => undefined);

    const settleResolve = (value: JobResult) => {
      if (state.settled) return;
      state.settled = true;
      workController.abort();
      cleanup();
      resolveResult(value);
    };
    const settleReject = (error: Error) => {
      if (state.settled) return;
      state.settled = true;
      workController.abort();
      completionError = error;
      cleanup();
      rejectResult(error);
      submissionController.abort(error);
    };

    const processFrame = (frame: unknown) => {
      if (state.settled) return;
      if (!isComfyFrame(frame)) return;
      const data = frame.data;
      if (!isFrameData(data)) return;

      if (frame.type === 'progress_state') {
        if (data.prompt_id !== promptId) return;
        if (!isObject(data.nodes)) return;
        for (const [nodeId, node] of Object.entries(data.nodes)) {
          if (!samplerNodes.has(nodeId) || !isObject(node) || node.prompt_id !== promptId || node.node_id !== nodeId) continue;
          if (node.state !== 'running' && node.state !== 'finished') continue;
          reportProgress({ prompt_id: promptId, node: nodeId, value: node.value, max: node.max });
        }
        return;
      }
      if (data.prompt_id !== promptId) return;

      if (frame.type === 'execution_error' || frame.type === 'execution_interrupted') {
        reconcileNow();
        return;
      }
      if (frame.type === 'progress') {
        reportProgress(data);
        return;
      }
      if (frame.type === 'executed') {
        if (data.node !== saveImageNodeId) return;
        reconcileNow();
        return;
      }
      if (frame.type === 'execution_success' || frame.type === 'executing') {
        if (typeof data.node === 'string') {
          currentNode = knownNodes.has(data.node) ? data.node : null;
          return;
        }
        if (frame.type !== 'execution_success' && data.node !== null) return;
        reconcileNow();
      }
    };

    const lastProgressByNode = new Map<string, number>();
    const reportProgress = (data: FrameData) => {
      if (data.node !== undefined && (typeof data.node !== 'string' || !knownNodes.has(data.node))) return;
      const node = typeof data.node === 'string' ? data.node : currentNode;
      const progress = parseProgressFrame({ ...data, ...(node !== null ? { node } : {}) });
      if (!progress || lastProgressByNode.get(progress.phase ?? '') === progress.progress) return;
      lastProgressByNode.set(progress.phase ?? '', progress.progress);
      currentProgress = progress.progress;
      onProgress?.(progress);
    };

    const onMessage = (evt: MessageEvent) => {
      if (typeof evt.data !== 'string') {
        // Native preview frame. handleBinary checks prompt/node context and
        // never uses socket bytes as authoritative output sink delivery.
        const buf =
          evt.data instanceof ArrayBuffer
            ? new Uint8Array(evt.data)
            : evt.data instanceof Uint8Array
              ? evt.data
              : null;
        if (!buf) return;
        handleBinary(buf);
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(evt.data) as unknown;
      } catch {
        return;
      }
      processFrame(frame);
    };
    let reconnects = 0;
    const onClose = () => {
      currentNode = null;
      if (state.settled) return;
      if (reconnecting || reconnects >= 3) return;
      reconnecting = (async () => {
        while (!workSignal.aborted && reconnects < 3) {
          reconnects += 1;
          detachSocket();
          closeQuietly(ws);
          ws = args.privacy.websocket(wsUrl);
          ws.binaryType = 'arraybuffer';
          attachSocket();
          try {
            await waitForOpen(ws, AbortSignal.any([workSignal, AbortSignal.timeout(4_000)]));
            ws.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } }));
            return;
          } catch { /* Status remains authoritative; a reconnect never resubmits. */ }
        }
      })().catch(() => { /* HTTP reconciliation remains bounded by the job signal. */ })
        .finally(() => { reconnecting = undefined; });
    };
    const onError = () => {
      onClose();
    };
    const onAbort = () => { settleReject(abortReason(signal)); };

    cleanup = () => {
      detachSocket();
      signal.removeEventListener('abort', onAbort);
    };

    const attachSocket = () => {
      const socket = ws;
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onClose);
      socket.addEventListener('error', onError);
      detachSocket = () => {
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('close', onClose);
        socket.removeEventListener('error', onError);
      };
    };
    attachSocket();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      await waitForOpen(ws, AbortSignal.any([workSignal, AbortSignal.timeout(4_000)]));
      ws.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } }));
    } catch (error) {
      if (isJobAborted()) throw error;
      onClose();
    }
    signal.throwIfAborted();

    {
      reconciliation = (async () => {
        let consecutiveStatusFailures = 0;
        try {
          while (!isWorkAborted()) {
            await waitForStatus(consecutiveStatusFailures > 0);
            if (!hasPostAttempted()) continue;
            let status;
            const observedAt = performance.now();
            try {
              status = await args.privateJob.status(AbortSignal.any([workSignal, AbortSignal.timeout(4_000)]));
            } catch (error) {
              if (isWorkAborted()) return;
              if (error instanceof PrivacyInvalidResponseError || error instanceof SyntaxError
                || (error instanceof PrivacyRequestError && error.status < 500 && error.status !== 408 && error.status !== 429)) throw error;
              consecutiveStatusFailures += 1;
              if (consecutiveStatusFailures >= 3) throw error;
              continue;
            }
            consecutiveStatusFailures = 0;
            if (status.state === 'failed' || status.state === 'released') throw new Error('comfyui job failed or released');
            if (status.state !== 'completed') { lastNonterminalAt = observedAt; continue; }
            const expected = isImageMode ? args.expectedCount : 1;
            const mediaType = isImageMode ? 'image/png' : 'video/mp4';
            if (status.outputs.length !== expected || status.outputs.some((output) => output.mediaType !== mediaType
              || output.bytes > args.privateJob.outputLimit(maxResponseBytes))) {
              throw new Error('comfyui invalid memory output batch');
            }
            args.privateJob.boundRetrieval(lastNonterminalAt);
            await args.privateJob.own(args.ownerSignal, workSignal);
            const refs = status.outputs.map((output) => ({ filename: output.id, subfolder: promptId,
              type: 'atelier-memory', bytes: output.bytes, mediaType: output.mediaType }));
            if (!isImageMode) { settleResolve({ kind: 'video', refs }); return; }
            const readers = new AbortController();
            const downloadSignal = AbortSignal.any([workSignal, readers.signal]);
            // Status permits at most four outputs. Promise.all preserves the
            // worker's batch order while readers overlap; one failure joins all.
            const downloads = refs.map(async (ref) => {
              try {
                const bytes = await args.privateJob.download(ref, args.privateJob.outputLimit(maxResponseBytes), downloadSignal);
                if (sniffImage(bytes)?.mime !== 'image/png') throw new Error('comfyui invalid memory PNG');
                return bytes;
              } catch (error) { readers.abort(error); throw error; }
            });
            let images: Uint8Array[];
            try { images = await Promise.all(downloads); }
            finally { readers.abort(); await Promise.allSettled(downloads); }
            settleResolve({ kind: 'imageBytes', images });
            return;
          }
        } catch (error) {
          if (!isWorkAborted()) settleReject(error instanceof Error ? error : new Error('comfyui recovery failed'));
        }
      })();
    }

    try {
      const submissionSignal = AbortSignal.any([signal, submissionController.signal, AbortSignal.timeout(8_000)]);
      lastNonterminalAt = performance.now();
      postAttempted = true;
      const submit = await request(`${baseUrl}${COMFYUI_PROMPT_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: workflow,
        prompt_id: promptId,
        client_id: clientId,
        // ComfyUI's global default is no latent previews. Current supported
        // hosts accept this per-queue override, avoiding a host-wide launch
        // flag and keeping video jobs on their existing no-preview path.
        ...(isImageMode ? { extra_data: { preview_method: 'auto' } } : {}),
      }),
      signal: submissionSignal,
      });

      if (!submit.ok) {
        if (submit.status === 408 || submit.status === 429 || submit.status >= 500) {
          await submit.body?.cancel();
          throw new Error('comfyui submission outcome unknown');
        }
        // Stop recovery before reading diagnostics: rejection remains decisive
        // even if its body stalls or status/socket completion races the read.
        const message = `comfyui /prompt returned ${submit.status}`;
        submissionRejection = new ComfyuiUpstreamError(message, submit.status);
        workController.abort();
        cleanup();
        try {
          const body = await readBodyBounded(submit, maxResponseBytes,
            AbortSignal.any([submissionSignal, AbortSignal.timeout(4_000)]));
          submissionRejection = new ComfyuiUpstreamError(message, submit.status, tryParseJson(body));
        } catch { /* Diagnostic read failures cannot erase a definite rejection. */ }
        throw submissionRejection;
      }

    const submissionBody = await readBodyBounded(submit, maxResponseBytes, submissionSignal);
    const submission = tryParseJson(submissionBody);
    if (!isObject(submission) || typeof submission.prompt_id !== 'string' || submission.prompt_id.length === 0) {
      throw new ComfyuiUpstreamError('comfyui /prompt returned no prompt_id', submit.status);
    }
    const nodeErrors = submission.node_errors;
    if (isObject(nodeErrors) && Object.keys(nodeErrors).length > 0) {
      // status=400 stamps the error so sanitizeProviderError → 'upstream rejected'.
      throw new ComfyuiUpstreamError('workflow node validation failed', 400, nodeErrors);
    }

      if (submission.prompt_id !== promptId) throw new ComfyuiUpstreamError('comfyui job identity mismatch', 400);
    } catch (error) {
      if (isJobAborted()) throw abortReason(signal);
      if (submissionRejection) throw submissionRejection;
      if (completionError) throw completionError;
      if (error instanceof ComfyuiUpstreamError || error instanceof ComfyuiResponseTooLargeError) throw error;
      // A lost response is ambiguous after POST. Reconcile the lease and never
      // submit this graph again.
    }
    const result = await resultPromise;
    if (result.kind === 'imageBytes' && result.images.length > args.expectedCount) throw new Error('comfyui returned too many images');
    if (result.kind === 'video' && result.refs.length !== 1) throw new Error('comfyui invalid video output count');
    await args.privateJob.own(args.ownerSignal, signal);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    // Fetch may report AbortError instead of the transport failure that caused
    // its cancellation. Preserve the original completion/abort reason.
    throw signal.aborted ? abortReason(signal) : submissionRejection ?? completionError ?? error;
  } finally {
    submissionController.abort();
    workController.abort();
    cleanup();
    closeQuietly(ws);
    await Promise.allSettled([reconciliation, reconnecting]);
  }
}

// Shutdown awaits all detached private lease releases.
const pendingReleases = new Set<Promise<void>>();

function trackPrivateRelease(job: PrivacyJob): void {
  const pending = job.release().finally(() => { pendingReleases.delete(pending); });
  pendingReleases.add(pending);
}

export async function drainComfyUi(): Promise<void> {
  await drainPrivacyLeases();
  // Releases may register while a previous settle pass is in flight.
  const MAX_PASSES = 8;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    if (pendingReleases.size === 0) return;
    await Promise.allSettled([...pendingReleases]);
  }
}


function waitForOpen(ws: WebSocket, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const onOpen = () => {
      if (settled) return;
      cleanup();
      resolve();
    };
    const onError = () => {
      if (settled) return;
      cleanup();
      reject(new Error('comfyui websocket connect failed'));
    };
    const onClose = () => {
      if (settled) return;
      cleanup();
      reject(new Error('comfyui websocket closed before open'));
    };
    const onAbort = () => {
      if (settled) return;
      cleanup();
      reject(abortReason(signal));
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function readBodyBounded(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  return readBodyBoundedShared(response, limit, {
    onOversize: (lim, total) => {
      throw new ComfyuiResponseTooLargeError(lim, total);
    },
    ...(signal ? { signal } : {}),
  });
}

function toWsUrl(baseUrl: string): string {
  if (baseUrl.startsWith('https://')) return `wss://${baseUrl.slice('https://'.length)}`;
  if (baseUrl.startsWith('http://')) return `ws://${baseUrl.slice('http://'.length)}`;
  throw new Error(`comfyui baseUrl must be http(s): ${baseUrl}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isComfyFrame(value: unknown): value is { type: string; data?: unknown } {
  if (!isObject(value)) return false;
  return typeof value.type === 'string';
}

interface FrameData {
  prompt_id?: unknown;
  node?: unknown;
  output?: unknown;
  value?: unknown;
  max?: unknown;
  nodes?: unknown;
}

function isFrameData(value: unknown): value is FrameData {
  return isObject(value);
}

function parseProgressFrame(data: FrameData): ProviderProgress | null {
  const { value, max } = data;
  if (typeof value !== 'number' || typeof max !== 'number' || !Number.isFinite(value)
    || !Number.isFinite(max) || max <= 0) return null;
  const progress = Math.min(1, Math.max(0, value / max));
  const phase = typeof data.node === 'string' && data.node.length > 0 ? data.node : undefined;
  return phase === undefined ? { progress } : { progress, phase };
}

function toErrorPayload(error: unknown): unknown {
  if (error instanceof Error) return error;
  return { cause: error };
}

function closeQuietly(ws: WebSocket): void {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  } catch {
    // best-effort
  }
}
