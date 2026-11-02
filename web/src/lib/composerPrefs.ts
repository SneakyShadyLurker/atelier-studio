import {
  MAX_TILE_COUNT,
  RATIO_VALUES,
  isVideoDurationFrames,
  type Ratio,
  type VideoDurationFrames,
} from '@atelier/shared';
import type { ComposerDraft, Count } from '../store/atelier';
import { isRecord } from './guards';
import { localStorageOrUndefined, storageGet, storageSet } from './safeStorage';
import { isSessionLocked } from './sessionScope';

/**
 * The composer settings a user explicitly chose (model, ratio, tile count,
 * clip length), remembered per user across reloads. Restored raw: App's
 * owners (resolveEffectiveModel, the supportedRatios check, the per-model
 * count cap) validate them against the current model list.
 */
export interface ComposerPrefs {
  modelId?: string;
  ratio?: Ratio;
  count?: Count;
  durationFrames?: VideoDurationFrames;
}

export const COMPOSER_PREFS_STORAGE_KEY_PREFIX = 'atelier.composerPrefs.v1';

let activeStorageKey: string | undefined;

export function composerPrefsStorageKey(cacheScope: string): string {
  return `${COMPOSER_PREFS_STORAGE_KEY_PREFIX}:${cacheScope}`;
}

export function setComposerPrefsScope(cacheScope: string): void {
  if (isSessionLocked()) return;
  activeStorageKey = composerPrefsStorageKey(cacheScope);
}

export function resetComposerPrefsScopeForTests(): void {
  activeStorageKey = undefined;
}

const RATIOS: ReadonlySet<string> = new Set(RATIO_VALUES);

const isCount = (value: unknown): value is Count => (
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_TILE_COUNT
);

/** Strict: every invalid or unknown field is dropped, the valid ones kept. */
export function parseComposerPrefs(value: unknown): ComposerPrefs {
  if (!isRecord(value)) return {};
  const { modelId, ratio, count, durationFrames } = value;
  return {
    ...(typeof modelId === 'string' && modelId.length > 0 ? { modelId } : {}),
    ...(typeof ratio === 'string' && RATIOS.has(ratio) ? { ratio: ratio as Ratio } : {}),
    ...(isCount(count) ? { count } : {}),
    ...(typeof durationFrames === 'number' && isVideoDurationFrames(durationFrames) ? { durationFrames } : {}),
  };
}

export function loadComposerPrefs(): ComposerPrefs {
  if (isSessionLocked()) return {};
  const key = activeStorageKey;
  if (!key) return {};
  const raw = storageGet(localStorageOrUndefined(), key);
  if (!raw) return {};
  try {
    return parseComposerPrefs(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function saveComposerPrefs(prefs: ComposerPrefs): void {
  if (isSessionLocked()) return;
  const key = activeStorageKey;
  if (!key) return;
  // Unavailable or full storage only costs the remembered settings.
  storageSet(localStorageOrUndefined(), key, JSON.stringify(prefs));
}

/**
 * The prefs worth remembering from a draft. An image-to-video model needs a
 * source still that does not survive a reload, so it is never stored: the last
 * image model the user picked stands in for it.
 */
export function composerPrefsFromDraft(
  draft: Pick<ComposerDraft, 'modelId' | 'ratio' | 'count' | 'durationFrames' | 'lastImageModelId'>,
  selectedIsI2V: boolean,
): ComposerPrefs {
  const modelId = selectedIsI2V ? draft.lastImageModelId : draft.modelId;
  return {
    ...(modelId !== undefined && modelId !== '' ? { modelId } : {}),
    ...(draft.ratio !== null ? { ratio: draft.ratio } : {}),
    count: draft.count,
    ...(draft.durationFrames !== null ? { durationFrames: draft.durationFrames } : {}),
  };
}
