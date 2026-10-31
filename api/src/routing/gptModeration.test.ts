import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createCliproxyProvider } from '../providers/cliproxy';
import { setJevSystemOneProviderForTests } from '../providers/jevSystemOne';
import { moderateGptInput } from './gptModeration';
import type { LegacyTextKey } from '../db/textSeed';
import { rejectionOf } from '../test/helpers';
import { genericTextModel, seededTextModel, testTextModelProvider } from '../test/textModelProvider';

/** The feature provider over a seeded legacy-keyed row (only 'gpt' is screened). */
function seededText(key: LegacyTextKey, origin = 'https://gpt.test') {
  return testTextModelProvider({ origin, model: seededTextModel(key), moderation: { openrouterApiKey: 'or-key' } });
}

const okStream = () => new Response(
  'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  { headers: { 'content-type': 'text/event-stream' } },
);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setJevSystemOneProviderForTests(null);
});

function decision(sexual = 0.01, violence = 0.01, nudity = 0.01): Response {
  return Response.json({ answers: {
    explicit_nudity: { type: 'noul', noul: nudity },
    sexual_minor_or_unknown_age: { type: 'noul', noul: sexual },
    graphic_violence: { type: 'noul', noul: violence },
  } });
}

const signal = () => new AbortController().signal;
const evidence = { task: 'image-generation' as const, input: 'A landscape' };

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

describe('GPT moderation gate', () => {
  test.each([
    [0.8, 0.01, 'sexual-age'],
    [0.01, 0.9, 'graphic-violence'],
    [0.9, 0.9, 'sexual-age-and-violence'],
  ])('blocks a confident classification and returns its curated reason', async (sexual, violence, reason) => {
    setJevSystemOneProviderForTests(() => Promise.resolve(decision(sexual, violence)));
    expect(await rejectionOf(moderateGptInput(undefined, evidence, signal()))).toMatchObject({
      kind: 'moderation-blocked', moderation: { reason, target: 'image' },
    });
  });

  test.each([0, 0.5, 0.79])('allows a valid score below the threshold: %s', async (score) => {
    setJevSystemOneProviderForTests(() => Promise.resolve(decision(score, score, score)));
    await moderateGptInput(undefined, evidence, signal());
  });

  test.each([
    () => new Response('secret upstream detail', { status: 429 }),
    () => new Response('secret upstream detail', { status: 500 }),
    () => new Response('not JSON'),
    () => Response.json({ answers: {} }),
    () => decision(-1),
    () => decision(1.1),
    () => new Response('x'.repeat(17_000)),
  ])('fails closed on unavailable or malformed decisions without leaking provider content', async (response) => {
    setJevSystemOneProviderForTests(() => Promise.resolve(response()));
    expect(await rejectionOf(moderateGptInput(undefined, evidence, signal()))).toMatchObject({
      kind: 'moderation-unavailable', moderation: { reason: 'unavailable', target: 'image' },
    });
  });

  test('missing key never attempts either provider', async () => {
    const network = mock(() => { throw new Error('unexpected network request'); });
    globalThis.fetch = network as unknown as typeof fetch;
    expect(await rejectionOf(moderateGptInput(undefined, evidence, signal()))).toMatchObject({ kind: 'moderation-unavailable' });
    expect(network).not.toHaveBeenCalled();
  });

  test('rejects over-budget evidence instead of truncating it', async () => {
    const jev = mock(() => Promise.resolve(decision()));
    setJevSystemOneProviderForTests(jev);
    expect(await rejectionOf(moderateGptInput(undefined, { ...evidence, input: 'x'.repeat(70_000) }, signal())))
      .toMatchObject({ kind: 'moderation-unavailable' });
    expect(jev).not.toHaveBeenCalled();
  });

  test('caller cancellation propagates while a response body is stalled', async () => {
    const controller = new AbortController();
    const reason = new DOMException('canceled', 'AbortError');
    setJevSystemOneProviderForTests(() => Promise.resolve(new Response(new ReadableStream())));
    const pending = moderateGptInput(undefined, evidence, controller.signal);
    controller.abort(reason);
    expect(await rejectionOf(pending)).toBe(reason);
  });

  test('JEV timeout is unavailable, not an uncertain decision', async () => {
    setJevSystemOneProviderForTests(() => Promise.resolve(new Response(new ReadableStream())));
    expect(await rejectionOf(moderateGptInput(undefined, evidence, signal()))).toMatchObject({ kind: 'moderation-unavailable' });
  }, 15_000);

  test('checks the exact request instructions and text before GPT, excluding image bytes', async () => {
    const calls: string[] = [];
    let state: unknown;
    setJevSystemOneProviderForTests((_url, init) => {
      calls.push('jev');
      if (typeof init.body !== 'string') throw new Error('Expected a JSON request');
      state = (JSON.parse(init.body) as { state: unknown }).state;
      return Promise.resolve(decision(0.5, 0.5));
    });
    globalThis.fetch = mock(() => {
      calls.push('gpt');
      return Promise.resolve(okStream());
    }) as unknown as typeof fetch;
    const provider = seededText('gpt');
    await collect(provider.enhance('original input', [{ bytes: new Uint8Array([1, 2]), mime: 'image/png' }], signal(), 'exact instructions'));
    expect(calls).toEqual(['jev', 'gpt']);
    expect(state).toEqual({ task: 'text-generation', instructions: 'exact instructions', input: ['original input'] });
  });

  test('every GPT text entry point stops before GPT when denied', async () => {
    setJevSystemOneProviderForTests(() => Promise.resolve(decision(0.95)));
    const network = mock(() => { throw new Error('GPT must not receive blocked input'); });
    globalThis.fetch = network as unknown as typeof fetch;
    const provider = seededText('gpt');
    const results = [
      ...(await collect(provider.enhance('input', [], signal()))),
      ...(await collect(provider.brainstormCharacters({ modelId: 'gpt-image-2.5-sunburst', count: 1, brief: 'input' }, signal()))),
      await provider.aiFill({ systemPrompt: 'instructions', userContent: 'input' }, signal()),
      await provider.draftList({ name: 'L', existing: [], target: 1 }, signal()),
      await provider.draftTemplate({ name: 'T', existingBody: '', library: { lists: [] } }, signal()),
      await provider.inferDimensions('{}', signal()),
      await provider.inferTaxonomy('{}', signal()),
      await provider.inferDimensionsSingleAttempt('{}', signal()),
      await provider.rescueDimension({ previewSnapshot: { dimensions: [], lists: [] }, templateLists: [], targetListName: 'L', conflictReason: 'input' }, signal()),
    ];
    expect(results).toHaveLength(9);
    for (const result of results) expect(result).toMatchObject({ type: 'failed', kind: 'moderation-blocked', moderation: { reason: 'sexual-age', target: 'text' } });
    expect(network).not.toHaveBeenCalled();
  });

  test('adult nudity reaches JEV with the expanded policy and stops image and text before GPT', async () => {
    const inputs: unknown[] = [];
    setJevSystemOneProviderForTests((_url, init) => {
      if (typeof init.body !== 'string') throw new Error('Expected a JSON request');
      const request = JSON.parse(init.body) as { state: unknown; questions: Record<string, { criteria: { true: string; false: string } }> };
      inputs.push(request.state);
      const policy = request.questions.explicit_nudity;
      expect(policy?.criteria.true).toContain('even when every subject is an adult');
      expect(policy?.criteria.false).toContain('Establishing adulthood never exempts explicit nudity');
      return Promise.resolve(decision(0.01, 0.01, 0.99));
    });
    const network = mock(() => { throw new Error('GPT must not receive explicit nudity'); });
    globalThis.fetch = network as unknown as typeof fetch;
    const prompt = 'nude selfie of an adult woman';
    const image = createCliproxyProvider({ baseUrl: 'https://gpt.test', token: 'test', maxResponseBytes: 10_000 });
    expect(await collect(image.generate({ prompt, modelId: image.id, ratio: '1:1', tileIndex: 0, seed: 1 }, signal())))
      .toMatchObject([{ status: 'failed', error: { moderation: { reason: 'sexual-age', categories: ['nudity'], target: 'image' } } }]);
    const text = seededText('gpt');
    expect(await collect(text.enhance(prompt, [], signal())))
      .toMatchObject([{ type: 'failed', kind: 'moderation-blocked', moderation: { reason: 'sexual-age', categories: ['nudity'], target: 'text' } }]);
    expect(inputs).toMatchObject([{ task: 'image-generation', input: prompt }, { task: 'text-generation', input: prompt }]);
    expect(network).not.toHaveBeenCalled();
  });

  test('both image generation and reference edits stop before GPT', async () => {
    setJevSystemOneProviderForTests(() => Promise.resolve(decision(0.01, 0.9)));
    const network = mock(() => { throw new Error('GPT must not receive blocked input'); });
    globalThis.fetch = network as unknown as typeof fetch;
    const provider = createCliproxyProvider({ baseUrl: 'https://gpt.test', token: 'test', maxResponseBytes: 10_000 });
    for (const refs of [[], [{ bytes: new Uint8Array([1]), mime: 'image/png' as const }]]) {
      const results = await collect(provider.generate({ prompt: 'input', modelId: provider.id, ratio: '1:1', tileIndex: 0, seed: 1, refImages: refs }, signal()));
      expect(results).toMatchObject([{ status: 'failed', index: 0, error: { moderation: { reason: 'graphic-violence', target: 'image' }, reason: { kind: 'policy' } } }]);
    }
    expect(network).not.toHaveBeenCalled();
  });

  test('non-GPT text never calls JEV', async () => {
    const jev = mock(() => Promise.resolve(decision(1, 1)));
    setJevSystemOneProviderForTests(jev);
    globalThis.fetch = mock(() => Promise.resolve(okStream())) as unknown as typeof fetch;
    for (const key of ['kimi', 'mimo', 'grok', 'gemini-argon', 'deepseek-abliterated', 'glm-abliterated'] as const) {
      const provider = seededText(key, 'https://text.test');
      expect(await collect(provider.enhance('input', [], signal()))).toMatchObject([{ type: 'delta' }, { type: 'done' }]);
    }
    expect(jev).not.toHaveBeenCalled();
  });
});

describe('per-model screening (screenRequests)', () => {
  const textEvidence = { task: 'text-generation' as const, input: 'A landscape' };
  // Two models on the same provider row ('prov-test'); only one is screened.
  const screened = genericTextModel('house-gpt', { displayName: 'House GPT', screenRequests: true });
  const sibling = genericTextModel('house-open', { displayName: 'House Open', screenRequests: false });

  function okUpstream(): ReturnType<typeof mock> {
    const upstream = mock(() => Promise.resolve(new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )));
    globalThis.fetch = Object.assign(upstream, { preconnect: originalFetch.preconnect });
    return upstream;
  }

  test('text notices carry the screened model label; image notices never do', async () => {
    setJevSystemOneProviderForTests(() => Promise.resolve(decision(0.95)));
    expect(await rejectionOf(moderateGptInput(undefined, textEvidence, signal(), { modelLabel: 'House GPT' }))).toMatchObject({
      kind: 'moderation-blocked', status: 422, moderation: { reason: 'sexual-age', target: 'text', modelLabel: 'House GPT' },
    });
    setJevSystemOneProviderForTests(() => Promise.resolve(new Response('', { status: 500 })));
    expect(await rejectionOf(moderateGptInput(undefined, textEvidence, signal(), { modelLabel: 'House GPT' }))).toMatchObject({
      kind: 'moderation-unavailable', status: 503, moderation: { reason: 'unavailable', target: 'text', modelLabel: 'House GPT' },
    });
    const image = await rejectionOf(moderateGptInput(undefined, evidence, signal(), { modelLabel: 'House GPT' }));
    expect((image as { moderation: object }).moderation).not.toHaveProperty('modelLabel');
  });

  test('text messages name the screened model, never GPT; image messages keep the GPT wording', async () => {
    const messageOf = async (task: 'text' | 'image', blocked: boolean, options: { modelLabel?: string } = {}) => {
      setJevSystemOneProviderForTests(() => Promise.resolve(blocked ? decision(0.95) : new Response('', { status: 500 })));
      return ((await rejectionOf(moderateGptInput(undefined, task === 'text' ? textEvidence : evidence, signal(), options))) as Error).message;
    };
    expect(await messageOf('text', true, { modelLabel: 'Kimi K3' }))
      .toBe('Atelier blocked this request under its content policy. Nothing was sent to Kimi K3.');
    expect(await messageOf('text', false, { modelLabel: 'Kimi K3' }))
      .toBe('Atelier could not check this request. Nothing was sent to Kimi K3. Please try again.');
    expect(await messageOf('text', true)).toBe('Atelier blocked this request under its content policy. Nothing was sent to the text model.');
    expect(await messageOf('image', true, { modelLabel: 'Kimi K3' })).toBe('Atelier blocked this request under its GPT content policy.');
    expect(await messageOf('image', false)).toBe('Atelier could not check this request. Nothing was sent to GPT. Please try again.');
  });

  test('the screened model is checked and blocked, naming itself', async () => {
    const upstream = okUpstream();
    setJevSystemOneProviderForTests(() => Promise.resolve(decision(0.95)));
    const provider = testTextModelProvider({ origin: 'http://x', model: screened, moderation: { openrouterApiKey: 'or-key' } });
    expect(await collect(provider.enhance('input', [], signal()))).toEqual([{
      type: 'failed', kind: 'moderation-blocked', status: 422,
      detail: 'Atelier blocked this request under its content policy. Nothing was sent to House GPT.',
      moderation: { reason: 'sexual-age', categories: ['sexual-age'], target: 'text', modelLabel: 'House GPT' },
    }]);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('a screened model fails closed (503) without a moderation key, naming itself', async () => {
    const upstream = okUpstream();
    const provider = testTextModelProvider({ origin: 'http://x', model: screened, moderation: { openrouterApiKey: undefined } });
    expect(await provider.aiFill({ systemPrompt: 's', userContent: 'u' }, signal())).toMatchObject({
      type: 'failed', kind: 'moderation-unavailable', status: 503,
      moderation: { reason: 'unavailable', target: 'text', modelLabel: 'House GPT' },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  test('an unscreened sibling on the same provider is never checked', async () => {
    const upstream = okUpstream();
    const jev = mock(() => Promise.resolve(decision(1, 1, 1)));
    setJevSystemOneProviderForTests(jev);
    const provider = testTextModelProvider({ origin: 'http://x', model: sibling, moderation: { openrouterApiKey: 'or-key' } });
    expect((await collect(provider.enhance('input', [], signal()))).at(-1)).toEqual({ type: 'done' });
    expect(jev).not.toHaveBeenCalled();
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
