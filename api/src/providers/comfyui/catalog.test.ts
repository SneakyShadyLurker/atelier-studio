import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_MODELS_DIR,
  LocalModelCatalogError,
  loadBuiltinCatalog,
  loadLocalModelCatalog,
  type CatalogLogger,
} from './catalog';
import { RATIO_MAPS } from './ratioMaps';

const FIXTURES = join(import.meta.dir, '..', '..', 'test', 'fixtures', 'models');
const BUILTIN = join(FIXTURES, 'builtin');
const EXTERNAL = join(FIXTURES, 'external');

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true });
});

function copyFixture(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-catalog-'));
  temps.push(dir);
  cpSync(source, dir, { recursive: true });
  return dir;
}

function editManifest(root: string, id: string, edit: (manifest: Record<string, unknown>) => void): string {
  const path = join(root, id, 'model.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(manifest);
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

function recordingLogger(): { logger: CatalogLogger; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  return { logger: { info: (fields) => { events.push(fields); } }, events };
}

function expectFailure(run: () => unknown, path: string): LocalModelCatalogError {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(LocalModelCatalogError);
  const error = caught as LocalModelCatalogError;
  expect(error.filePath).toBe(path);
  expect(error.message).toContain(path);
  return error;
}

describe('loadLocalModelCatalog: built-ins', () => {
  test('loads enabled built-ins sorted by order, ignoring _ directories', () => {
    const { logger, events } = recordingLogger();
    const catalog = loadLocalModelCatalog({ builtinDir: BUILTIN, logger });
    expect(catalog.models.map((model) => model.id)).toEqual(['moss-test-beta', 'krea-test-alpha']);
    expect(catalog.kreaModels.map((model) => model.id)).toEqual(['krea-test-alpha']);
    expect(catalog.byId.get('moss-test-beta')?.name).toBe('MOSS Test Beta');
    expect(events).toEqual([{ event: 'local_model_disabled', id: 'video-test-gamma' }]);
  });

  test('resolves graphs against the manifest directory and the named ratio map', () => {
    const catalog = loadLocalModelCatalog({ builtinDir: BUILTIN });
    const krea = catalog.byId.get('krea-test-alpha');
    expect(krea?.workflowPath).toBe(join(BUILTIN, 'krea-test-alpha', 'workflow.json'));
    expect(krea?.ratioDims).toEqual(RATIO_MAPS['krea-2048']);
    expect(krea).not.toHaveProperty('referenceWorkflowPath');
    expect(krea).not.toHaveProperty('extendWorkflowPath');
  });

  test('a disabled manifest registers when its id is in enableModels', () => {
    const catalog = loadLocalModelCatalog({ builtinDir: BUILTIN, enableModels: ['video-test-gamma'] });
    expect(catalog.models.map((model) => model.id)).toEqual(['moss-test-beta', 'video-test-gamma', 'krea-test-alpha']);
    expect(catalog.residencyKey('video-test-gamma')).toBe('video-test');
    expect(catalog.residencyKey('krea-test-alpha')).toBe('krea-test-alpha');
    expect(catalog.residencyKey('not-a-local-model')).toBe('not-a-local-model');
  });
});

describe('loadLocalModelCatalog: external directory', () => {
  test('adds external rows, applies overrides and keeps the merged order', () => {
    const { logger, events } = recordingLogger();
    const catalog = loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: EXTERNAL, logger });
    expect(catalog.models.map((model) => [model.id, model.order])).toEqual([
      ['moss-test-beta', 10],
      ['krea-test-delta', 15],
      ['video-test-gamma', 20],
      ['krea-test-alpha', 30],
    ]);
    expect(catalog.kreaModels.map((model) => model.id)).toEqual(['krea-test-delta', 'krea-test-alpha']);
    expect(events).toContainEqual({ event: 'local_model_override', id: 'moss-test-beta' });
    expect(events).toContainEqual({ event: 'local_model_override', id: 'video-test-gamma' });
    expect(events.filter((fields) => fields.event === 'local_model_disabled')).toEqual([]);
  });

  test('an override replaces the built-in entirely, graphs included', () => {
    const catalog = loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: EXTERNAL });
    const moss = catalog.byId.get('moss-test-beta');
    expect(moss?.name).toBe('MOSS Test Beta Override');
    expect(moss?.workflowPath).toBe(join(EXTERNAL, 'moss-test-beta', 'workflow.json'));
    expect(moss?.ratioDims).toEqual(RATIO_MAPS['moss-turbo-1.5mp']);
  });

  test('an override of a disabled built-in uses its own enabled flag', () => {
    expect(loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: EXTERNAL }).byId.has('video-test-gamma')).toBe(true);
    const external = copyFixture(EXTERNAL);
    editManifest(external, 'video-test-gamma', (manifest) => { manifest.enabled = false; });
    expect(loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: external }).byId.has('video-test-gamma')).toBe(false);
  });

  test('an override may set its own order', () => {
    const external = copyFixture(EXTERNAL);
    editManifest(external, 'moss-test-beta', (manifest) => { manifest.order = 40; });
    const catalog = loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: external });
    expect(catalog.models.at(-1)?.id).toBe('moss-test-beta');
  });

  test('a duplicate id without overrides stops the load naming the file only', () => {
    const external = copyFixture(EXTERNAL);
    const path = editManifest(external, 'moss-test-beta', (manifest) => { delete manifest.overrides; });
    const error = expectFailure(() => loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: external }), path);
    expect(error.message).not.toContain('MOSS Test Beta Override');
  });

  test('overrides on an id with no built-in stops the load', () => {
    const external = copyFixture(EXTERNAL);
    const path = editManifest(external, 'krea-test-delta', (manifest) => { manifest.overrides = true; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: external }), path);
  });

  test('a duplicate order stops the load', () => {
    const external = copyFixture(EXTERNAL);
    const path = editManifest(external, 'krea-test-delta', (manifest) => { manifest.order = 30; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: external }), path);
  });
});

describe('loadLocalModelCatalog: validation', () => {
  test('a manifest that is not JSON fails without echoing its contents', () => {
    const builtin = copyFixture(BUILTIN);
    const path = join(builtin, 'krea-test-alpha', 'model.json');
    writeFileSync(path, '{ "secret-looking-content": ');
    const error = expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), path);
    expect(error.message).not.toContain('secret-looking-content');
  });

  test('a manifest that fails the schema fails naming the file', () => {
    const builtin = copyFixture(BUILTIN);
    const path = editManifest(builtin, 'krea-test-alpha', (manifest) => { manifest.latency = 'instant'; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), path);
  });

  test('a built-in without an order fails', () => {
    const builtin = copyFixture(BUILTIN);
    const path = editManifest(builtin, 'krea-test-alpha', (manifest) => { delete manifest.order; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), path);
  });

  test('a directory whose name differs from the manifest id fails', () => {
    const builtin = copyFixture(BUILTIN);
    const path = editManifest(builtin, 'krea-test-alpha', (manifest) => { manifest.id = 'krea-test-omega'; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), path);
  });

  test('a missing graph fails naming the graph path', () => {
    const builtin = copyFixture(BUILTIN);
    editManifest(builtin, 'krea-test-alpha', (manifest) => { manifest.graphs = { base: 'workflow.json', reference: 'reference.json' }; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), join(builtin, 'krea-test-alpha', 'reference.json'));
  });

  test('a graph that is not a JSON node map fails', () => {
    const builtin = copyFixture(BUILTIN);
    const path = join(builtin, 'krea-test-alpha', 'workflow.json');
    writeFileSync(path, '[1, 2, 3]');
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), path);
  });

  test('a graph missing a required placeholder fails', () => {
    const builtin = copyFixture(BUILTIN);
    const path = join(builtin, 'krea-test-alpha', 'workflow.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"{{seed}}"', '42'));
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), path);
  });

  test('a graph without the save node fails', () => {
    const builtin = copyFixture(BUILTIN);
    const path = editManifest(builtin, 'krea-test-alpha', (manifest) => { manifest.saveImageNodeId = '99'; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), join(builtin, 'krea-test-alpha', 'workflow.json'));
    expect(path).toEndWith('model.json');
  });

  test('an unknown ratio map fails', () => {
    const builtin = copyFixture(BUILTIN);
    const path = editManifest(builtin, 'krea-test-alpha', (manifest) => { manifest.ratioMap = 'krea-4096'; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), path);
  });

  test('a default ratio outside the supported ratios fails', () => {
    const builtin = copyFixture(BUILTIN);
    const path = editManifest(builtin, 'krea-test-alpha', (manifest) => { manifest.supportedRatios = ['1:1']; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), path);
  });

  test('an image family that disagrees with the id fails', () => {
    const builtin = copyFixture(BUILTIN);
    const path = editManifest(builtin, 'krea-test-alpha', (manifest) => {
      manifest.family = 'moss';
    });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), path);
  });

  test('an image manifest with video fields fails', () => {
    const builtin = copyFixture(BUILTIN);
    const path = editManifest(builtin, 'krea-test-alpha', (manifest) => { manifest.supportedDurations = [124]; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), path);
  });

  test('an off-grid duration fails, even on a disabled manifest', () => {
    const builtin = copyFixture(BUILTIN);
    const path = editManifest(builtin, 'video-test-gamma', (manifest) => { manifest.supportedDurations = [124, 240]; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), path);
  });

  test('a default duration outside the supported durations fails', () => {
    const builtin = copyFixture(BUILTIN);
    const path = editManifest(builtin, 'video-test-gamma', (manifest) => { manifest.defaultDuration = 362; manifest.supportedDurations = [124]; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), path);
  });

  test('a video manifest must declare video output and its durations', () => {
    const notVideo = copyFixture(BUILTIN);
    const notVideoPath = editManifest(notVideo, 'video-test-gamma', (manifest) => { delete manifest.outputKind; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: notVideo }), notVideoPath);

    const noDurations = copyFixture(BUILTIN);
    const noDurationsPath = editManifest(noDurations, 'video-test-gamma', (manifest) => {
      delete manifest.supportedDurations;
      delete manifest.defaultDuration;
    });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: noDurations }), noDurationsPath);
  });

  test('an image family cannot declare video output', () => {
    const builtin = copyFixture(BUILTIN);
    const path = editManifest(builtin, 'krea-test-alpha', (manifest) => { manifest.outputKind = 'video'; });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), path);
  });
});

describe('loadLocalModelCatalog: links and unknown placeholders', () => {
  test('a symlinked model directory stops the load', () => {
    const external = copyFixture(EXTERNAL);
    const outside = copyFixture(EXTERNAL);
    const link = join(external, 'krea-test-linked');
    symlinkSync(join(outside, 'krea-test-delta'), link);
    expectFailure(() => loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: external }), link);
  });

  test('a symlinked built-in model directory stops the load', () => {
    const builtin = copyFixture(BUILTIN);
    const outside = copyFixture(BUILTIN);
    const link = join(builtin, 'krea-test-alpha');
    rmSync(link, { recursive: true });
    symlinkSync(join(outside, 'krea-test-alpha'), link);
    expectFailure(() => loadLocalModelCatalog({ builtinDir: builtin }), link);
  });

  test('a symlinked manifest stops the load', () => {
    const external = copyFixture(EXTERNAL);
    const outside = copyFixture(EXTERNAL);
    const manifest = join(external, 'krea-test-delta', 'model.json');
    rmSync(manifest);
    symlinkSync(join(outside, 'krea-test-delta', 'model.json'), manifest);
    expectFailure(() => loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: external }), manifest);
  });

  test('a symlinked graph pointing outside the root stops the load', () => {
    const external = copyFixture(EXTERNAL);
    const outside = copyFixture(EXTERNAL);
    const graph = join(external, 'krea-test-delta', 'workflow.json');
    renameSync(graph, join(outside, 'stolen.json'));
    symlinkSync(join(outside, 'stolen.json'), graph);
    expectFailure(() => loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: external }), graph);
  });

  test('a graph with an unknown placeholder stops the load without echoing it', () => {
    const external = copyFixture(EXTERNAL);
    const graph = join(external, 'krea-test-delta', 'workflow.json');
    writeFileSync(graph, readFileSync(graph, 'utf8').replace('"{{prompt}}"', '"{{prompt}} {{typo}}"'));
    const error = expectFailure(() => loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: external }), graph);
    expect(error.message).not.toContain('typo');
  });
});

// The bundled H3 rows are disabled templates; these cases register them with
// the external copy so the residency group has more than one member.
const ENABLE_H3 = ['minimax-h3-i2v', 'minimax-h3-t2v', 'minimax-h3-x2v'];

describe('loadLocalModelCatalog: residency groups', () => {
  test('a row sharing a residency key with different weight nodes stops the load', () => {
    const external = mkdtempSync(join(tmpdir(), 'atelier-catalog-'));
    temps.push(external);
    const dir = join(external, 'minimax-h3-x2v');
    cpSync(join(BUILTIN_MODELS_DIR, 'minimax-h3-t2v'), dir, { recursive: true });
    const manifestPath = editManifest(external, 'minimax-h3-x2v', (manifest) => {
      manifest.id = 'minimax-h3-x2v';
      manifest.order = 120;
      manifest.requiredModelFiles = (manifest.requiredModelFiles as string[]).map((file, index) => (index === 0 ? 'other-unet.safetensors' : file));
    });
    const graph = join(dir, 'workflow.json');
    const original = (JSON.parse(readFileSync(join(BUILTIN_MODELS_DIR, 'minimax-h3-t2v', 'model.json'), 'utf8')) as { requiredModelFiles: string[] }).requiredModelFiles[0];
    if (original === undefined) throw new Error('fixture has no weight file');
    writeFileSync(graph, readFileSync(graph, 'utf8').replace(original, 'other-unet.safetensors'));
    expectFailure(() => loadLocalModelCatalog({ builtinDir: BUILTIN_MODELS_DIR, externalDir: external, enableModels: ENABLE_H3 }), manifestPath);
  });

  test('an extend graph whose weight loaders differ from its base graph stops the load', () => {
    const external = mkdtempSync(join(tmpdir(), 'atelier-catalog-'));
    temps.push(external);
    const dir = join(external, 'minimax-h3-x2v');
    cpSync(join(BUILTIN_MODELS_DIR, 'minimax-h3-i2v'), dir, { recursive: true });
    const manifestPath = editManifest(external, 'minimax-h3-x2v', (manifest) => {
      manifest.id = 'minimax-h3-x2v';
      manifest.order = 120;
    });
    const extendPath = join(dir, 'extend.json');
    const extend = JSON.parse(readFileSync(extendPath, 'utf8')) as Record<string, { inputs: Record<string, unknown> }>;
    const unet = extend['1'];
    if (unet === undefined) throw new Error('extend graph has no node 1');
    unet.inputs.weight_dtype = 'fp8_e4m3fn';
    writeFileSync(extendPath, JSON.stringify(extend));
    expectFailure(() => loadLocalModelCatalog({ builtinDir: BUILTIN_MODELS_DIR, externalDir: external, enableModels: ENABLE_H3 }), manifestPath);
  });

  test('a reference graph that only adds a LoRA loader loads', () => {
    const external = copyFixture(EXTERNAL);
    const dir = join(external, 'krea-test-delta');
    const graph = JSON.parse(readFileSync(join(dir, 'workflow.json'), 'utf8')) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    graph['20'] = { class_type: 'LoadImage', inputs: { image: '{{referenceImage}}' } };
    graph['21'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'test-lora.safetensors', strength_model: 1.0 } };
    writeFileSync(join(dir, 'reference.json'), JSON.stringify(graph));
    editManifest(external, 'krea-test-delta', (manifest) => {
      manifest.graphs = { base: 'workflow.json', reference: 'reference.json' };
      manifest.referenceRequiredModelFiles = ['test-lora.safetensors'];
    });
    const catalog = loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: external });
    expect(catalog.byId.get('krea-test-delta')?.referenceWorkflowPath).toBe(join(dir, 'reference.json'));
  });

  test('a reference graph whose base weight loaders differ stops the load', () => {
    const external = copyFixture(EXTERNAL);
    const dir = join(external, 'krea-test-delta');
    const text = readFileSync(join(dir, 'workflow.json'), 'utf8')
      .replace('"{{prompt}}"', '"{{prompt}} {{referenceImage}}"')
      .replace('test-vae.safetensors', 'other-vae.safetensors');
    writeFileSync(join(dir, 'reference.json'), text);
    const manifestPath = editManifest(external, 'krea-test-delta', (manifest) => {
      manifest.graphs = { base: 'workflow.json', reference: 'reference.json' };
    });
    expectFailure(() => loadLocalModelCatalog({ builtinDir: BUILTIN, externalDir: external }), manifestPath);
  });

  test('a row sharing a residency key with identical weights loads', () => {
    const external = mkdtempSync(join(tmpdir(), 'atelier-catalog-'));
    temps.push(external);
    cpSync(join(BUILTIN_MODELS_DIR, 'minimax-h3-t2v'), join(external, 'minimax-h3-x2v'), { recursive: true });
    editManifest(external, 'minimax-h3-x2v', (manifest) => {
      manifest.id = 'minimax-h3-x2v';
      manifest.order = 120;
    });
    const catalog = loadLocalModelCatalog({ builtinDir: BUILTIN_MODELS_DIR, externalDir: external, enableModels: ENABLE_H3 });
    expect(catalog.residencyKey('minimax-h3-x2v')).toBe('minimax-h3');
  });
});

describe('built-in catalog', () => {
  test('registers the enabled bundled rows in order and leaves the H3 templates disabled', () => {
    const catalog = loadBuiltinCatalog();
    expect(catalog.models.map((model) => model.id)).toEqual(['krea-2-gonzalomo', 'moss-image-sft']);
    expect(catalog.models.map((model) => model.order)).toEqual([10, 70]);
    expect(catalog.kreaModels.map((model) => model.id)).toEqual(['krea-2-gonzalomo']);
    expect(catalog.byId.has('minimax-h3-i2v')).toBe(false);
    expect(catalog.models.every((model) => model.workflowPath.startsWith(BUILTIN_MODELS_DIR))).toBe(true);
  });

  test('COMFYUI_ENABLE_MODELS registers the H3 templates on one residency key', () => {
    const catalog = loadLocalModelCatalog({ builtinDir: BUILTIN_MODELS_DIR, enableModels: ['minimax-h3-i2v', 'minimax-h3-t2v'] });
    expect(catalog.models.map((model) => model.id)).toEqual(['krea-2-gonzalomo', 'moss-image-sft', 'minimax-h3-i2v', 'minimax-h3-t2v']);
    expect(catalog.models.map((model) => model.order)).toEqual([10, 70, 100, 110]);
    expect(catalog.residencyKey('minimax-h3-i2v')).toBe('minimax-h3');
    expect(catalog.residencyKey('minimax-h3-t2v')).toBe('minimax-h3');
  });
});
