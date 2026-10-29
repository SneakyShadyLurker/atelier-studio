import { afterEach, describe, expect, test } from 'bun:test';
import { textBackendModels } from '../../providers/cliproxyText.config';
import { resetTextBackendAvailabilityForTests } from '../../routing/textBackendAvailability';
import { testRuntime, testConfig } from '../../test/helpers';

const TEXT_MODELS = textBackendModels(testConfig());

const GATED = { PROMPT_LIBRARY_USERS: 'alice' };
// A proxy inventory serving every routed model except DeepSeek Abliterated's,
// which the upstream does not serve.
const WITHOUT_DEEPSEEK = new Set(
  Object.values(TEXT_MODELS).filter((id) => id !== TEXT_MODELS['deepseek-abliterated']),
);

afterEach(() => {
  resetTextBackendAvailabilityForTests();
});

function headers(user = 'alice') {
  return { 'Content-Type': 'application/json', 'Remote-User': user };
}

describe('text backend settings routes', () => {
  test('GPT pins are rejected for every workload', async () => {
    const rt = testRuntime(GATED);
    for (const workload of ['ai-fill', 'brainstorm', 'enhance', 'condense', 'storytelling']) {
      const res = await rt.fetch(`/api/prompts/settings/text-backends/${workload}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ backend: 'gpt' }),
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('cannot be pinned');
    }
    const res = await rt.fetch('/api/prompts/settings/text-backends', { headers: headers() });
    expect(await res.json()).toEqual({ efforts: {}, overrides: {}, unavailable: [] });
  });

  test('GET returns an empty override map for a fresh user', async () => {
    const rt = testRuntime(GATED);
    const res = await rt.fetch('/api/prompts/settings/text-backends', { headers: headers() });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ efforts: {}, overrides: {}, unavailable: [] });
  });

  test('PUT stores an override and returns the full fresh map; null clears', async () => {
    const rt = testRuntime(GATED);
    const put = await rt.fetch('/api/prompts/settings/text-backends/ai-fill', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ backend: 'kimi' }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ efforts: {}, overrides: { 'ai-fill': 'kimi' }, unavailable: [] });

    const second = await rt.fetch('/api/prompts/settings/text-backends/condense', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ backend: 'mimo' }),
    });
    expect(await second.json()).toEqual({ efforts: {}, overrides: { 'ai-fill': 'kimi', condense: 'mimo' }, unavailable: [] });

    const third = await rt.fetch('/api/prompts/settings/text-backends/enhance', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ backend: 'mimo' }),
    });
    expect(await third.json()).toEqual({
      efforts: {},
      overrides: { 'ai-fill': 'kimi', condense: 'mimo', enhance: 'mimo' },
      unavailable: [],
    });

    const fourth = await rt.fetch('/api/prompts/settings/text-backends/storytelling', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ backend: 'grok' }),
    });
    expect(await fourth.json()).toEqual({
      efforts: {},
      overrides: {
        'ai-fill': 'kimi',
        condense: 'mimo',
        enhance: 'mimo',
        storytelling: 'grok',
      },
      unavailable: [],
    });

    const fifth = await rt.fetch('/api/prompts/settings/text-backends/brainstorm', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ backend: 'deepseek-abliterated' }),
    });
    expect(await fifth.json()).toEqual({
      efforts: {},
      overrides: {
        'ai-fill': 'kimi',
        condense: 'mimo',
        enhance: 'mimo',
        storytelling: 'grok',
        brainstorm: 'deepseek-abliterated',
      },
      unavailable: [],
    });

    const clear = await rt.fetch('/api/prompts/settings/text-backends/ai-fill', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ backend: null }),
    });
    expect(await clear.json()).toEqual({
      efforts: {},
      overrides: {
        condense: 'mimo',
        enhance: 'mimo',
        storytelling: 'grok',
        brainstorm: 'deepseek-abliterated',
      },
      unavailable: [],
    });
  });

  test('GET lists backends the proxy inventory does not serve, with stored pins unchanged', async () => {
    const rt = testRuntime({ ...GATED, textModels: WITHOUT_DEEPSEEK });
    rt.db.query("INSERT INTO users (id, created_at) VALUES ('alice', 1)").run();
    rt.db.query(
      "INSERT INTO user_text_backends (user_id, workload, backend, updated_at) VALUES ('alice', 'ai-fill', 'deepseek-abliterated', 1)",
    ).run();
    const res = await rt.fetch('/api/prompts/settings/text-backends', { headers: headers() });
    expect(await res.json()).toEqual({ efforts: {}, overrides: { 'ai-fill': 'deepseek-abliterated' }, unavailable: ['deepseek-abliterated'] });
  });

  test('PUT rejects an unavailable backend with 400 and still accepts null', async () => {
    const rt = testRuntime({ ...GATED, textModels: WITHOUT_DEEPSEEK });
    const rejected = await rt.fetch('/api/prompts/settings/text-backends/brainstorm', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ backend: 'deepseek-abliterated' }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: 'This text backend is currently unavailable' });

    const cleared = await rt.fetch('/api/prompts/settings/text-backends/brainstorm', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ backend: null }),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ efforts: {}, overrides: {}, unavailable: ['deepseek-abliterated'] });

    const served = await rt.fetch('/api/prompts/settings/text-backends/brainstorm', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ backend: 'kimi' }),
    });
    expect(served.status).toBe(200);
  });

  test('PUT stores an effort with its pin, rejects one the backend does not accept, and resets with null', async () => {
    const rt = testRuntime(GATED);
    const put = (body: unknown) => rt.fetch('/api/prompts/settings/text-backends/enhance', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(body),
    });

    const stored = await put({ backend: 'kimi', effort: 'high' });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({ efforts: { enhance: 'high' }, overrides: { enhance: 'kimi' }, unavailable: [] });

    // GLM 5.3 always reasons and publishes only low/high/max; Kimi
    // lists low/high/max and MiMo none/high, so unlisted levels are refused.
    expect((await put({ backend: 'glm-abliterated', effort: 'none' })).status).toBe(400);
    expect((await put({ backend: 'kimi', effort: 'none' })).status).toBe(400);
    expect((await put({ backend: 'mimo', effort: 'low' })).status).toBe(400);
    expect((await put({ backend: 'grok', effort: 'max' })).status).toBe(400);
    expect((await put({ backend: 'gemini-argon', effort: 'xhigh' })).status).toBe(400);
    expect((await put({ backend: 'glm-abliterated', effort: 'medium' })).status).toBe(400);
    expect((await put({ backend: 'gpt', effort: 'low' })).status).toBe(400);
    expect((await put({ backend: null, effort: 'low' })).status).toBe(400);
    expect((await put({ backend: 'kimi', effort: 'extreme' })).status).toBe(400);

    const moved = await put({ backend: 'mimo' });
    expect(await moved.json()).toEqual({ efforts: { enhance: 'high' }, overrides: { enhance: 'mimo' }, unavailable: [] });

    const reset = await put({ backend: 'mimo', effort: null });
    expect(await reset.json()).toEqual({ efforts: {}, overrides: { enhance: 'mimo' }, unavailable: [] });

    const deepseek = await put({ backend: 'deepseek-abliterated', effort: 'minimal' });
    expect(await deepseek.json()).toEqual({
      efforts: { enhance: 'minimal' },
      overrides: { enhance: 'deepseek-abliterated' },
      unavailable: [],
    });

    const abliterated = await put({ backend: 'glm-abliterated', effort: 'max' });
    expect(await abliterated.json()).toEqual({
      efforts: { enhance: 'max' },
      overrides: { enhance: 'glm-abliterated' },
      unavailable: [],
    });
  });

  test('PUT rejects an unknown workload with 400', async () => {
    const rt = testRuntime(GATED);
    const res = await rt.fetch('/api/prompts/settings/text-backends/not-a-workload', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ backend: 'kimi' }),
    });
    expect(res.status).toBe(400);
  });

  test('PUT rejects an invalid backend with 400', async () => {
    const rt = testRuntime(GATED);
    const res = await rt.fetch('/api/prompts/settings/text-backends/ai-fill', {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({ backend: 'unknown' }),
    });
    expect(res.status).toBe(400);
  });

  test("retired backend keys are rejected with no alias", async () => {
    const rt = testRuntime(GATED);
    for (const backend of ['flash', 'deepseek-pro', 'deepseek-flash', 'qwen', 'glm-flash']) {
      for (const workload of ['ai-fill', 'brainstorm', 'enhance', 'condense', 'storytelling']) {
        const res = await rt.fetch(`/api/prompts/settings/text-backends/${workload}`, {
          method: 'PUT',
          headers: headers(),
          body: JSON.stringify({ backend }),
        });
        expect(res.status).toBe(400);
      }
    }
  });

  test('a non-PROMPT_LIBRARY_USERS user gets the leak-safe 404', async () => {
    const rt = testRuntime(GATED);
    const get = await rt.fetch('/api/prompts/settings/text-backends', { headers: headers('mallory') });
    const put = await rt.fetch('/api/prompts/settings/text-backends/ai-fill', {
      method: 'PUT',
      headers: headers('mallory'),
      body: JSON.stringify({ backend: 'kimi' }),
    });
    const missing = await rt.fetch(`/api/${crypto.randomUUID()}`, { headers: headers('mallory') });
    expect(get.status).toBe(404);
    expect(put.status).toBe(404);
    expect(await get.text()).toBe(await missing.text());
  });
});
