import { expect, test } from 'bun:test';
import { comfyuiInventory } from './comfyui-inventory';

test('inventory covers configured graph modes, private worker classes and source hashes', () => {
  const inventory = comfyuiInventory();
  expect(inventory.models).toHaveLength(5);
  const graphs = inventory.models.flatMap((model) => model.graphs);
  // Five base graphs, the Krea and MiniMax H3 Image reference graphs, one extend graph.
  expect(graphs).toHaveLength(8);
  const h3Reference = inventory.models.find((model) => model.id === 'minimax-h3-image')?.graphs.find((graph) => graph.kind === 'reference');
  expect(h3Reference?.privateClasses).toContain('AtelierLoadImage');
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
