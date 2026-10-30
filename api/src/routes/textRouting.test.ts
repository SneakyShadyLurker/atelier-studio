import { describe, expect, test } from 'bun:test';
import { testRuntime } from '../test/helpers';

// Admin routing writes (spec § 10.2): task assignments, the default model and
// per-image-model prompt writers.

type Runtime = ReturnType<typeof testRuntime>;

function put(rt: Runtime, path: string, body: unknown, user = 'alice'): Promise<Response> {
  return rt.fetch(`/api/text-routing${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Remote-User': user },
    body: JSON.stringify(body),
  });
}

async function setup(): Promise<{ rt: Runtime; enabled: string; disabled: string }> {
  const rt = testRuntime({ TEXT_PROVIDER_ADMINS: 'alice' });
  const provider = await rt.text.store.createProvider({ name: 'Local', protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' });
  const [enabled, disabled] = rt.text.store.createModels(provider.id, [{ modelId: 'a' }, { modelId: 'b', enabled: false }]);
  if (!enabled || !disabled) throw new Error('models not created');
  return { rt, enabled: enabled.id, disabled: disabled.id };
}

describe('PUT /api/text-routing/defaults/:scope', () => {
  test('sets and clears the default and a task assignment, bumping the revision', async () => {
    const { rt, enabled } = await setup();
    const before = rt.text.store.revision();
    const res = await put(rt, '/defaults/default', { modelId: enabled });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(rt.text.store.revision()).toBeGreaterThan(before);
    expect(((await res.json()) as { defaults: unknown }).defaults).toEqual({ default: enabled, byTask: {} });

    expect((await put(rt, '/defaults/rescue', { modelId: enabled })).status).toBe(200);
    expect(rt.text.store.readDefaults()).toEqual({ default: enabled, byTask: { rescue: enabled } });
    expect((await put(rt, '/defaults/default', { modelId: null })).status).toBe(200);
    expect(rt.text.store.readDefaults()).toEqual({ byTask: { rescue: enabled } });
  });

  test('rejects an unknown scope, an unknown model and a disabled model', async () => {
    const { rt, enabled, disabled } = await setup();
    expect((await put(rt, '/defaults/everything', { modelId: enabled })).status).toBe(400);
    expect((await put(rt, '/defaults/default', { modelId: 'missing' })).status).toBe(400);
    const off = await put(rt, '/defaults/enhance', { modelId: disabled });
    expect(off.status).toBe(400);
    expect(((await off.json()) as { error: string }).error).toContain('turned off');
    expect(rt.text.store.readDefaults()).toEqual({ byTask: {} });
  });
});

describe('PUT /api/text-routing/writers/:imageModelId', () => {
  test('mode defaults to prefer, accepts lock, and null clears', async () => {
    const { rt, enabled } = await setup();
    const before = rt.text.store.revision();
    const res = await put(rt, '/writers/gpt-image-2.5-sunburst', { modelId: enabled });
    expect(res.status).toBe(200);
    expect(rt.text.store.revision()).toBeGreaterThan(before);
    expect(((await res.json()) as { writers: unknown }).writers).toEqual({ 'gpt-image-2.5-sunburst': { modelId: enabled, mode: 'prefer' } });

    expect((await put(rt, '/writers/gpt-image-2.5-sunburst', { modelId: enabled, mode: 'lock' })).status).toBe(200);
    expect(rt.text.store.readWriters()).toEqual({ 'gpt-image-2.5-sunburst': { modelId: enabled, mode: 'lock' } });
    expect((await put(rt, '/writers/gpt-image-2.5-sunburst', { modelId: null })).status).toBe(200);
    expect(rt.text.store.readWriters()).toEqual({});
  });

  test('rejects an unknown image model, a disabled text model and an unknown mode', async () => {
    const { rt, enabled, disabled } = await setup();
    const unknown = await put(rt, '/writers/not-an-image-model', { modelId: enabled });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain('image model');
    expect((await put(rt, '/writers/gpt-image-2.5-sunburst', { modelId: disabled })).status).toBe(400);
    expect((await put(rt, '/writers/gpt-image-2.5-sunburst', { modelId: enabled, mode: 'always' })).status).toBe(400);
    expect(rt.text.store.readWriters()).toEqual({});
  });

  test('is admin-only', async () => {
    const { rt, enabled } = await setup();
    expect((await put(rt, '/writers/gpt-image-2.5-sunburst', { modelId: enabled }, 'mallory')).status).toBe(404);
    expect((await put(rt, '/defaults/default', { modelId: enabled }, 'mallory')).status).toBe(404);
  });
});
