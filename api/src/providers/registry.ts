import { readFileSync } from 'node:fs';
import { RATIO_VALUES, type Model, type ModelAvailability, type Pool } from '@atelier/shared';
import { cliproxyEnabled, type Config } from '../config';
import type { KeyStore } from '../keystore';
import { loggerForConfig } from '../observability/logger';
import type { Provider } from './types';
import { createMockProvider } from './mock';
import { createCliproxyProvider } from './cliproxy';
import { CLIPROXY_MODEL_ID } from './cliproxy.config';
import { createComfyuiProvider } from './comfyui';
import { createComfyuiHealthTransport } from './comfyui/health';
import { createGoogleProvider } from './google';
import { resilientImageProvider } from './resilientImage';
import { buildResilientPolicy } from '../lifecycle/resilient-call';
import { noteBreakerState } from '../orchestrator/upstreamGate';

import { catalogForConfig, type LocalModelDef } from './comfyui/catalog';
import { GOOGLE_MODEL_IDS } from './google.config';
import type { GoogleModelId } from './google.config';

// Per-request deps the route hands to `bind()`. Non-BYOK entries ignore the
// payload (they bind to the same provider instance every time). BYOK entries
// use `keyPlaintext` to construct the adapter that actually talks to the
// upstream API. The route never imports a concrete adapter — it just calls
// `entry.bind(deps)` and gets back a `Provider` it can hand to the orchestrator.
export interface BindDeps {
  /** BYOK adapters only: decrypted API key for the upstream provider. */
  keyPlaintext?: string;
}

export interface RegistryEntry {
  model: Model;
  /**
   * Returns the provider to use for one request. For non-BYOK entries this is
   * a constant instance; for BYOK entries it constructs the adapter with the
   * per-request decrypted key. Callers MUST go through `bind` — directly
   * touching `entry.provider` is no longer exposed.
   */
  bind: (deps: BindDeps) => Provider;
  timeoutMs: (timeouts: { cloud: number; local: number; localVideo: number }) => number;
  /**
   * Base-sampler step default for local ComfyUI rows (server-only; never on
   * the wire `Model`). Absent for models without a step concept.
   */
  defaultSteps?: number;
}

// Drafts spell out `pool` so the routing-relevant attribute is explicit per
// entry — not derived from `backend` or `requiresKey`. `backend` is a
// wire-display concern (the "local" badge on a model chip), and a future
// mock-as-local entry shouldn't drag itself into the GPU semaphore. Only
// `concurrencyCapPerUser` is derived (from `pool`) — that one is mechanical
// and uniformly follows the chosen semaphore's per-user component.
interface RegistryEntryDraft {
  model: Omit<Model, 'concurrencyCapPerUser' | 'maxCountPerBatch'>;
  bind: (deps: BindDeps) => Provider;
  timeoutMs: (timeouts: { cloud: number; local: number; localVideo: number }) => number;
  defaultSteps?: number;
}

function staticBind(provider: Provider): (deps: BindDeps) => Provider {
  return () => provider;
}

function maxCountForPool(config: Config, pool: Pool, batched?: boolean): number {
  // Batched local providers: the batch itself is one semaphore slot, so the
  // count ceiling is the batch-size cap, not the pool concurrency cap.
  if (batched && pool === 'local') {
    return Math.min(config.COMFYUI_BATCH_MAX, 4);
  }
  const caps = capsForPool(config, pool);
  const globalCap = caps.globalCap ?? Number.POSITIVE_INFINITY;
  const maxCount = Math.min(globalCap, caps.perUserCap);
  return Number.isFinite(maxCount) ? maxCount : 4;
}

// Mock models — built lazily so they share the single mock provider.
function buildMockEntries(config: Config): RegistryEntryDraft[] {
  const mockProvider = createMockProvider({
    slowDelayMs: config.MOCK_PROVIDER_DELAY_MS,
    tileDelays: config.MOCK_PROVIDER_TILE_DELAYS,
  });
  const bind = staticBind(mockProvider);
  return [
    {
      model: {
        id: 'mock-fast',
        name: 'Mock Fast',
        backend: 'local',
        pool: 'shared',
        tag: 'dev',
        latency: 'instant',
        supportedRatios: RATIO_VALUES,
      },
      bind,
      timeoutMs: ({ local }) => local,
    },
    {
      model: {
        id: 'mock-slow',
        name: 'Mock Slow',
        backend: 'local',
        pool: 'shared',
        tag: 'dev',
        latency: 'slow',
        supportedRatios: ['1:1'],
      },
      bind,
      timeoutMs: ({ local }) => local,
    },
    {
      model: {
        id: 'mock-fail',
        name: 'Mock Failure',
        backend: 'local',
        pool: 'shared',
        tag: 'dev',
        latency: 'instant',
        supportedRatios: ['1:1'],
      },
      bind,
      timeoutMs: ({ local }) => local,
    },
    {
      model: {
        id: 'mock-gif',
        name: 'Mock Unsupported Ext',
        backend: 'local',
        pool: 'shared',
        tag: 'dev',
        latency: 'instant',
        supportedRatios: ['1:1'],
      },
      bind,
      timeoutMs: ({ local }) => local,
    },
  ];
}

// Resilient-policy tuning for the gpt-image-2.5-sunburst image upstream. buildResilientPolicy
// constructs a fresh breaker per call, so the gpt-image entry gets its own breaker
// instance — only the config literal is factored out here.
function imageResilientPolicyOptions(config: Config) {
  return {
    timeoutPerAttemptMs: config.CLOUD_TIMEOUT_MS,
    noTimeout: true,
    maxAttempts: config.IMAGE_RETRY_MAX_ATTEMPTS,
    initialBackoffMs: config.IMAGE_RETRY_INITIAL_BACKOFF_MS,
    maxBackoffMs: config.IMAGE_RETRY_MAX_BACKOFF_MS,
    breakerThreshold: config.IMAGE_BREAKER_THRESHOLD,
    halfOpenAfterMs: config.IMAGE_BREAKER_HALF_OPEN_MS,
    breakerOutsideRetry: true,
  };
}

// GPT Image goes through CLIProxyAPI, so it exists only when that is configured.
function buildRealEntries(config: Config): RegistryEntryDraft[] {
  if (!cliproxyEnabled(config)) return [];
  const cliproxy = createCliproxyProvider({
    baseUrl: config.CLIPROXY_BASE_URL,
    token: config.CLIPROXY_TOKEN,
    maxResponseBytes: config.CLIPROXY_MAX_RESPONSE_BYTES,
    openrouterApiKey: config.OPENROUTER_API_KEY,
    logger: loggerForConfig(config),
  });
  const gptImagePolicy = buildResilientPolicy(imageResilientPolicyOptions(config));
  const gptImageResilient = resilientImageProvider(cliproxy, {
    modelId: CLIPROXY_MODEL_ID,
    pool: 'shared',
    policy: gptImagePolicy,
    gate: { noteBreakerState },
  });
  return [
    {
      model: {
        id: CLIPROXY_MODEL_ID,
        name: 'GPT Image 2.5 Sunburst',
        backend: 'cloud',
        pool: 'shared',
        tag: 'cloud',
        latency: 'medium',
        supportedRatios: RATIO_VALUES,
        defaultRatio: '4:5',
        supportsReferenceImages: true,
        maxRefImages: 4,
      },
      bind: staticBind(gptImageResilient),
      timeoutMs: ({ cloud }) => cloud,
    },
  ];
}

// Graph paths come from the model catalog, resolved against each manifest's
// directory and already validated at catalog load.
function loadWorkflowText(path: string, modelId: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Failed to load ComfyUI workflow for model '${modelId}' at ${path}.`, { cause: err });
  }
}

function maxResponseBytesForLocalModel(config: Config, def: LocalModelDef): number {
  return def.outputKind === 'video'
    ? config.LOCAL_VIDEO_MAX_RESPONSE_BYTES
    : config.CLIPROXY_MAX_RESPONSE_BYTES;
}

function buildLocalEntries(config: Config): RegistryEntryDraft[] {
  const baseUrl = config.COMFYUI_BASE_URL;
  if (baseUrl === undefined) return [];
  const drafts: RegistryEntryDraft[] = [];
  const healthTransport = createComfyuiHealthTransport(baseUrl, {
    token: config.COMFYUI_ATELIER_TOKEN, ca: config.COMFYUI_ATELIER_CA,
  }, config.CLIPROXY_MAX_RESPONSE_BYTES);
  const catalog = catalogForConfig(config);
  for (const def of catalog.models) {
    if (def.outputKind === 'video' && !config.VIDEO_MODELS_ENABLED) continue;
    const provider = createComfyuiProvider({
      baseUrl,
      healthTransport,
      logger: loggerForConfig(config),
      privacy: { token: config.COMFYUI_ATELIER_TOKEN, ca: config.COMFYUI_ATELIER_CA },
      workflowText: loadWorkflowText(def.workflowPath, def.id),
      ...(def.referenceWorkflowPath !== undefined
        ? {
            referenceWorkflowText: loadWorkflowText(def.referenceWorkflowPath, def.id),
            referenceRequiredPlaceholders: [...def.requiredPlaceholders, '{{referenceImage}}'],
          }
        : {}),
      ...(def.extendWorkflowPath !== undefined
        ? {
            extendWorkflowText: loadWorkflowText(def.extendWorkflowPath, def.id),
            extendRequiredPlaceholders: def.extendRequiredPlaceholders ?? def.requiredPlaceholders,
          }
        : {}),
      maxResponseBytes: maxResponseBytesForLocalModel(config, def),
      saveImageNodeId: def.saveImageNodeId,
      requiredPlaceholders: def.requiredPlaceholders,
      defaultSteps: def.defaultSteps,
      ratioDims: def.ratioDims,
      modelId: def.id,
      residencyKey: catalog.residencyKey(def.id),
      requiredModelFiles: [...def.requiredModelFiles, ...(def.referenceRequiredModelFiles ?? [])],
      ...(def.outputKind !== undefined ? { outputKind: def.outputKind } : {}),
      ...(def.requiredClipType !== undefined ? { requiredClipType: def.requiredClipType } : {}),
    });
    drafts.push({
      model: {
        id: def.id,
        name: def.name,
        backend: 'local' as const,
        pool: 'local' as const,
        tag: 'comfyui',
        latency: def.latency,
        size: def.size,
        ...(def.promptFormat !== undefined ? { promptFormat: def.promptFormat } : {}),
        supportedRatios: def.supportedRatios,
        ...(def.defaultRatio !== undefined ? { defaultRatio: def.defaultRatio } : {}),
        batched: def.batched,
        defaultCount: Math.min(def.defaultCount, config.COMFYUI_BATCH_MAX),
        ...(def.outputKind === 'video' ? { outputsVideo: true } : {}),
        ...(def.outputKind !== 'video' && def.referenceWorkflowPath !== undefined
          ? { supportsReferenceImages: true, maxRefImages: 1 }
          : {}),
        ...(def.supportedDurations !== undefined ? { supportedDurations: def.supportedDurations } : {}),
        ...(def.defaultDuration !== undefined ? { defaultDuration: def.defaultDuration } : {}),
        ...(def.outputKind === 'video' && def.requiredPlaceholders.includes('{{sourceImage}}')
          ? { supportsI2V: true }
          : {}),
      },
      bind: staticBind(provider),
      timeoutMs: def.outputKind === 'video'
        ? ({ localVideo }) => localVideo
        : ({ local }) => local,
      defaultSteps: def.defaultSteps,
    });
  }
  return drafts;
}

// Google's own public marketing names for each model — display-only, wire IDs
// stay technical (docs/providers.md § Google Gemini).
const GOOGLE_MODEL_DISPLAY: Record<GoogleModelId, { name: string; latency: Model['latency'] }> = {
  'gemini-3-pro-image-preview': { name: 'Nano Banana Pro', latency: 'medium' },
  'gemini-3.1-flash-image-preview': { name: 'Nano Banana 2', latency: 'fast' },
  'gemini-3.1-flash-lite-image': { name: 'Nano Banana 2 Lite', latency: 'fast' },
};

function buildGoogleEntries(config: Config): RegistryEntryDraft[] {
  return GOOGLE_MODEL_IDS.map((id): RegistryEntryDraft => {
    const display = GOOGLE_MODEL_DISPLAY[id];
    return {
      model: {
        id,
        name: display.name,
        backend: 'cloud',
        pool: 'byok',
        tag: 'google',
        latency: display.latency,
        supportedRatios: RATIO_VALUES,
        defaultRatio: '3:4',
        supportsReferenceImages: true,
        maxRefImages: 10,
        requiresKey: { provider: 'google' },
      },
      bind: (deps): Provider => {
        if (!deps.keyPlaintext) {
          throw new Error(`google adapter bind() missing keyPlaintext for ${id}`);
        }
        return createGoogleProvider({
          apiKey: deps.keyPlaintext,
          modelId: id,
          maxResponseBytes: config.CLIPROXY_MAX_RESPONSE_BYTES,
        });
      },
      timeoutMs: ({ cloud }) => cloud,
    };
  });
}

// All registry construction goes through `registryForConfig` so the frozen
// Config — not raw process.env — is the single source of truth for the
// ENABLE_MOCK_PROVIDER gate. Reading process.env at module load (the prior
// shape) sidestepped Config's "loaded once at boot, frozen" contract and
// made tests that try to override the env via setup hooks silently fail.
//
// Memoize against the Config reference: every /api/models and /api/generate
// previously rebuilt the registry (and re-instantiated `createCliproxyProvider`)
// per request. Config is frozen, so a WeakMap keyed by Config is sound and
// lets the GC reclaim entries when a Config instance is dropped (relevant
// only in tests, where each `testRuntime()` mints a fresh Config).
const registryCache = new WeakMap<Config, readonly RegistryEntry[]>();

export function registryForConfig(config: Config): readonly RegistryEntry[] {
  const cached = registryCache.get(config);
  if (cached) return cached;
  const drafts: readonly RegistryEntryDraft[] = [
    ...buildRealEntries(config),
    ...buildLocalEntries(config),
    ...buildGoogleEntries(config),
    ...(config.ENABLE_MOCK_PROVIDER ? buildMockEntries(config) : []),
  ];
  // `concurrencyCapPerUser` mirrors the per-user dimension of the route-side
  // enforcement (`capsForPool`). Single funnel = no drift between the wire
  // value the client renders and the cap the server actually applies.
  const entries: readonly RegistryEntry[] = drafts.map((draft) => ({
    ...draft,
    model: {
      ...draft.model,
      concurrencyCapPerUser: capsForPool(config, draft.model.pool).perUserCap,
      maxCountPerBatch: draft.model.outputsVideo === true
        ? 1
        : maxCountForPool(config, draft.model.pool, draft.model.batched),
      ...(draft.model.supportsReferenceImages === true
        ? { maxRefBytesPerBatch: config.MAX_REF_BYTES_PER_BATCH }
        : {}),
    },
  }));
  registryCache.set(config, entries);
  return entries;
}

export async function publicModelsForUser(
  config: Config,
  ctx: {
    userId: string;
    keyStore: KeyStore | undefined;
    availability?: ReadonlyMap<string, ModelAvailability>;
  },
): Promise<Model[]> {
  const providers = ctx.keyStore
    ? await ctx.keyStore.providersFor(ctx.userId)
    : new Set();

  return registryForConfig(config)
    .filter((entry) => !isLocalModelGated(config, ctx.userId, entry))
    .map((entry) => {
      // Build a fresh object whenever we need to mutate (requiresKey strip or
      // availability merge) — never mutate the cached `entry.model`.
      const gate = entry.model.requiresKey;
      const availability = ctx.availability?.get(entry.model.id);
      if (!availability && !(gate && providers.has(gate.provider))) {
        return entry.model;
      }
      const model: Model = { ...entry.model };
      if (gate && providers.has(gate.provider)) delete model.requiresKey;
      if (availability) model.availability = availability;
      return model;
    });
}

/**
 * Concurrency slots a queued batch holds: a batched model renders every
 * remaining tile in one job (one slot), anything else takes one per tile.
 * Must match the acquire count the generate route enqueues with, or a
 * restart/cancel that recomputes it would exceed the pool cap at dequeue.
 */
export function queueSlotsFor(config: Config, modelId: string, loadingTiles: number): number {
  return findModel(modelId, config)?.model.batched === true ? Math.min(loadingTiles, 1) : loadingTiles;
}

export function localModelsAllowed(config: Config, userId: string): boolean {
  return config.LOCAL_MODELS_USERS.has(userId);
}

export function isLocalModelGated(config: Config, userId: string, entry: { readonly model: Pick<Model, 'pool'> }): boolean {
  return entry.model.pool === 'local' && !localModelsAllowed(config, userId);
}

export function findModel(modelId: string, config: Config): RegistryEntry | null {
  return registryForConfig(config).find((entry) => entry.model.id === modelId) ?? null;
}

// Single source of truth for pool → cap mapping. The `concurrencyCapPerUser`
// projection on `Model` (above) is the wire-display value; this helper is the
// route-side enforcement value. They must agree — keeping the derivation in
// one function makes drift mechanically impossible.
export interface PoolCaps {
  /** Per-user cap used by the matching acquire() call. */
  perUserCap: number;
  /** Global (process-wide) cap, or null when the pool has no global dimension. */
  globalCap: number | null;
}

export function capsForPool(config: Config, pool: Pool): PoolCaps {
  switch (pool) {
    case 'shared':
      return {
        perUserCap: config.MAX_CONCURRENT_TILES_PER_USER,
        globalCap: config.MAX_CONCURRENT_TILES,
      };
    case 'byok':
      return {
        perUserCap: config.MAX_CONCURRENT_TILES_PER_USER_BYOK,
        globalCap: null,
      };
    case 'local':
      return {
        // The local pool has no per-user dimension — every user shares the
        // single GPU semaphore. Report the global value as the displayed
        // per-user cap (matches what the wire-side Model already says).
        perUserCap: config.MAX_CONCURRENT_TILES_LOCAL,
        globalCap: config.MAX_CONCURRENT_TILES_LOCAL,
      };
    default: {
      const _exhaustive: never = pool;
      throw new Error(`unknown pool: ${String(_exhaustive)}`);
    }
  }
}
