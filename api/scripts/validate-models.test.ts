import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_MODELS_DIR } from '../src/providers/comfyui/catalog';

const SCRIPT = join(import.meta.dir, 'validate-models.ts');
const FIXTURES = join(import.meta.dir, '..', 'src', 'test', 'fixtures', 'models');

function run(...args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true });
});

function copyFixture(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-validate-'));
  temps.push(dir);
  cpSync(source, dir, { recursive: true });
  return dir;
}

describe('validate-models', () => {
  test('the bundled model directory passes', () => {
    const result = run(BUILTIN_MODELS_DIR);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

  test('synthetic fixtures pass alone and as an external directory', () => {
    expect(run(join(FIXTURES, 'builtin')).code).toBe(0);
    expect(run(join(FIXTURES, 'external'), '--builtin', join(FIXTURES, 'builtin')).code).toBe(0);
  });

  test('usage errors exit 2', () => {
    expect(run().code).toBe(2);
    expect(run('--builtin').code).toBe(2);
    expect(run(join(FIXTURES, 'builtin'), join(FIXTURES, 'external')).code).toBe(2);
    expect(run(join(FIXTURES, 'does-not-exist')).code).toBe(2);
  });

  test('a recipe violation exits 1 naming the graph', () => {
    const dir = copyFixture(join(FIXTURES, 'builtin'));
    const graphPath = join(dir, 'krea-test-alpha', 'workflow.json');
    writeFileSync(graphPath, readFileSync(graphPath, 'utf8').replace('"cfg": 1.0', '"cfg": 2.0').replace('"cfg": 1', '"cfg": 2'));
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(graphPath);
  });

  test('a krea graph accepts er_sde and rejects other samplers', () => {
    const dir = copyFixture(join(FIXTURES, 'builtin'));
    const graphPath = join(dir, 'krea-test-alpha', 'workflow.json');
    const original = readFileSync(graphPath, 'utf8');
    expect(original).toContain('"sampler_name": "euler"');
    writeFileSync(graphPath, original.replace('"sampler_name": "euler"', '"sampler_name": "er_sde"'));
    expect(run(dir)).toMatchObject({ code: 0, stderr: '' });
    writeFileSync(graphPath, original.replace('"sampler_name": "euler"', '"sampler_name": "dpmpp_2m"'));
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${graphPath}: krea graphs sample with euler or er_sde`);
  });

  test('a node class outside the worker allowlist exits 1', () => {
    const dir = copyFixture(join(FIXTURES, 'builtin'));
    const graphPath = join(dir, 'moss-test-beta', 'workflow.json');
    const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as Record<string, unknown>;
    graph['99'] = { class_type: 'NotARealNode', inputs: {} };
    writeFileSync(graphPath, JSON.stringify(graph));
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(graphPath);
  });

  test('a disabled manifest is still validated', () => {
    const dir = copyFixture(join(FIXTURES, 'builtin'));
    const graphPath = join(dir, 'video-test-gamma', 'workflow.json');
    writeFileSync(graphPath, readFileSync(graphPath, 'utf8').replace('"shift_video": 12.0', '"shift_video": 9.0').replace('"shift_video": 12', '"shift_video": 9'));
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(graphPath);
  });

  describe('moss recipe', () => {
    type MossGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    // The fixture's single KSampler pass rebuilt as one SamplerCustom on
    // SamplerER_SDE and a BasicScheduler, with a real negative and skip-layer
    // guidance on the model.
    function samplerCustomGraph(graph: MossGraph): void {
      graph['5'] = { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } };
      graph['10'] = { class_type: 'SkipLayerGuidanceDiTSimple', inputs: { model: ['1', 0], double_layers: '', single_layers: '22, 24', start_percent: 0, end_percent: 1 } };
      graph['11'] = { class_type: 'SamplerER_SDE', inputs: { solver_type: 'ER-SDE', max_stage: 3, eta: 1, s_noise: 1.1 } };
      graph['12'] = { class_type: 'BasicScheduler', inputs: { model: ['10', 0], scheduler: 'simple', steps: '{{steps}}', denoise: 1 } };
      graph['7'] = {
        class_type: 'SamplerCustom',
        inputs: { model: ['10', 0], add_noise: true, noise_seed: '{{seed}}', cfg: 3, positive: ['4', 0], negative: ['5', 0], sampler: ['11', 0], sigmas: ['12', 0], latent_image: ['6', 0] },
      };
    }
    function mossRun(mutate: (graph: MossGraph) => void): { result: ReturnType<typeof run>; graphPath: string } {
      const dir = copyFixture(join(FIXTURES, 'builtin'));
      const graphPath = join(dir, 'moss-test-beta', 'workflow.json');
      const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as MossGraph;
      mutate(graph);
      writeFileSync(graphPath, JSON.stringify(graph));
      return { result: run(dir), graphPath };
    }
    function node(graph: MossGraph, id: string): MossGraph[string] {
      const found = graph[id];
      if (found === undefined) throw new Error(`moss graph has no node ${id}`);
      return found;
    }

    test('a SamplerCustom base pass on SamplerER_SDE passes', () => {
      expect(mossRun(samplerCustomGraph).result).toMatchObject({ code: 0, stderr: '' });
    });

    test('a KSampler base pass with skip-layer guidance on 22, 24 passes', () => {
      const { result } = mossRun((graph) => {
        graph['5'] = { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } };
        graph['10'] = { class_type: 'SkipLayerGuidanceDiTSimple', inputs: { model: ['1', 0], double_layers: '', single_layers: '22, 24', start_percent: 0, end_percent: 1 } };
        Object.assign(node(graph, '7').inputs, { model: ['10', 0], cfg: 3, sampler_name: 'er_sde' });
      });
      expect(result).toMatchObject({ code: 0, stderr: '' });
    });

    const cases: [string, (graph: MossGraph) => void, string][] = [
      ['a missing SamplerER_SDE', (graph) => {
        graph['11'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'er_sde' } };
      }, 'SamplerCustom samples with SamplerER_SDE on ER-SDE at s_noise 1.0 to 1.1'],
      ['s_noise 1.2', (graph) => { node(graph, '11').inputs.s_noise = 1.2; },
        'SamplerCustom samples with SamplerER_SDE on ER-SDE at s_noise 1.0 to 1.1'],
      ['a BasicScheduler without {{steps}}', (graph) => {
        node(graph, '12').inputs.steps = 20;
        node(graph, '11').inputs.parked = '{{steps}}';
      }, 'graph has no {{steps}} KSampler or SamplerCustom base sampler'],
      ['a scheduler other than simple', (graph) => { node(graph, '12').inputs.scheduler = 'beta'; },
        "SamplerCustom sigmas come from a BasicScheduler on simple at denoise 1.0 on the sampler's model"],
      ['single_layers 24', (graph) => { node(graph, '10').inputs.single_layers = '24'; },
        'skip-layer guidance targets single blocks 22 or 22, 24'],
      ['two base samplers', (graph) => {
        graph['13'] = {
          class_type: 'KSampler',
          inputs: { model: ['10', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed: '{{seed}}', steps: '{{steps}}', cfg: 3, sampler_name: 'er_sde', scheduler: 'simple', denoise: 1 },
        };
      }, 'graph has more than one base sampler'],
    ];

    test.each(cases)('a SamplerCustom graph with %s exits 1', (_label, mutate, reason) => {
      const { result, graphPath } = mossRun((graph) => { samplerCustomGraph(graph); mutate(graph); });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: ${reason}`);
    });
  });

  describe('h3image recipe', () => {
    type H3Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    function h3Violation(
      mutate: (graph: H3Graph, sampler: H3Graph[string]) => void,
      file = 'workflow.json',
    ): { result: ReturnType<typeof run>; graphPath: string } {
      const dir = copyFixture(BUILTIN_MODELS_DIR);
      const graphPath = join(dir, 'minimax-h3-image', file);
      const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as H3Graph;
      const sampler = graph['7'];
      if (sampler === undefined) throw new Error('minimax-h3-image graph has no node 7');
      mutate(graph, sampler);
      writeFileSync(graphPath, JSON.stringify(graph));
      return { result: run(dir), graphPath };
    }

    test('a batched latent exits 1 naming the batch-1 limit', () => {
      const { result, graphPath } = h3Violation((graph, sampler) => {
        graph['11'] = { class_type: 'RepeatLatentBatch', inputs: { samples: ['4', 1], amount: 1 } };
        sampler.inputs.latent_image = ['11', 0];
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: h3image graphs render one image: MiniMax H3 supports batch size 1 only`);
    });

    test('a {{count}} placeholder exits 1', () => {
      const { result, graphPath } = h3Violation((graph) => {
        graph['11'] = { class_type: 'RepeatLatentBatch', inputs: { samples: ['4', 1], amount: '{{count}}' } };
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: h3image graphs render one image`);
    });

    test('a CLIPTextEncode exits 1', () => {
      const { result, graphPath } = h3Violation((graph) => {
        graph['5'] = { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: '' } };
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: h3image graphs encode through MiniMaxH3ImageConditioning, not CLIPTextEncode`);
    });

    const LCM = 'h3image graphs sample with SamplerLCM at s_noise 1.1 to 0.9 without noise clipping';
    const node = (graph: H3Graph, classType: string): H3Graph[string] => {
      const found = Object.values(graph).find((candidate) => candidate.class_type === classType);
      if (found === undefined) throw new Error(`minimax-h3-image graph has no ${classType}`);
      return found;
    };

    test.each(['workflow.json', 'reference.json'])('a KSampler in %s exits 1', (file) => {
      const { result, graphPath } = h3Violation((graph) => {
        graph['11'] = {
          class_type: 'KSampler',
          inputs: { model: ['10', 0], positive: ['4', 0], negative: ['4', 0], latent_image: ['4', 1], seed: '{{seed}}', steps: '{{steps}}', cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 },
        };
      }, file);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: h3image graphs run exactly one SamplerCustomAdvanced and no KSampler`);
    });

    test('an ODE sampler in place of SamplerLCM exits 1', () => {
      const { result, graphPath } = h3Violation((graph) => {
        const lcm = node(graph, 'SamplerLCM');
        lcm.class_type = 'KSamplerSelect';
        lcm.inputs = { sampler_name: 'euler' };
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: ${LCM}`);
    });

    test('a noise ramp off 1.1 to 0.9 or clipped noise exits 1', () => {
      for (const [input, value] of [['s_noise', 1], ['s_noise_end', 1.1], ['noise_clip_std', 2]] as const) {
        const { result, graphPath } = h3Violation((graph) => { node(graph, 'SamplerLCM').inputs[input] = value; });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`${graphPath}: ${LCM}`);
      }
    });

    const SIGMAS = 'h3image sigmas come from one BasicScheduler on simple at {{steps}} and denoise 1.0';

    test('sigmas off simple or partially denoised exit 1', () => {
      for (const [input, value] of [['scheduler', 'beta'], ['denoise', 0.5]] as const) {
        const { result, graphPath } = h3Violation((graph) => { node(graph, 'BasicScheduler').inputs[input] = value; });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`${graphPath}: ${SIGMAS}`);
      }
    });

    // The catalog already rejects a graph that drops a placeholder, so these
    // park it on an input no rule reads; only the value clause can then fail.
    test('a fixed step count on the sampler sigmas exits 1', () => {
      const { result, graphPath } = h3Violation((graph) => {
        node(graph, 'BasicScheduler').inputs.steps = 6;
        node(graph, 'SamplerLCM').inputs.parked = '{{steps}}';
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: ${SIGMAS}`);
    });

    test('a CFG guider exits 1', () => {
      const { result, graphPath } = h3Violation((graph) => {
        const guider = node(graph, 'BasicGuider');
        guider.class_type = 'CFGGuider';
        guider.inputs = { model: ['10', 0], positive: ['4', 0], negative: ['4', 0], cfg: 3.5 };
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: h3image graphs run one guidance-free BasicGuider on the conditioning node's output 0`);
    });

    test('sampler noise not seeded from {{seed}} exits 1', () => {
      const { result, graphPath } = h3Violation((graph) => {
        node(graph, 'RandomNoise').inputs.noise_seed = 7;
        node(graph, 'SamplerLCM').inputs.parked = '{{seed}}';
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: h3image noise comes from one RandomNoise seeded by {{seed}}`);
    });

    test('a latent not taken from the conditioning node exits 1', () => {
      const { result, graphPath } = h3Violation((graph, sampler) => {
        graph['11'] = { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } };
        sampler.inputs.latent_image = ['11', 0];
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: one MiniMaxH3ImageConditioning feeds the sampler latent from output 1`);
    });
  });

  describe('output downscale', () => {
    type ScaleGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    const RULE = '{{outputScale}} drives one lanczos ImageScaleBy between the final VAEDecode and the save node';
    function violation(mutate: (graph: ScaleGraph) => void): { result: ReturnType<typeof run>; graphPath: string } {
      const dir = copyFixture(BUILTIN_MODELS_DIR);
      const graphPath = join(dir, 'minimax-h3-image', 'workflow.json');
      const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as ScaleGraph;
      mutate(graph);
      writeFileSync(graphPath, JSON.stringify(graph));
      return { result: run(dir), graphPath };
    }
    function scaler(graph: ScaleGraph): ScaleGraph[string] {
      const found = Object.values(graph).find((node) => node.class_type === 'ImageScaleBy');
      if (found === undefined) throw new Error('minimax-h3-image graph has no ImageScaleBy');
      return found;
    }

    test('a resample method without anti-aliasing exits 1', () => {
      const { result, graphPath } = violation((graph) => { scaler(graph).inputs.upscale_method = 'bicubic'; });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: ${RULE}`);
    });

    test('a save node that bypasses the downscale exits 1', () => {
      const { result, graphPath } = violation((graph) => {
        const save = graph['9'];
        if (save === undefined) throw new Error('minimax-h3-image graph has no node 9');
        save.inputs.images = scaler(graph).inputs.image;
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: ${RULE}`);
    });
  });

  describe('h3image reference slots', () => {
    type H3Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    const SLOTS = 'h3image reference slots feed MiniMaxH3ImageConditioning images.image_N from LoadImage in order, and the base graph takes none';
    function violation(file: string, mutate: (graph: H3Graph) => void): { result: ReturnType<typeof run>; graphPath: string } {
      const dir = copyFixture(BUILTIN_MODELS_DIR);
      const graphPath = join(dir, 'minimax-h3-image', file);
      const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as H3Graph;
      mutate(graph);
      writeFileSync(graphPath, JSON.stringify(graph));
      return { result: run(dir), graphPath };
    }
    function node(graph: H3Graph, id: string): H3Graph[string] {
      const found = graph[id];
      if (found === undefined) throw new Error(`minimax-h3-image graph has no node ${id}`);
      return found;
    }

    test('slots wired out of order exit 1', () => {
      const { result, graphPath } = violation('reference.json', (graph) => {
        const inputs = node(graph, '4').inputs;
        [inputs['images.image_1'], inputs['images.image_2']] = [inputs['images.image_2'], inputs['images.image_1']];
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: ${SLOTS}`);
    });

    test('a picture resized on its way to the conditioning node exits 1', () => {
      const { result, graphPath } = violation('reference.json', (graph) => {
        graph['30'] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['20', 0], upscale_method: 'area', megapixels: 1, resolution_steps: 16 } };
        node(graph, '4').inputs['images.image_1'] = ['30', 0];
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: ${SLOTS}`);
    });

    test('a reference graph without the VAE on the conditioning node exits 1', () => {
      const { result, graphPath } = violation('reference.json', (graph) => {
        Reflect.deleteProperty(node(graph, '4').inputs, 'vae');
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: h3image reference graphs connect the VAE so pictures anchor as reference latents`);
    });

    test('a loader no slot reads exits 1', () => {
      const { result, graphPath } = violation('workflow.json', (graph) => {
        graph['30'] = { class_type: 'LoadImage', inputs: { image: 'fixed.png' } };
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${graphPath}: h3image graphs load one image per reference slot`);
    });
  });

  test('a row sharing a residency key with different weights exits 1', () => {
    const external = mkdtempSync(join(tmpdir(), 'atelier-validate-'));
    temps.push(external);
    const dir = join(external, 'minimax-h3-x2v');
    cpSync(join(BUILTIN_MODELS_DIR, 'minimax-h3-t2v'), dir, { recursive: true });
    const manifestPath = join(dir, 'model.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { id: string; order: number; requiredModelFiles: string[] };
    const original = manifest.requiredModelFiles[0];
    if (original === undefined) throw new Error('fixture has no weight file');
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, id: 'minimax-h3-x2v', order: 120,
      requiredModelFiles: ['other-unet.safetensors', ...manifest.requiredModelFiles.slice(1)] }));
    const graphPath = join(dir, 'workflow.json');
    writeFileSync(graphPath, readFileSync(graphPath, 'utf8').replace(original, 'other-unet.safetensors'));
    const result = run(external, '--builtin', BUILTIN_MODELS_DIR);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(manifestPath);
  });

  test('an unknown placeholder exits 1 without echoing it', () => {
    const dir = copyFixture(join(FIXTURES, 'external'));
    const graphPath = join(dir, 'krea-test-delta', 'workflow.json');
    writeFileSync(graphPath, readFileSync(graphPath, 'utf8').replace('"{{prompt}}"', '"{{prompt}} {{typo}}"'));
    const result = run(dir, '--builtin', join(FIXTURES, 'builtin'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(graphPath);
    expect(result.stderr).not.toContain('typo');
  });

  test('a catalog failure exits 1 naming the manifest without its contents', () => {
    const dir = copyFixture(join(FIXTURES, 'external'));
    const manifestPath = join(dir, 'moss-test-beta', 'model.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    delete manifest.overrides;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = run(dir, '--builtin', join(FIXTURES, 'builtin'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(manifestPath);
    expect(result.stderr).not.toContain('MOSS Test Beta Override');
  });
});
