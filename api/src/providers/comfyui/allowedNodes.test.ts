import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_MODELS_DIR, loadLocalModelCatalog } from './catalog';

// Every bundled graph, including the disabled templates.
const { models: LOCAL_MODELS } = loadLocalModelCatalog({ builtinDir: BUILTIN_MODELS_DIR, includeDisabled: true });

// The private worker rejects any /prompt node outside
// infra/comfyui/atelier_private/allowed_nodes.json. /object_info is not
// filtered; readiness also checks the advertised submission allowlist.
// Node renames the private transport applies before submit (privacy.ts).
const PRIVATE_CLASS = new Map([
  ['LoadImage', 'AtelierLoadImage'],
  ['LoadVideo', 'AtelierLoadVideo'],
  ['SaveVideo', 'AtelierSaveVideo'],
  ['SaveImageWebsocket', 'AtelierSaveImages'],
]);

const allowed = new Set(JSON.parse(readFileSync(
  join(import.meta.dir, '..', '..', '..', '..', 'infra', 'comfyui', 'atelier_private', 'allowed_nodes.json'),
  'utf8',
)) as string[]);

test.each([...LOCAL_MODELS])('$id graphs use only worker-allowlisted node classes', (model) => {
  const paths = [model.workflowPath, model.referenceWorkflowPath, model.extendWorkflowPath]
    .filter((path): path is string => path !== undefined);
  for (const path of paths) {
    const graph = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { class_type: string }>;
    const missing = Object.values(graph)
      .map((node) => PRIVATE_CLASS.get(node.class_type) ?? node.class_type)
      .filter((cls) => !allowed.has(cls));
    expect(missing, path).toEqual([]);
  }
});
