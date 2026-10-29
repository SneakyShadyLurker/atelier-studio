import { EXT_MIME, MEDIA_EXT_MIME, MEDIA_EXTS } from '@atelier/shared';
import type { Backend, MediaExt, MediaMime, Ratio, TileExt, TileMime } from '@atelier/shared';

// Structured logger an adapter writes operational events to (the app's pino
// logger satisfies it). Keep field names clear of the content-free
// formatter's redacted keys (e.g. `reason`).
export interface ProviderLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export const NOOP_PROVIDER_LOGGER: ProviderLogger = {
  info: () => undefined,
  warn: () => undefined,
};

export interface ProviderRequest {
  prompt: string;
  modelId: string;
  ratio: Ratio;
  tileIndex: number;
  seed: number;
  /** Number of images to produce in this call. Defaults to 1. Non-batched
   *  providers always receive 1 and always yield a single terminal result. */
  count?: number;
  refImages?: readonly { bytes: Uint8Array; mime: TileMime }[];
  i2vSource?: { bytes: Uint8Array; ext: string };
  /**
   * Tail of the segment being extended (video + its audio), anchored at frame
   * 0 via `MiniMaxH3AddGuide` so H3 continues the motion and soundtrack it can
   * see. Only offered when the request extends an existing clip; a host whose
   * graph cannot consume it falls back to `i2vSource` and reports
   * `contextFrames: 0`.
   */
  i2vContext?: { bytes: Uint8Array; contextFrames: number };
  motionPrompt?: string;
  /** Clip length in frames for video models; drives the workflow's `length`. */
  durationFrames?: number;
  /**
   * The user's base-sampler step override for local models, resolved once per
   * batch at dispatch. Absent means the model's `defaultSteps`.
   */
  steps?: number;
}

export interface ProviderProgress {
  progress: number;
  phase?: string;
}

export interface ProviderGenerateOptions {
  onProgress?: (progress: ProviderProgress) => void;
  /** Canonical orchestrator budget, including step/frame scaling, for executor admission. */
  executionTimeoutMs?: number;
}

export type ProviderResult =
  | {
      status: 'partial';
      /** `data:` URL the orchestrator forwards verbatim to the client as a preview. */
      preview: string;
      /** Monotonic ordinal within this tile (cliproxy `partial_image_index`); orchestrator forwards as-is. */
      index: number;
      /** Zero-based image ordinal within a provider batch. Single-image providers
       *  and ComfyUI's first-latent sampler preview always emit 0. */
      batchIndex: number;
      seed: number;
    }
  | {
      status: 'ready';
      bytes: Uint8Array;
      ext: string;
      mime: string;
      seed: number;
      /** Batch ordinal (0-based). Single-image providers always emit 0. */
      index: number;
      revisedPrompt?: string;
      /**
       * Frames of guide context this clip was actually rendered with, and that
       * the stitcher must therefore discard from its front. Absent/0 whenever
       * the still-frame path ran, so it records what happened rather than what
       * was asked for.
       */
      contextFrames?: number;
      /**
       * Optional provider-owned cleanup that the orchestrator invokes only
       * after writeAtomic has durably stored the artifact. This must be
       * idempotent and best-effort: cleanup failure cannot invalidate a
       * successfully persisted image. Delivery is provider-owned and may remain
       * pending after the orchestrator commits success.
       */
      afterStored?: () => Promise<void>;
    }
  | {
      status: 'failed';
      error: unknown;
      seed: number;
      /** Batch ordinal (0-based). Single-image providers always emit 0. */
      index: number;
    };

export type ProviderErrorReason =
  | Readonly<{ kind: 'policy'; status?: number; raw?: string }>
  | Readonly<{ kind: 'no-image'; status?: number; raw?: string }>
  | Readonly<{ kind: 'too-large'; status?: number; raw?: string }>
  | Readonly<{ kind: 'unsupported'; status?: number; raw?: string }>
  | Readonly<{ kind: 'service-unavailable'; status?: number; raw?: string }>
  | Readonly<{ kind: 'http'; status: number; raw?: string }>;

/** Internal, closed probe categories. Never project provider error text to logs or wire. */
export type HealthProbeCode =
  | 'privacy_transport' | 'privacy_not_ready' | 'host_transport'
  | 'inventory_transport' | 'inventory_invalid' | 'missing_file'
  | 'missing_clip_type' | 'missing_node_class';

export type HealthResult =
  | { ok: true }
  | { ok: false; reason: string; probeCode?: HealthProbeCode };

export interface Provider {
  readonly id: string;
  readonly backend: Backend;
  /**
   * Produces results for one or more tiles. Implementations MUST honor
   * `signal` for all in-flight provider work; throwing an AbortError or the
   * signal reason is acceptable because the orchestrator coerces aborts into
   * the public `client disconnected` / `timed out` categories.
   *
   * The contract is: zero or more `partial` yields, followed by exactly one
   * terminal `ready` or `failed` per requested image, each carrying its unique
   * zero-based batch `index`, then completion. Non-batched providers receive
   * `count = 1` and therefore yield exactly one terminal with `index = 0`.
   */
  generate(req: ProviderRequest, signal: AbortSignal, options?: ProviderGenerateOptions): AsyncIterable<ProviderResult>;
  /**
   * Optional liveness probe. When present, the lifecycle health-probe poller
   * calls it to populate `Model.availability` in /api/models. Adapters that
   * omit it are treated as always-available (cloud providers are reachable
   * from the api host by definition; mocks don't have an upstream to probe).
   * Implementations MUST honor `signal` and complete quickly (≤2s budget) —
   * the poller passes a short-timeout signal that aborts on overrun.
   */
  healthCheck?(signal: AbortSignal): Promise<HealthResult>;
}

export function isAllowedArtifact(ext: string, mime: string): ext is MediaExt {
  for (const mediaExt of MEDIA_EXTS) {
    if (mediaExt === ext) return MEDIA_EXT_MIME[mediaExt] === mime;
  }
  return false;
}

export function toTileMime(ext: TileExt): TileMime {
  return EXT_MIME[ext];
}

export function toMediaMime(ext: MediaExt): MediaMime {
  return MEDIA_EXT_MIME[ext];
}
