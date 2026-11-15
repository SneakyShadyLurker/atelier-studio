import { describe, expect, test } from 'bun:test';
import type { TextRoutingResponse } from '@atelier/shared';
import { registryForConfig } from '../providers/registry';
import { listedTextAvailability, testRuntime } from '../test/helpers';

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

describe('GET /api/text-routing', () => {
  test('returns defaults, writers with their mode and the registered image models', async () => {
    const { rt, enabled } = await setup();
    rt.text.store.setDefault('default', enabled);
    rt.text.store.setDefault('ai-fill', enabled);
    rt.text.store.setWriter('gpt-image-2.6-sunburst', { modelId: enabled, mode: 'lock' });

    const res = await rt.fetch('/api/text-routing', { headers: { 'Remote-User': 'alice' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = (await res.json()) as TextRoutingResponse;
    expect(body.defaults).toEqual({ default: enabled, byTask: { 'ai-fill': enabled } });
    expect(body.writers).toEqual({ 'gpt-image-2.6-sunburst': { modelId: enabled, mode: 'lock' } });
    // The same set the writer PUT validates against, labelled for the admin.
    const registered = registryForConfig(rt.config).map((entry) => ({ id: entry.model.id, label: entry.model.name }));
    expect(registered.length).toBeGreaterThan(0);
    expect(body.imageModels).toEqual(registered);
    expect(body.imageModels.map((image) => image.id)).toContain('gpt-image-2.6-sunburst');
  });

  test('writes answer with the same shape', async () => {
    const { rt, enabled } = await setup();
    const body = (await (await put(rt, '/defaults/default', { modelId: enabled })).json()) as TextRoutingResponse;
    expect(body.imageModels.length).toBeGreaterThan(0);
    expect(body.writers).toEqual({});
  });

  test('is admin-only', async () => {
    const { rt } = await setup();
    const res = await rt.fetch('/api/text-routing', { headers: { 'Remote-User': 'mallory' } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('imageModels');
  });
});

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
    const res = await put(rt, '/writers/gpt-image-2.6-sunburst', { modelId: enabled });
    expect(res.status).toBe(200);
    expect(rt.text.store.revision()).toBeGreaterThan(before);
    expect(((await res.json()) as { writers: unknown }).writers).toEqual({ 'gpt-image-2.6-sunburst': { modelId: enabled, mode: 'prefer' } });

    expect((await put(rt, '/writers/gpt-image-2.6-sunburst', { modelId: enabled, mode: 'lock' })).status).toBe(200);
    expect(rt.text.store.readWriters()).toEqual({ 'gpt-image-2.6-sunburst': { modelId: enabled, mode: 'lock' } });
    expect((await put(rt, '/writers/gpt-image-2.6-sunburst', { modelId: null })).status).toBe(200);
    expect(rt.text.store.readWriters()).toEqual({});
  });

  test('rejects an unknown image model, a disabled text model and an unknown mode', async () => {
    const { rt, enabled, disabled } = await setup();
    const unknown = await put(rt, '/writers/not-an-image-model', { modelId: enabled });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain('image model');
    expect((await put(rt, '/writers/gpt-image-2.6-sunburst', { modelId: disabled })).status).toBe(400);
    expect((await put(rt, '/writers/gpt-image-2.6-sunburst', { modelId: enabled, mode: 'always' })).status).toBe(400);
    expect(rt.text.store.readWriters()).toEqual({});
  });

  test('is admin-only', async () => {
    const { rt, enabled } = await setup();
    expect((await put(rt, '/writers/gpt-image-2.6-sunburst', { modelId: enabled }, 'mallory')).status).toBe(404);
    expect((await put(rt, '/defaults/default', { modelId: enabled }, 'mallory')).status).toBe(404);
  });
});

// Shared effort (R4.2, R4.3): both PUTs follow `PUT /api/text-models/tasks/:task`.
describe('shared effort on routing PUTs', () => {
  const IMAGE = 'gpt-image-2.6-sunburst';
  type Effort = 'low' | 'medium' | 'high';
  interface EffortSetup { rt: Runtime; lowHigh: string; medium: string; plain: string }

  /** Upstream 'lh' is listed only when `offline` is false. */
  async function effortSetup(offline = false): Promise<EffortSetup> {
    const rt = testRuntime({
      TEXT_PROVIDER_ADMINS: 'alice',
      textAvailability: listedTextAvailability(new Set(offline ? ['md', 'pl'] : ['lh', 'md', 'pl'])),
    });
    const provider = await rt.text.store.createProvider({ name: 'Local', protocol: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' });
    const [lowHigh, medium, plain] = rt.text.store.createModels(provider.id, [
      { modelId: 'lh', reasoningLevels: ['low', 'high'] },
      { modelId: 'md', reasoningLevels: ['medium'] },
      { modelId: 'pl' },
    ]);
    if (!lowHigh || !medium || !plain) throw new Error('models not created');
    return { rt, lowHigh: lowHigh.id, medium: medium.id, plain: plain.id };
  }

  /** One route under test: its path and how to read its assignment back from a response. */
  interface Target {
    readonly name: string;
    readonly path: string;
    readonly extra: Record<string, unknown>;
    readonly read: (body: TextRoutingResponse) => { modelId?: string; effort?: string };
  }
  const TARGETS: readonly Target[] = [
    {
      name: 'default',
      path: '/defaults/default',
      extra: {},
      read: (body) => ({ ...(body.defaults.default ? { modelId: body.defaults.default } : {}), ...(body.efforts.default ? { effort: body.efforts.default } : {}) }),
    },
    {
      name: 'task',
      path: '/defaults/rescue',
      extra: {},
      read: (body) => ({
        ...(body.defaults.byTask.rescue ? { modelId: body.defaults.byTask.rescue } : {}),
        ...(body.efforts.byTask.rescue ? { effort: body.efforts.byTask.rescue } : {}),
      }),
    },
    {
      name: 'writer',
      path: `/writers/${IMAGE}`,
      extra: { mode: 'lock' },
      read: (body) => {
        const writer = body.writers[IMAGE];
        return writer ? { modelId: writer.modelId, ...(writer.effort ? { effort: writer.effort } : {}) } : {};
      },
    },
  ];

  async function state(rt: Runtime): Promise<TextRoutingResponse> {
    return (await (await rt.fetch('/api/text-routing', { headers: { 'Remote-User': 'alice' } })).json()) as TextRoutingResponse;
  }

  for (const target of TARGETS) {
    describe(target.name, () => {
      test('a valid effort is stored and returned', async () => {
        const { rt, lowHigh } = await effortSetup();
        const res = await put(rt, target.path, { modelId: lowHigh, effort: 'high', ...target.extra });
        expect(res.status).toBe(200);
        expect(target.read((await res.json()) as TextRoutingResponse)).toEqual({ modelId: lowHigh, effort: 'high' });
        expect(target.read(await state(rt))).toEqual({ modelId: lowHigh, effort: 'high' });
      });

      test('an effort the model does not offer is a 400 and writes nothing', async () => {
        const { rt, lowHigh, medium } = await effortSetup();
        await put(rt, target.path, { modelId: lowHigh, effort: 'low', ...target.extra });
        const revision = rt.text.store.revision();
        const res = await put(rt, target.path, { modelId: medium, effort: 'high', ...target.extra });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe('This text model does not offer that reasoning level');
        expect(rt.text.store.revision()).toBe(revision);
        expect(target.read(await state(rt))).toEqual({ modelId: lowHigh, effort: 'low' });
      });

      test('an omitted effort is kept when the new model offers it and cleared when it does not', async () => {
        const { rt, lowHigh, medium } = await effortSetup();
        await put(rt, target.path, { modelId: lowHigh, effort: 'high', ...target.extra });
        // Same model, nothing else changes: kept.
        expect(target.read((await (await put(rt, target.path, { modelId: lowHigh, ...target.extra })).json()) as TextRoutingResponse))
          .toEqual({ modelId: lowHigh, effort: 'high' });
        // A model without 'high': cleared, and stays cleared when switching back.
        expect(target.read((await (await put(rt, target.path, { modelId: medium, ...target.extra })).json()) as TextRoutingResponse))
          .toEqual({ modelId: medium });
        expect(target.read((await (await put(rt, target.path, { modelId: lowHigh, ...target.extra })).json()) as TextRoutingResponse))
          .toEqual({ modelId: lowHigh });
      });

      test('null clears the effort and keeps the model', async () => {
        const { rt, lowHigh } = await effortSetup();
        await put(rt, target.path, { modelId: lowHigh, effort: 'low', ...target.extra });
        const res = await put(rt, target.path, { modelId: lowHigh, effort: null, ...target.extra });
        expect(res.status).toBe(200);
        expect(target.read((await res.json()) as TextRoutingResponse)).toEqual({ modelId: lowHigh });
      });

      test('a null model with an effort is a 400; a null model otherwise clears model and effort', async () => {
        const { rt, lowHigh } = await effortSetup();
        await put(rt, target.path, { modelId: lowHigh, effort: 'low', ...target.extra });
        const revision = rt.text.store.revision();
        const bad = await put(rt, target.path, { modelId: null, effort: 'low' });
        expect(bad.status).toBe(400);
        expect(((await bad.json()) as { error: string }).error).toBe('A reasoning level needs a text model');
        expect(rt.text.store.revision()).toBe(revision);
        expect(target.read(await state(rt))).toEqual({ modelId: lowHigh, effort: 'low' });

        for (const body of [{ modelId: null }, { modelId: null, effort: null }]) {
          await put(rt, target.path, { modelId: lowHigh, effort: 'low', ...target.extra });
          const res = await put(rt, target.path, body);
          expect(res.status).toBe(200);
          expect(target.read((await res.json()) as TextRoutingResponse)).toEqual({});
          // A later assignment does not resurrect the cleared effort.
          const again = await put(rt, target.path, { modelId: lowHigh, ...target.extra });
          expect(target.read((await again.json()) as TextRoutingResponse)).toEqual({ modelId: lowHigh });
        }
      });

      test('the stored effort is reported as stored after the model stops offering it', async () => {
        const { rt, lowHigh } = await effortSetup();
        await put(rt, target.path, { modelId: lowHigh, effort: 'high', ...target.extra });
        rt.text.store.updateModel(lowHigh, { reasoningLevels: ['medium'] });
        expect(target.read(await state(rt))).toEqual({ modelId: lowHigh, effort: 'high' });
      });

      test('an offline model stays assignable with an effort', async () => {
        const { rt, lowHigh } = await effortSetup(true);
        const model = rt.text.store.getModel(lowHigh);
        if (!model) throw new Error('model missing');
        expect(rt.text.availability.statusOf(model)).toBe('offline');
        const res = await put(rt, target.path, { modelId: lowHigh, effort: 'low', ...target.extra });
        expect(res.status).toBe(200);
        expect(target.read((await res.json()) as TextRoutingResponse)).toEqual({ modelId: lowHigh, effort: 'low' });
      });

      // Every prior stored state × assigned model × effort input (R4.2).
      test('exhaustive table: stored effort × model levels × effort input', async () => {
        const { rt, lowHigh, medium, plain } = await effortSetup();
        const levels: Record<string, readonly Effort[]> = { [lowHigh]: ['low', 'high'], [medium]: ['medium'], [plain]: [] };
        const priors: readonly ({ modelId: string; effort?: Effort } | null)[] = [
          null,
          { modelId: lowHigh },
          { modelId: lowHigh, effort: 'high' },
          { modelId: medium, effort: 'medium' },
          { modelId: plain },
        ];
        const inputs: readonly (Effort | null | undefined)[] = [undefined, null, 'low', 'medium', 'high'];
        for (const prior of priors) {
          for (const modelId of [lowHigh, medium, plain, null]) {
            for (const effort of inputs) {
              await put(rt, target.path, { modelId: null });
              if (prior) expect((await put(rt, target.path, { ...prior, ...target.extra })).status).toBe(200);
              const before = target.read(await state(rt));
              const body = { modelId, ...(effort === undefined ? {} : { effort }), ...(modelId === null ? {} : target.extra) };
              const res = await put(rt, target.path, body);
              const offered = (level: Effort | undefined): boolean => modelId !== null && level !== undefined && (levels[modelId] ?? []).includes(level);
              const label = JSON.stringify({ prior, modelId, effort });
              if (effort !== undefined && effort !== null && !offered(effort)) {
                expect({ label, status: res.status }).toEqual({ label, status: 400 });
                expect(target.read(await state(rt))).toEqual(before);
                continue;
              }
              expect({ label, status: res.status }).toEqual({ label, status: 200 });
              const kept = effort === undefined && prior?.effort !== undefined && offered(prior.effort) ? prior.effort : undefined;
              const next = effort ?? kept;
              const expected = modelId === null ? {} : { modelId, ...(next ? { effort: next } : {}) };
              expect({ label, got: target.read((await res.json()) as TextRoutingResponse) }).toEqual({ label, got: expected });
            }
          }
        }
      });
    });
  }

  test('GET reports every assignment effort side by side', async () => {
    const { rt, lowHigh, medium } = await effortSetup();
    await put(rt, '/defaults/default', { modelId: lowHigh, effort: 'low' });
    await put(rt, '/defaults/enhance', { modelId: medium, effort: 'medium' });
    await put(rt, '/defaults/rescue', { modelId: medium });
    await put(rt, `/writers/${IMAGE}`, { modelId: lowHigh, effort: 'high' });
    const body = await state(rt);
    expect(body.defaults).toEqual({ default: lowHigh, byTask: { enhance: medium, rescue: medium } });
    expect(body.efforts).toEqual({ default: 'low', byTask: { enhance: 'medium' } });
    expect(body.writers).toEqual({ [IMAGE]: { modelId: lowHigh, mode: 'prefer', effort: 'high' } });
  });
});
