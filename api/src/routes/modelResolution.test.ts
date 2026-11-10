import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelResolutionSetting, ModelResolutionSettingsResponse } from '@atelier/shared';
import { RENDER_RESOLUTIONS } from '@atelier/shared';
import { BUILTIN_MODELS_DIR } from '../providers/comfyui/catalog';
import { testRuntime } from '../test/helpers';

const LOCAL_ON = {
  COMFYUI_BASE_URL: 'http://127.0.0.1:1',
  VIDEO_MODELS_ENABLED: 'true',
  LOCAL_MODELS_USERS: 'alice,bob',
};

const H3_DEFAULTS: ModelResolutionSetting = {
  modelId: 'minimax-h3-image',
  name: 'MiniMax H3 Image',
  defaultTextToImage: '16mp',
  textToImage: null,
  defaultReference: '4mp',
  reference: null,
  outputLongEdge: 2048,
  downscale: true,
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An external override of the H3 row copied from the built-in one. */
function h3Override(edit: (dir: string, manifest: Record<string, unknown>) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'atelier-model-resolution-'));
  temps.push(root);
  const dir = join(root, 'minimax-h3-image');
  cpSync(join(BUILTIN_MODELS_DIR, 'minimax-h3-image'), dir, { recursive: true });
  const path = join(dir, 'model.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  manifest.overrides = true;
  edit(dir, manifest);
  writeFileSync(path, JSON.stringify(manifest));
  return root;
}

/** The H3 row without its reference graph. */
function h3WithoutReference(): string {
  return h3Override((dir, manifest) => {
    rmSync(join(dir, 'reference.json'));
    manifest.graphs = { base: 'workflow.json' };
    delete manifest.maxReferenceImages;
    delete manifest.referenceRatioMap;
  });
}

/** The H3 row delivering at render size: no `outputLongEdge`, no final scale node. */
function h3WithoutOutputLongEdge(): string {
  return h3Override((dir, manifest) => {
    delete manifest.outputLongEdge;
    manifest.requiredPlaceholders = (manifest.requiredPlaceholders as string[])
      .filter((placeholder) => placeholder !== '{{outputScale}}');
    for (const graph of ['workflow.json', 'reference.json']) {
      const path = join(dir, graph);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('"{{outputScale}}"', '1'));
    }
  });
}

function headers(user = 'alice') {
  return { 'Content-Type': 'application/json', 'Remote-User': user };
}

function put(rt: ReturnType<typeof testRuntime>, modelId: string, body: unknown, user = 'alice') {
  return rt.fetch(`/api/settings/model-resolution/${modelId}`, {
    method: 'PUT',
    headers: headers(user),
    body: JSON.stringify(body),
  });
}

async function settings(rt: ReturnType<typeof testRuntime>, user = 'alice'): Promise<ModelResolutionSettingsResponse> {
  const res = await rt.fetch('/api/settings/model-resolution', { headers: headers(user) });
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  return await res.json() as ModelResolutionSettingsResponse;
}

async function h3(res: Response): Promise<ModelResolutionSetting | undefined> {
  return (await res.json() as ModelResolutionSettingsResponse).models.find((m) => m.modelId === 'minimax-h3-image');
}

describe('model resolution settings routes', () => {
  test('GET lists only rows that offer render sizes, with their defaults and no override', async () => {
    const rt = testRuntime(LOCAL_ON);
    expect(await settings(rt)).toEqual({ options: [...RENDER_RESOLUTIONS], models: [H3_DEFAULTS] });
  });

  test('PUT sets each mode, an absent key keeps the other, and null resets', async () => {
    const rt = testRuntime(LOCAL_ON);
    const set = await put(rt, 'minimax-h3-image', { textToImage: '8mp' });
    expect(set.status).toBe(200);
    expect(set.headers.get('cache-control')).toBe('private, no-store');
    expect(await h3(set)).toEqual({ ...H3_DEFAULTS, textToImage: '8mp' });

    const both = await put(rt, 'minimax-h3-image', { reference: '16mp' });
    expect(await h3(both)).toEqual({ ...H3_DEFAULTS, textToImage: '8mp', reference: '16mp' });

    const reset = await put(rt, 'minimax-h3-image', { textToImage: null, reference: null });
    expect(await h3(reset)).toEqual(H3_DEFAULTS);
  });

  test('a value equal to the mode default is stored as no override', async () => {
    const rt = testRuntime(LOCAL_ON);
    await put(rt, 'minimax-h3-image', { textToImage: '4mp', reference: '8mp' });
    const asDefault = await put(rt, 'minimax-h3-image', { textToImage: '16mp', reference: '4mp' });
    expect(await h3(asDefault)).toEqual(H3_DEFAULTS);
  });

  test('PUT turns "Downsize to 2K" off and back on, keeping the sizes', async () => {
    const rt = testRuntime(LOCAL_ON);
    const off = await put(rt, 'minimax-h3-image', { downscale: false });
    expect(off.status).toBe(200);
    expect(await h3(off)).toEqual({ ...H3_DEFAULTS, downscale: false });

    const sized = await put(rt, 'minimax-h3-image', { textToImage: '8mp' });
    expect(await h3(sized)).toEqual({ ...H3_DEFAULTS, textToImage: '8mp', downscale: false });

    const on = await put(rt, 'minimax-h3-image', { downscale: true });
    expect(await h3(on)).toEqual({ ...H3_DEFAULTS, textToImage: '8mp' });

    await put(rt, 'minimax-h3-image', { downscale: false });
    const reset = await put(rt, 'minimax-h3-image', { textToImage: null, reference: null, downscale: true });
    expect(await h3(reset)).toEqual(H3_DEFAULTS);
  });

  test('a row that delivers at render size lists no switch and rejects a downscale write', async () => {
    const rt = testRuntime({ ...LOCAL_ON, COMFYUI_MODELS_DIR: h3WithoutOutputLongEdge() });
    const fullSize = { ...H3_DEFAULTS, outputLongEdge: null, downscale: false };
    expect((await settings(rt)).models).toEqual([fullSize]);
    for (const downscale of [false, true]) {
      const res = await put(rt, 'minimax-h3-image', { downscale });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'validation failed',
        issues: [{ path: ['downscale'], message: 'model delivers at render size' }],
      });
    }
    expect(await h3(await put(rt, 'minimax-h3-image', { textToImage: '8mp' }))).toEqual({ ...fullSize, textToImage: '8mp' });
  });

  test('PUT rejects unknown sizes, extra keys and an empty body', async () => {
    const rt = testRuntime(LOCAL_ON);
    for (const body of [
      { textToImage: '2mp' },
      { reference: '8MP' },
      { textToImage: 8 },
      { textToImage: '8mp', steps: 4 },
      { downscale: 'off' },
      { downscale: 0 },
      { downscale: null },
      {},
    ]) {
      expect((await put(rt, 'minimax-h3-image', body)).status).toBe(400);
    }
    expect((await settings(rt)).models).toEqual([H3_DEFAULTS]);
  });

  test('a row without a reference graph lists null reference fields and rejects a reference write', async () => {
    const rt = testRuntime({ ...LOCAL_ON, COMFYUI_MODELS_DIR: h3WithoutReference() });
    const textOnly = { ...H3_DEFAULTS, defaultReference: null };
    expect((await settings(rt)).models).toEqual([textOnly]);
    for (const reference of ['8mp', null]) {
      const res = await put(rt, 'minimax-h3-image', { reference });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'validation failed',
        issues: [{ path: ['reference'], message: 'model takes no reference pictures' }],
      });
    }
    expect(await h3(await put(rt, 'minimax-h3-image', { textToImage: '4mp' }))).toEqual({ ...textOnly, textToImage: '4mp' });
  });

  test('PUT 404s alike for unknown models and rows without render sizes', async () => {
    const rt = testRuntime(LOCAL_ON);
    for (const modelId of ['no-such-model', 'gpt-image-2.6-sunburst', 'krea-2-gonzalomo']) {
      const res = await put(rt, modelId, { textToImage: '8mp' });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
  });

  test('a user without local access sees an empty list and 404s on the row', async () => {
    const rt = testRuntime(LOCAL_ON);
    expect((await settings(rt, 'mallory')).models).toEqual([]);
    const res = await put(rt, 'minimax-h3-image', { textToImage: '8mp' }, 'mallory');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  test("another user's overrides are not visible", async () => {
    const rt = testRuntime(LOCAL_ON);
    await put(rt, 'minimax-h3-image', { textToImage: '8mp', downscale: false }, 'alice');
    expect((await settings(rt, 'bob')).models).toEqual([H3_DEFAULTS]);
    expect((await settings(rt, 'alice')).models).toEqual([{ ...H3_DEFAULTS, textToImage: '8mp', downscale: false }]);
  });
});
