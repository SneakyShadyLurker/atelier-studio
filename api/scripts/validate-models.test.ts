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
