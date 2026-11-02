import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { VIDEO_DURATION_FRAMES, type Ratio, type VideoDurationFrames } from '@atelier/shared';
import type { Config } from '../../config';
import { loggerForConfig } from '../../observability/logger';
import { classifyImageModelTarget } from '../../prompts/gptImagePhrasing';
import { PLACEHOLDER_VALUES, type Placeholder } from '../comfyui.config';
import { localModelManifestSchema, type LocalModelManifest } from './manifest';
import { RATIO_MAPS, isRatioMapName, type RatioDims, type RatioMapName } from './ratioMaps';

/** Directory of the bundled model manifests, one `<id>/model.json` per row. */
export const BUILTIN_MODELS_DIR = join(import.meta.dir, 'models');

export type LocalModelFamily = LocalModelManifest['family'];

/**
 * One local model served by the direct ComfyUI host (`COMFYUI_BASE_URL`),
 * resolved from its manifest: graph paths are absolute and the ratio map is
 * looked up by name.
 */
export interface LocalModelDef {
  id: string;
  name: string;
  family: LocalModelFamily;
  order: number;
  /** Models sharing a key load byte-identical loader nodes. Defaults to `id`. */
  residencyKey?: string;
  /** Terminal output node id (SaveImageWebsocket for image graphs, SaveVideo for video). */
  saveImageNodeId: string;
  requiredPlaceholders: readonly Placeholder[];
  /** Base-sampler step count that fills `{{steps}}`; users may override it per model. */
  defaultSteps: number;
  ratioMap: RatioMapName;
  ratioDims: RatioDims;
  supportedRatios: readonly Ratio[];
  defaultRatio?: Ratio;
  supportedDurations?: readonly VideoDurationFrames[];
  defaultDuration?: VideoDurationFrames;
  size: string;
  latency: 'fast' | 'medium' | 'slow';
  batched: boolean;
  defaultCount: number;
  /** Defaults to image when omitted. */
  outputKind?: 'image' | 'video';
  promptFormat?: 'h3-motion';
  /** Absolute path of the base graph. */
  workflowPath: string;
  /** Absolute path of the continuation graph, when the model has one. */
  extendWorkflowPath?: string;
  extendRequiredPlaceholders?: readonly Placeholder[];
  /** Absolute path of the face-reference graph; absent means no reference image. */
  referenceWorkflowPath?: string;
  referenceRequiredModelFiles?: readonly string[];
  requiredModelFiles: readonly string[];
  /** CLIPLoader `type` the host must advertise. */
  requiredClipType?: string;
  /** Directory holding the manifest and its graphs. */
  dir: string;
  manifestPath: string;
}

export interface LocalModelCatalog {
  /** Registered rows, sorted by `order` then `id`. */
  models: readonly LocalModelDef[];
  /** The `krea` family rows, in catalog order. */
  kreaModels: readonly LocalModelDef[];
  byId: ReadonlyMap<string, LocalModelDef>;
  /** Residency key of a model id; any unknown id is its own key. */
  residencyKey: (modelId: string) => string;
}

export interface CatalogLogger {
  info: (fields: Record<string, unknown>, message: string) => void;
}

export interface LoadLocalModelCatalogOptions {
  builtinDir: string;
  externalDir?: string;
  /** Ids registered even when their manifest says `enabled: false`. */
  enableModels?: readonly string[];
  /** Register every manifest regardless of `enabled` (validation tooling). */
  includeDisabled?: boolean;
  logger?: CatalogLogger;
}

/** A catalog failure. The message names a file path and a fixed reason, never file contents. */
export class LocalModelCatalogError extends Error {
  readonly filePath: string;
  constructor(reason: string, filePath: string) {
    super(`local model catalog: ${reason}: ${filePath}`);
    this.name = 'LocalModelCatalogError';
    this.filePath = filePath;
  }
}

interface ManifestFile {
  manifest: LocalModelManifest;
  dir: string;
  path: string;
  /** Regular files directly inside `dir`. */
  files: ReadonlySet<string>;
}

const NOOP_LOGGER: CatalogLogger = { info: () => undefined };
const GRAPH_NAMES = ['base', 'reference', 'extend'] as const;
const PLACEHOLDER_TOKEN = /\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}/g;
const KNOWN_PLACEHOLDERS: ReadonlySet<string> = new Set(PLACEHOLDER_VALUES);
// Any input naming a weight artifact marks a weight-bearing node, whatever its class.
const WEIGHT_ARTIFACT = /\.(safetensors|gguf|ckpt|pt|pth|bin)$/i;

function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new LocalModelCatalogError('cannot read model directory', dir);
  }
}

// Links are never followed: a symlink or special file anywhere a manifest or
// graph could be read stops the load, so every file read stays inside its root.
function refuseLinks(entry: Dirent, path: string): void {
  if (entry.isSymbolicLink()) throw new LocalModelCatalogError('symbolic links are refused', path);
  if (!entry.isFile() && !entry.isDirectory()) {
    throw new LocalModelCatalogError('not a regular file or directory', path);
  }
}

function readManifestDir(root: string): ManifestFile[] {
  const names: string[] = [];
  for (const entry of readEntries(root)) {
    refuseLinks(entry, join(root, entry.name));
    if (entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.')) names.push(entry.name);
  }
  names.sort();
  return names.map((name) => {
    const dir = join(root, name);
    const files = new Set<string>();
    for (const entry of readEntries(dir)) {
      refuseLinks(entry, join(dir, entry.name));
      if (entry.isFile()) files.add(entry.name);
    }
    const path = join(dir, 'model.json');
    if (!files.has('model.json')) throw new LocalModelCatalogError('missing model.json', path);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new LocalModelCatalogError('manifest is not valid JSON', path);
    }
    const parsed = localModelManifestSchema.safeParse(raw);
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))].join(', ');
      throw new LocalModelCatalogError(`manifest fails the schema at ${fields}`, path);
    }
    if (parsed.data.id !== name) throw new LocalModelCatalogError('manifest id does not match its directory', path);
    return { manifest: parsed.data, dir, path, files };
  });
}

function isDuration(value: number): value is VideoDurationFrames {
  return (VIDEO_DURATION_FRAMES as readonly number[]).includes(value);
}

function readGraph(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new LocalModelCatalogError('graph file is missing or unreadable', path);
  }
  let graph: unknown;
  try {
    graph = JSON.parse(text);
  } catch {
    throw new LocalModelCatalogError('graph is not valid JSON', path);
  }
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new LocalModelCatalogError('graph is not a node map', path);
  }
  return text;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function weightNodes(graphText: string): [string, { class_type: unknown; inputs: object }][] {
  const graph = JSON.parse(graphText) as Record<string, { class_type?: unknown; inputs?: unknown }>;
  return Object.entries(graph).flatMap(([id, node]): [string, { class_type: unknown; inputs: object }][] => {
    const inputs = node.inputs;
    if (inputs === null || typeof inputs !== 'object') return [];
    const weighted = Object.values(inputs).some((value) => typeof value === 'string' && WEIGHT_ARTIFACT.test(value));
    return weighted ? [[id, { class_type: node.class_type, inputs }]] : [];
  });
}

// Every selectable graph of a row loads the base graph's weight nodes (a
// reference graph may add LoRA loaders on top), and rows sharing a residency
// key agree on the base weight nodes and declared weight files. Otherwise a
// switch the residency key treats as free would skip a needed eviction.
function weightSignature(graphText: string, requiredModelFiles: readonly string[]): string {
  return canonical({ nodes: Object.fromEntries(weightNodes(graphText)), files: [...requiredModelFiles].sort() });
}

function graphWeights(graphText: string, kind: (typeof GRAPH_NAMES)[number], baseIds: ReadonlySet<string>): string {
  const nodes = weightNodes(graphText)
    .filter(([id, node]) => !(kind === 'reference' && !baseIds.has(id)
      && typeof node.class_type === 'string' && node.class_type.startsWith('LoraLoader')));
  return canonical(Object.fromEntries(nodes));
}

interface ResolvedModel {
  model: LocalModelDef;
  weights: string;
}

function resolveModel(file: ManifestFile, order: number): ResolvedModel {
  const { manifest: m, dir, path, files } = file;
  if (!isRatioMapName(m.ratioMap)) throw new LocalModelCatalogError('unknown ratio map', path);
  if (m.defaultRatio !== undefined && !m.supportedRatios.includes(m.defaultRatio)) {
    throw new LocalModelCatalogError('default ratio is not a supported ratio', path);
  }

  const isVideo = m.outputKind === 'video';
  if (m.family === 'video') {
    if (!isVideo) throw new LocalModelCatalogError('video family requires outputKind video', path);
    if (m.supportedDurations === undefined || m.defaultDuration === undefined) {
      throw new LocalModelCatalogError('video model requires supportedDurations and defaultDuration', path);
    }
  } else {
    if (isVideo) throw new LocalModelCatalogError('image family cannot output video', path);
    if (m.supportedDurations !== undefined || m.defaultDuration !== undefined || m.graphs.extend !== undefined) {
      throw new LocalModelCatalogError('image model declares video fields', path);
    }
    if (classifyImageModelTarget(m.id) !== m.family) {
      throw new LocalModelCatalogError('family disagrees with the model id', path);
    }
  }
  const durations = m.supportedDurations ?? [];
  if (!durations.every(isDuration)) throw new LocalModelCatalogError('duration is off the video frame grid', path);
  const supportedDurations = durations.filter(isDuration);
  const defaultDuration = m.defaultDuration;
  if (defaultDuration !== undefined && !(isDuration(defaultDuration) && supportedDurations.includes(defaultDuration))) {
    throw new LocalModelCatalogError('default duration is not a supported duration', path);
  }

  const required: Record<(typeof GRAPH_NAMES)[number], readonly string[]> = {
    base: m.requiredPlaceholders,
    reference: [...m.requiredPlaceholders, '{{referenceImage}}'],
    extend: m.extendRequiredPlaceholders ?? m.requiredPlaceholders,
  };
  const graphPaths: Partial<Record<(typeof GRAPH_NAMES)[number], string>> = {};
  let baseText = '';
  let baseIds: ReadonlySet<string> = new Set();
  for (const kind of GRAPH_NAMES) {
    const name = m.graphs[kind];
    if (name === undefined) continue;
    const graphPath = join(dir, name);
    if (!files.has(name)) throw new LocalModelCatalogError('graph file is missing or unreadable', graphPath);
    const text = readGraph(graphPath);
    if ([...text.matchAll(PLACEHOLDER_TOKEN)].some(([token]) => !KNOWN_PLACEHOLDERS.has(token))) {
      throw new LocalModelCatalogError('graph contains an unknown placeholder', graphPath);
    }
    if (!required[kind].every((placeholder) => text.includes(placeholder))) {
      throw new LocalModelCatalogError('graph lacks a required placeholder', graphPath);
    }
    if (!Object.hasOwn(JSON.parse(text) as object, m.saveImageNodeId)) {
      throw new LocalModelCatalogError('graph lacks the save node', graphPath);
    }
    graphPaths[kind] = graphPath;
    if (kind === 'base') {
      baseText = text;
      baseIds = new Set(weightNodes(text).map(([id]) => id));
    } else if (graphWeights(text, kind, baseIds) !== graphWeights(baseText, 'base', baseIds)) {
      throw new LocalModelCatalogError('graph weight loaders differ from the base graph', path);
    }
  }
  const workflowPath = graphPaths.base;
  if (workflowPath === undefined) throw new LocalModelCatalogError('manifest names no base graph', path);

  const model: LocalModelDef = {
    id: m.id,
    name: m.name,
    family: m.family,
    order,
    ...(m.residencyKey !== undefined ? { residencyKey: m.residencyKey } : {}),
    saveImageNodeId: m.saveImageNodeId,
    requiredPlaceholders: m.requiredPlaceholders,
    defaultSteps: m.defaultSteps,
    ratioMap: m.ratioMap,
    ratioDims: RATIO_MAPS[m.ratioMap],
    supportedRatios: m.supportedRatios,
    ...(m.defaultRatio !== undefined ? { defaultRatio: m.defaultRatio } : {}),
    ...(m.supportedDurations !== undefined ? { supportedDurations } : {}),
    ...(defaultDuration !== undefined && isDuration(defaultDuration) ? { defaultDuration } : {}),
    size: m.size,
    latency: m.latency,
    batched: m.batched,
    defaultCount: m.defaultCount,
    ...(m.outputKind !== undefined ? { outputKind: m.outputKind } : {}),
    ...(m.promptFormat !== undefined ? { promptFormat: m.promptFormat } : {}),
    workflowPath,
    ...(graphPaths.extend !== undefined ? { extendWorkflowPath: graphPaths.extend } : {}),
    ...(m.extendRequiredPlaceholders !== undefined ? { extendRequiredPlaceholders: m.extendRequiredPlaceholders } : {}),
    ...(graphPaths.reference !== undefined ? { referenceWorkflowPath: graphPaths.reference } : {}),
    ...(m.referenceRequiredModelFiles !== undefined ? { referenceRequiredModelFiles: m.referenceRequiredModelFiles } : {}),
    requiredModelFiles: m.requiredModelFiles,
    ...(m.requiredClipType !== undefined ? { requiredClipType: m.requiredClipType } : {}),
    dir,
    manifestPath: path,
  };
  return { model, weights: weightSignature(baseText, m.requiredModelFiles) };
}

/**
 * Reads the built-in manifests, then the external ones, validates every
 * manifest and graph, and returns the registered rows. Any failure throws a
 * `LocalModelCatalogError` naming the offending file.
 */
export function loadLocalModelCatalog(options: LoadLocalModelCatalogOptions): LocalModelCatalog {
  const logger = options.logger ?? NOOP_LOGGER;
  const enable = new Set(options.enableModels ?? []);

  const merged = new Map<string, { file: ManifestFile; order: number }>();
  for (const file of readManifestDir(options.builtinDir)) {
    if (file.manifest.overrides === true) throw new LocalModelCatalogError('a built-in manifest cannot override', file.path);
    if (merged.has(file.manifest.id)) throw new LocalModelCatalogError('duplicate model id', file.path);
    if (file.manifest.order === undefined) throw new LocalModelCatalogError('manifest has no order', file.path);
    merged.set(file.manifest.id, { file, order: file.manifest.order });
  }
  const externalIds = new Set<string>();
  const overridden: string[] = [];
  for (const file of options.externalDir === undefined ? [] : readManifestDir(options.externalDir)) {
    const { id } = file.manifest;
    if (externalIds.has(id)) throw new LocalModelCatalogError('duplicate model id', file.path);
    externalIds.add(id);
    const builtin = merged.get(id);
    if (builtin !== undefined) {
      if (file.manifest.overrides !== true) {
        throw new LocalModelCatalogError('duplicate model id without "overrides": true', file.path);
      }
      merged.set(id, { file, order: file.manifest.order ?? builtin.order });
      overridden.push(id);
      continue;
    }
    if (file.manifest.overrides === true) throw new LocalModelCatalogError('"overrides" names no built-in model', file.path);
    if (file.manifest.order === undefined) throw new LocalModelCatalogError('manifest has no order', file.path);
    merged.set(id, { file, order: file.manifest.order });
  }

  const orders = new Set<number>();
  const resolved: (ResolvedModel & { enabled: boolean })[] = [];
  for (const { file, order } of merged.values()) {
    if (orders.has(order)) throw new LocalModelCatalogError('duplicate model order', file.path);
    orders.add(order);
    resolved.push({ ...resolveModel(file, order), enabled: file.manifest.enabled ?? true });
  }

  for (const id of overridden) logger.info({ event: 'local_model_override', id }, 'local model override');
  const registered = resolved
    .filter(({ model, enabled }) => {
      if (enabled || options.includeDisabled === true || enable.has(model.id)) return true;
      logger.info({ event: 'local_model_disabled', id: model.id }, 'local model disabled');
      return false;
    })
    .sort((a, b) => a.model.order - b.model.order || (a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0));

  const residencyWeights = new Map<string, string>();
  for (const { model, weights } of registered) {
    const key = model.residencyKey ?? model.id;
    const first = residencyWeights.get(key);
    if (first === undefined) residencyWeights.set(key, weights);
    else if (first !== weights) {
      throw new LocalModelCatalogError('rows sharing a residency key load different weights', model.manifestPath);
    }
  }
  const models = registered.map(({ model }) => model);

  const byId = new Map(models.map((model) => [model.id, model]));
  return {
    models,
    kreaModels: models.filter((model) => model.family === 'krea'),
    byId,
    residencyKey: (modelId) => {
      const model = byId.get(modelId);
      return model?.residencyKey ?? modelId;
    },
  };
}

let builtinCatalog: LocalModelCatalog | undefined;

/** The bundled rows alone, with every enabled built-in registered. */
export function loadBuiltinCatalog(): LocalModelCatalog {
  builtinCatalog ??= loadLocalModelCatalog({ builtinDir: BUILTIN_MODELS_DIR });
  return builtinCatalog;
}

// Memoised per frozen Config, as `registryForConfig` is: the catalog is read
// and validated once per Config, so a bad manifest stops startup.
const catalogCache = new WeakMap<Config, LocalModelCatalog>();

export function catalogForConfig(config: Config): LocalModelCatalog {
  const cached = catalogCache.get(config);
  if (cached) return cached;
  const catalog = loadLocalModelCatalog({
    builtinDir: BUILTIN_MODELS_DIR,
    ...(config.COMFYUI_MODELS_DIR !== undefined ? { externalDir: config.COMFYUI_MODELS_DIR } : {}),
    enableModels: config.COMFYUI_ENABLE_MODELS,
    logger: loggerForConfig(config),
  });
  catalogCache.set(config, catalog);
  return catalog;
}
