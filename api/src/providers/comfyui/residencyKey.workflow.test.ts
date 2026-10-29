import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_MODELS_DIR, loadLocalModelCatalog, type LocalModelDef } from './catalog';

// Every bundled row, including the disabled H3 templates.
const { models: LOCAL_MODELS, residencyKey: localResidencyKey } = loadLocalModelCatalog({
  builtinDir: BUILTIN_MODELS_DIR,
  includeDisabled: true,
});

// A shared residency key tells comfyui.ts to SKIP the VRAM eviction between two
// rows. That is only safe when both rows load the same weights through the same
// loader nodes, so ComfyUI's node cache serves them without a reload. This test
// pins the production wiring to the workflow JSON: a key shared by rows whose
// weight nodes differ would silently disable an OOM guard.

interface Node {
  class_type: string;
  inputs: Record<string, unknown>;
}

// Any input naming a weight artifact marks a weight-bearing node, whatever its
// class (UNETLoader, CLIPLoader, VAELoader, LoraLoaderModelOnly, …). Matching
// on the artifact rather than a class-name pattern means a future loader class
// cannot slip past the comparison. LoadImage carries the I2V source still, not
// weights, and is expected to differ between the I2V and T2V graphs.
const WEIGHT_ARTIFACT = /\.(safetensors|gguf|ckpt|pt|pth|bin)$/i;

function weightNodes(workflowPath: string): Record<string, Node> {
  const graph = JSON.parse(
    readFileSync(workflowPath, 'utf8'),
  ) as Record<string, Node>;
  return Object.fromEntries(
    Object.entries(graph)
      .filter(([, node]) => Object.values(node.inputs).some(
        (value) => typeof value === 'string' && WEIGHT_ARTIFACT.test(value),
      ))
      .map(([id, node]) => [id, { class_type: node.class_type, inputs: node.inputs }]),
  );
}

const byKey = new Map<string, LocalModelDef[]>();
for (const model of LOCAL_MODELS) {
  const key = localResidencyKey(model.id);
  byKey.set(key, [...(byKey.get(key) ?? []), model]);
}
const sharedGroups = [...byKey.values()].filter((models) => models.length > 1);

describe('residency keys', () => {
  test('reference graphs preserve base weight nodes apart from the ReID LoRA', () => {
    for (const model of LOCAL_MODELS) {
      if (!model.referenceWorkflowPath) continue;
      const referenceNodes = Object.fromEntries(Object.entries(weightNodes(model.referenceWorkflowPath))
        .filter(([, node]) => node.class_type !== 'LoraLoaderModelOnly'));
      expect(referenceNodes).toEqual(weightNodes(model.workflowPath));
    }
  });

  test('both MiniMax H3 rows share one key; every other row keys on its own id', () => {
    expect(localResidencyKey('minimax-h3-i2v')).toBe('minimax-h3');
    expect(localResidencyKey('minimax-h3-t2v')).toBe('minimax-h3');
    for (const model of LOCAL_MODELS) {
      if (!model.id.startsWith('minimax-h3-')) expect(localResidencyKey(model.id)).toBe(model.id);
    }
    expect(localResidencyKey('gpt-image-2.5-sunburst')).toBe('gpt-image-2.5-sunburst');
  });

  test('rows sharing a residency key load identical weight nodes and weight files', () => {
    expect(sharedGroups.length).toBeGreaterThan(0);
    for (const models of sharedGroups) {
      const [reference, ...others] = models;
      if (!reference) throw new Error('empty residency group');
      const referenceNodes = weightNodes(reference.workflowPath);
      expect(Object.keys(referenceNodes).length).toBeGreaterThan(0);
      for (const other of others) {
        expect(weightNodes(other.workflowPath)).toEqual(referenceNodes);
        expect([...other.requiredModelFiles].sort()).toEqual([...reference.requiredModelFiles].sort());
      }
    }
  });

  test('the weight-node comparison discriminates: rows on their own keys load different weights', () => {
    const [a, b] = LOCAL_MODELS.filter((model) => localResidencyKey(model.id) === model.id);
    if (!a || !b) throw new Error('expected at least two rows keyed on their own id');
    expect(weightNodes(a.workflowPath)).not.toEqual(weightNodes(b.workflowPath));
  });

  test('the artifact predicate sees LoRA loaders, not only *Loader classes', () => {
    const nodes = weightNodes(join(BUILTIN_MODELS_DIR, 'krea-2-gonzalomo', 'reference.json'));
    expect(Object.values(nodes).map((node) => node.class_type)).toContain('LoraLoaderModelOnly');
  });
});
