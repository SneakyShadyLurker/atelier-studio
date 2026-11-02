import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BUILTIN_MODELS_DIR, loadLocalModelCatalog } from '../src/providers/comfyui/catalog';
import { submissionNodeClass } from '../src/providers/comfyui/privacy';

interface GraphNode { class_type: string; inputs: Record<string, unknown> }

// Source inventory only. Never resolve environment configuration, contact a
// host, open DATA_DIR, or infer deployed weight availability/provenance.
export function comfyuiInventory() {
  const repoRoot = join(import.meta.dir, '..', '..');
  const allowedPath = join(import.meta.dir, '..', '..', 'infra', 'comfyui', 'atelier_private', 'allowed_nodes.json');
  const allowed = new Set(JSON.parse(readFileSync(allowedPath, 'utf8')) as string[]);
  return {
    scope: 'declared repository configuration; not live host inventory or weight provenance',
    // Every bundled manifest, including disabled templates.
    models: loadLocalModelCatalog({ builtinDir: BUILTIN_MODELS_DIR, includeDisabled: true }).models.map((model) => ({
      id: model.id,
      name: model.name,
      outputKind: model.outputKind ?? 'image',
      precisionLabel: model.size,
      residencyKey: model.residencyKey ?? model.id,
      declaredAssets: [...new Set([...model.requiredModelFiles, ...(model.referenceRequiredModelFiles ?? [])])].sort(),
      ratios: model.ratioDims,
      supportedDurations: model.supportedDurations ?? [],
      graphs: ([['base', model.workflowPath], ['reference', model.referenceWorkflowPath], ['extend', model.extendWorkflowPath]] as const)
        .flatMap(([kind, path]) => {
          if (path === undefined) return [];
          const bytes = readFileSync(path);
          const graph = JSON.parse(bytes.toString('utf8')) as Record<string, GraphNode>;
          const nodes = Object.entries(graph);
          const classes = [...new Set(nodes.map(([, node]) => node.class_type))].sort();
          const privateClasses = [...new Set(classes.map((name) => submissionNodeClass(name, (model.outputKind ?? 'image') === 'image')))].sort();
          return [{
            kind, path: relative(repoRoot, path),
            sha256: createHash('sha256').update(bytes).digest('hex'),
            requiredClasses: classes,
            privateClasses,
            missingWorkerClasses: privateClasses.filter((name) => !allowed.has(name)),
            loaders: nodes.filter(([, node]) => node.class_type.includes('Loader'))
              .map(([id, node]) => ({ id, classType: node.class_type, inputs: node.inputs })),
            samplerRecipe: nodes.filter(([, node]) => /Sampler|Scheduler|Guider|SigmaShift|AttentionBackend/.test(node.class_type))
              .map(([id, node]) => ({ id, classType: node.class_type, inputs: node.inputs })),
          }];
        }),
    })),
  };
}

if (import.meta.main) console.log(JSON.stringify(comfyuiInventory(), null, 2));
