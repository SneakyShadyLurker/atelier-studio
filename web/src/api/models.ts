import type { Model } from '@atelier/shared';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, isModelList, requestJsonValidated } from './client';

export const modelKeys = {
  all: () => ['models'] as const,
  list: () => [...modelKeys.all(), 'list'] as const,
};

type StableModelKey = keyof Omit<Model, 'availability'>;
const _modelKeyExhaustive = {
  id: true,
  name: true,
  backend: true,
  tag: true,
  latency: true,
  size: true,
  supportedRatios: true,
  defaultRatio: true,
  supportsReferenceImages: true,
  supportsI2V: true,
  outputsVideo: true,
  maxRefImages: true,
  maxRefBytesPerBatch: true,
  concurrencyCapPerUser: true,
  maxCountPerBatch: true,
  batched: true,
  defaultCount: true,
  pool: true,
  promptFormat: true,
  requiresKey: true,
  supportedDurations: true,
  defaultDuration: true,
} satisfies Record<StableModelKey, true>;

// `checkedAt` compares exactly: it is the causal fence that rejects an
// out-of-order snapshot, so the cache must retain the newest value it saw.
function availabilityEqual(a: Model['availability'], b: Model['availability']): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.ok === b.ok
    && a.reason === b.reason
    && a.checkedAt === b.checkedAt;
}

// IMPORTANT: when adding a field to Model, also update this equality. It feeds
// TanStack Query structural sharing, so omitted fields can leave rendered model
// state stale until a larger cache invalidation happens.
function modelEqualByRenderedFields(a: Model, b: Model): boolean {
  return a.id === b.id
    && a.name === b.name
    && a.backend === b.backend
    && a.tag === b.tag
    && a.latency === b.latency
    && a.size === b.size
    && a.supportsReferenceImages === b.supportsReferenceImages
    && a.supportsI2V === b.supportsI2V
    && a.outputsVideo === b.outputsVideo
    && a.maxRefImages === b.maxRefImages
    && a.maxRefBytesPerBatch === b.maxRefBytesPerBatch
    && a.concurrencyCapPerUser === b.concurrencyCapPerUser
    && a.maxCountPerBatch === b.maxCountPerBatch
    && a.batched === b.batched
    && a.defaultCount === b.defaultCount
    && a.defaultRatio === b.defaultRatio
    && a.pool === b.pool
    && a.promptFormat === b.promptFormat
    && a.requiresKey?.provider === b.requiresKey?.provider
    && availabilityEqual(a.availability, b.availability)
    && a.supportedRatios.length === b.supportedRatios.length
    && a.supportedRatios.every((ratio, index) => ratio === b.supportedRatios[index])
    && a.defaultDuration === b.defaultDuration
    && a.supportedDurations?.length === b.supportedDurations?.length
    && (a.supportedDurations ?? []).every((frames, index) => frames === b.supportedDurations?.[index]);
}

// Every write to the models cache (poll, probe, invalidation refetch) passes
// through the same freshness merge, so no writer can regress availability.
function shareModelsStructure(oldData: unknown, newData: unknown): unknown {
  if (!Array.isArray(newData) || !Array.isArray(oldData)) return newData;
  return mergeModelsByAvailabilityFreshness(oldData as readonly Model[], newData as readonly Model[]);
}

export const modelsOpts = () =>
  queryOptions({
    queryKey: modelKeys.list(),
    queryFn: fetchModels,
    structuralSharing: shareModelsStructure,
    // The model list itself is stable (registry doesn't change), but the
    // `availability` field is a live status from the server's background
    // poller (15s cadence). 30s refetch keeps the chip's enabled/disabled
    // state in sync — worst-case lag from outage → disabled is one server
    // probe round + one client refetch.
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && !error.retryable) return false;
      return failureCount < 2;
    },
  });

export function fetchModels(): Promise<readonly Model[]> {
  return requestJsonValidated('/models', {}, isModelList);
}

/**
 * The incoming list is authoritative for registry membership, order and static
 * fields. A row keeps its cached availability only when that was checked
 * strictly later than the incoming snapshot's (an HTTP-cached or in-flight GET
 * landing after a probe, or an older probe landing after a newer one).
 * Unchanged rows, and the whole list when nothing changed, keep their identity.
 */
export function mergeModelsByAvailabilityFreshness(
  cached: readonly Model[] | undefined,
  incoming: readonly Model[],
): readonly Model[] {
  if (cached === undefined) return incoming;
  const cachedById = new Map(cached.map((model) => [model.id, model]));
  const merged = incoming.map((next) => {
    const before = cachedById.get(next.id);
    if (before === undefined) return next;
    const candidate = before.availability !== undefined
      && next.availability !== undefined
      && before.availability.checkedAt > next.availability.checkedAt
      ? { ...next, availability: before.availability }
      : next;
    return modelEqualByRenderedFields(before, candidate) ? before : candidate;
  });
  const unchanged = merged.length === cached.length
    && merged.every((model, index) => model === cached[index]);
  return unchanged ? cached : merged;
}

export function probeModel(modelId: string): Promise<readonly Model[]> {
  return requestJsonValidated(
    `/models/${encodeURIComponent(modelId)}/probe`,
    { method: 'POST' },
    isModelList,
  );
}
