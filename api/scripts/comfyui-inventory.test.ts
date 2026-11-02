import { expect, test } from 'bun:test';
import { comfyuiInventory } from './comfyui-inventory';

test('inventory covers configured graph modes, private worker classes and source hashes', () => {
  const inventory = comfyuiInventory();
  expect(inventory.models).toHaveLength(4);
  const graphs = inventory.models.flatMap((model) => model.graphs);
  expect(graphs).toHaveLength(6);
  for (const graph of graphs) {
    expect(graph.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(graph.missingWorkerClasses).toEqual([]);
    expect(graph.loaders.length).toBeGreaterThan(0);
    expect(graph.samplerRecipe.length).toBeGreaterThan(0);
  }
  const extend = graphs.find((graph) => graph.kind === 'extend');
  expect(extend?.requiredClasses).toContain('MiniMaxH3AddGuide');
  expect(extend?.privateClasses).toContain('AtelierLoadVideo');
  expect(extend?.privateClasses).toContain('AtelierSaveVideo');
});
