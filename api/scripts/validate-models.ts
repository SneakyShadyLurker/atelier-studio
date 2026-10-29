import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LocalModelCatalogError, loadLocalModelCatalog, type LocalModelDef } from '../src/providers/comfyui/catalog';
import { submissionNodeClass } from '../src/providers/comfyui/privacy';

// Usage: bun run api/scripts/validate-models.ts <dir> [--builtin <dir>]
//
// Without --builtin, <dir> is read as a built-in model directory. With it,
// <dir> is an external directory merged over the built-ins, as at startup.
// Runs the startup catalog checks over every manifest (disabled ones too),
// then the per-family recipe invariants and the worker node allowlist.
// Exit 0 clean, 1 on failure (file paths and reasons only), 2 on usage error.

interface Node {
  class_type: string;
  inputs: Record<string, unknown>;
}
type Graph = Record<string, Node>;

const ALLOWED_NODES_PATH = join(import.meta.dir, '..', '..', 'infra', 'comfyui', 'atelier_private', 'allowed_nodes.json');
const STEP_CACHE = /EasyCache|LazyCache/;

function linkedNode(graph: Graph, value: unknown): Node | undefined {
  if (!Array.isArray(value) || typeof value[0] !== 'string') return undefined;
  return graph[value[0]];
}

function nodesOf(graph: Graph, classType: string): Node[] {
  return Object.values(graph).filter((node) => node.class_type === classType);
}

// The base sampler is the KSampler whose steps come from `{{steps}}`; hires
// passes keep a literal step count.
function baseSampler(graph: Graph): Node | undefined {
  return nodesOf(graph, 'KSampler').find((node) => node.inputs.steps === '{{steps}}');
}

function checkKrea(graph: Graph, kind: string, model: LocalModelDef, fail: (reason: string) => void): void {
  if (model.requiredClipType !== 'krea2') fail('krea rows require requiredClipType krea2');
  const samplers = nodesOf(graph, 'KSampler');
  if (samplers.some((node) => node.inputs.sampler_name !== 'euler')) fail('krea graphs sample with euler');
  const sampler = baseSampler(graph);
  if (sampler === undefined) { fail('graph has no {{steps}} KSampler'); return; }
  const cfg = sampler.inputs.cfg;
  if (typeof cfg !== 'number') { fail('base sampler has no numeric cfg'); return; }
  const negative = linkedNode(graph, sampler.inputs.negative);
  if (kind === 'reference') {
    const encoder = negative?.class_type === 'FluxKontextMultiReferenceLatentMethod'
      ? linkedNode(graph, negative.inputs.conditioning)
      : negative;
    if (encoder?.class_type !== 'TextEncodeKrea2OstrisEdit' || encoder.inputs.prompt !== '') {
      fail('reference graph negative must be an empty-prompt TextEncodeKrea2OstrisEdit');
    }
    return;
  }
  if (cfg === 1) {
    if (negative?.class_type !== 'ConditioningZeroOut') fail('cfg 1.0 requires a ConditioningZeroOut negative');
  } else if (negative?.class_type !== 'CLIPTextEncode' || negative.inputs.text !== '') {
    fail('cfg above 1.0 requires a real empty CLIPTextEncode negative');
  }
}

function checkMoss(graph: Graph, model: LocalModelDef, fail: (reason: string) => void): void {
  if (model.requiredClipType !== 'moss_image') fail('moss rows require requiredClipType moss_image');
  const samplers = nodesOf(graph, 'KSampler');
  if (new Set(samplers.map((node) => node.inputs.sampler_name)).size > 1) fail('every KSampler in a graph shares one sampler');
  const sampler = baseSampler(graph);
  if (sampler === undefined) { fail('graph has no {{steps}} KSampler'); return; }
  const cfg = sampler.inputs.cfg;
  if (typeof cfg !== 'number') { fail('base sampler has no numeric cfg'); return; }
  const negative = linkedNode(graph, sampler.inputs.negative);
  const slg = nodesOf(graph, 'SkipLayerGuidanceDiTSimple');
  if (cfg === 1) {
    if (negative?.class_type !== 'ConditioningZeroOut') fail('cfg 1.0 requires a ConditioningZeroOut negative');
    if (slg.length > 0) fail('skip-layer guidance is inert at cfg 1.0');
  } else if (negative?.class_type !== 'CLIPTextEncode') {
    fail('cfg above 1.0 requires a real CLIPTextEncode negative');
  }
  if (slg.length > 0) {
    if (sampler.inputs.sampler_name !== 'er_sde') fail('skip-layer guidance graphs sample with er_sde');
    if (slg.some((node) => node.inputs.single_layers !== '22')) fail('skip-layer guidance targets single block 22');
  }
}

function checkVideo(graph: Graph, kind: string, model: LocalModelDef, fail: (reason: string) => void): void {
  if (model.requiredClipType !== 'minimax') fail('video rows require requiredClipType minimax');
  if (Object.values(graph).some((node) => STEP_CACHE.test(node.class_type))) fail('video graphs carry no step-reuse cache');
  if (nodesOf(graph, 'BasicGuider').length !== 1 || nodesOf(graph, 'CFGGuider').length > 0 || nodesOf(graph, 'KSampler').length > 0) {
    fail('video graphs run one guidance-free BasicGuider');
  }
  const shifts = nodesOf(graph, 'MiniMaxH3SigmaShift');
  if (shifts.length !== 1 || shifts[0]?.inputs.shift_video !== 12 || shifts[0].inputs.shift_audio !== 7) {
    fail('video graphs carry one MiniMaxH3SigmaShift at video 12 / audio 7');
  }
  const schedulers = nodesOf(graph, 'BasicScheduler');
  if (schedulers.length !== 1 || linkedNode(graph, schedulers[0]?.inputs.model)?.class_type !== 'MiniMaxH3SigmaShift') {
    fail('BasicScheduler consumes the sigma-shifted model');
  }
  if (kind === 'extend' && nodesOf(graph, 'MiniMaxH3AddGuide').length === 0) fail('extend graphs anchor through MiniMaxH3AddGuide');
}

export function validateModels(options: { dir: string; builtinDir?: string }): string[] {
  let models: readonly LocalModelDef[];
  try {
    models = loadLocalModelCatalog({
      builtinDir: options.builtinDir ?? options.dir,
      ...(options.builtinDir !== undefined ? { externalDir: options.dir } : {}),
      includeDisabled: true,
    }).models;
  } catch (err) {
    if (err instanceof LocalModelCatalogError) return [err.message];
    throw err;
  }
  const allowed = new Set(JSON.parse(readFileSync(ALLOWED_NODES_PATH, 'utf8')) as string[]);
  const failures: string[] = [];
  for (const model of models) {
    const graphs = [
      ['base', model.workflowPath],
      ['reference', model.referenceWorkflowPath],
      ['extend', model.extendWorkflowPath],
    ] as const;
    for (const [kind, path] of graphs) {
      if (path === undefined) continue;
      const fail = (reason: string): void => { failures.push(`${path}: ${reason}`); };
      const text = readFileSync(path, 'utf8');
      const graph = JSON.parse(text) as Graph;
      const isImage = model.outputKind !== 'video';
      const missing = [...new Set(Object.values(graph).map((node) => submissionNodeClass(node.class_type, isImage)))]
        .filter((name) => !allowed.has(name));
      if (missing.length > 0) fail(`node classes outside the worker allowlist: ${missing.sort().join(', ')}`);
      const saveClass = graph[model.saveImageNodeId]?.class_type;
      if (saveClass !== (isImage ? 'SaveImageWebsocket' : 'SaveVideo')) fail('save node has the wrong class');
      const files = kind === 'reference'
        ? [...model.requiredModelFiles, ...(model.referenceRequiredModelFiles ?? [])]
        : model.requiredModelFiles;
      if (!files.every((file) => text.includes(file))) fail('graph does not load every required model file');
      if (model.requiredClipType !== undefined
        && !nodesOf(graph, 'CLIPLoader').every((node) => node.inputs.type === model.requiredClipType)) {
        fail('CLIPLoader type differs from requiredClipType');
      }
      if (model.family === 'krea') checkKrea(graph, kind, model, fail);
      else if (model.family === 'moss') checkMoss(graph, model, fail);
      else checkVideo(graph, kind, model, fail);
    }
  }
  return failures;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function main(argv: readonly string[]): number {
  const usage = 'usage: validate-models.ts <dir> [--builtin <dir>]';
  let dir: string | undefined;
  let builtinDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--builtin') {
      builtinDir = argv[index + 1];
      index += 1;
      if (builtinDir === undefined) return usageError(usage);
    } else if (arg === undefined || arg.startsWith('-') || dir !== undefined) {
      return usageError(usage);
    } else {
      dir = arg;
    }
  }
  if (dir === undefined || !isDirectory(dir) || (builtinDir !== undefined && !isDirectory(builtinDir))) {
    return usageError(usage);
  }
  const failures = validateModels({ dir, ...(builtinDir !== undefined ? { builtinDir } : {}) });
  for (const failure of failures) console.error(failure);
  if (failures.length > 0) return 1;
  console.log('validate-models: ok');
  return 0;
}

function usageError(usage: string): number {
  console.error(usage);
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
