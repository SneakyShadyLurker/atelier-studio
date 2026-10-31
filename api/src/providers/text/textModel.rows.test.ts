import { afterEach, describe, expect, test } from 'bun:test';
import { setJevSystemOneProviderForTests } from '../jevSystemOne';
import { restoreFetch } from '../../test/helpers';
import { genericTextModel, seededTextModel, testTextModelProvider } from '../../test/textModelProvider';
import type { EnhanceChunk } from './featureHelpers';
import { GLM_ABLITERATED_MAX_COMPLETION_TOKENS } from './textBudgets';

// Row-driven behaviour the legacy provider keyed on backend names: the JEV
// pre-screen (`screenRequests`), `fixedOutputTokens`, `maxImages`/`vision`,
// sampling, and the pinned-effort byte cap; plus the SDK stream differences
// (malformed chunks) that must not change outcomes.

const sent: Record<string, unknown>[] = [];

afterEach(() => {
  restoreFetch();
  setJevSystemOneProviderForTests(null);
  sent.length = 0;
});

function sseText(text: string, extraFrames = ''): Response {
  const frame = JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] });
  return new Response(`${extraFrames}data: ${frame}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

function fakeUpstream(respond: () => Response = () => sseText('ok')): void {
  globalThis.fetch = Object.assign((_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>);
    return Promise.resolve(respond());
  }, { preconnect: globalThis.fetch.preconnect });
}

async function collect(it: AsyncIterable<EnhanceChunk>): Promise<EnhanceChunk[]> {
  const out: EnhanceChunk[] = [];
  for await (const chunk of it) out.push(chunk);
  return out;
}

const IMAGES = [
  { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' },
  { bytes: new Uint8Array([4, 5, 6]), mime: 'image/jpeg' },
];

describe('request screening (screenRequests)', () => {
  test('a blocked request never reaches the model', async () => {
    fakeUpstream();
    setJevSystemOneProviderForTests(() => Promise.resolve(Response.json({ answers: {
      explicit_nudity: { type: 'noul', noul: 0.99 },
      sexual_minor_or_unknown_age: { type: 'noul', noul: 0.01 },
      graphic_violence: { type: 'noul', noul: 0.01 },
    } })));
    const provider = testTextModelProvider({ origin: 'http://x', model: seededTextModel('gpt'), moderation: { openrouterApiKey: 'or-key' } });
    const chunks = await collect(provider.enhance('x', [], new AbortController().signal));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'failed', kind: 'moderation-blocked', status: 422 });
    expect(await provider.aiFill({ systemPrompt: 's', userContent: 'u' }, new AbortController().signal))
      .toMatchObject({ type: 'failed', kind: 'moderation-blocked' });
    expect(await provider.draftTemplate({ name: 'T', existingBody: '', library: { lists: [] } }, new AbortController().signal))
      .toMatchObject({ type: 'failed', kind: 'moderation-blocked' });
    expect(sent).toHaveLength(0);
  });

  test('an allowed request is screened as text only, then sent', async () => {
    fakeUpstream();
    const states: unknown[] = [];
    setJevSystemOneProviderForTests((_url, init) => {
      states.push(JSON.parse(typeof init.body === 'string' ? init.body : '{}'));
      return Promise.resolve(Response.json({ answers: {
        explicit_nudity: { type: 'noul', noul: 0.01 },
        sexual_minor_or_unknown_age: { type: 'noul', noul: 0.01 },
        graphic_violence: { type: 'noul', noul: 0.01 },
      } }));
    });
    const provider = testTextModelProvider({ origin: 'http://x', model: seededTextModel('gpt'), moderation: { openrouterApiKey: 'or-key' } });
    const chunks = await collect(provider.enhance('describe', IMAGES, new AbortController().signal, 'sys'));
    expect(chunks.at(-1)).toEqual({ type: 'done' });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(states)).not.toContain('data:image');
    expect(states[0]).toMatchObject({ state: { task: 'text-generation', instructions: 'sys', input: ['describe'] } });
  });

  test('rows without screenRequests never call the screen', async () => {
    fakeUpstream();
    let screened = 0;
    setJevSystemOneProviderForTests(() => {
      screened += 1;
      return Promise.resolve(new Response('', { status: 500 }));
    });
    const provider = testTextModelProvider({ origin: 'http://x', model: seededTextModel('kimi') });
    expect((await collect(provider.enhance('x', [], new AbortController().signal))).at(-1)).toEqual({ type: 'done' });
    expect(screened).toBe(0);
  });
});

describe('row capabilities', () => {
  test('fixedOutputTokens replaces every per-task budget; structured output none sends no response_format', async () => {
    fakeUpstream(() => sseText('{"ops":[]}'));
    const provider = testTextModelProvider({ origin: 'http://x', model: seededTextModel('glm-abliterated') });
    await provider.inferDimensions('{}', new AbortController().signal);
    await provider.aiFill({ systemPrompt: 's', userContent: 'u', batchSize: 4 }, new AbortController().signal);
    for (const body of sent) {
      expect(body.max_completion_tokens).toBe(GLM_ABLITERATED_MAX_COMPLETION_TOKENS);
      expect(body).not.toHaveProperty('response_format');
      expect(body.reasoning_effort).toBe('low');
    }
  });

  test('maxImages caps image parts; a text-only row gets none', async () => {
    fakeUpstream();
    await collect(testTextModelProvider({ origin: 'http://x', model: genericTextModel('m', { maxImages: 1 }) })
      .enhance('look', IMAGES, new AbortController().signal));
    await collect(testTextModelProvider({ origin: 'http://x', model: genericTextModel('m', { vision: false }) })
      .enhance('look', IMAGES, new AbortController().signal));
    const userOf = (body: Record<string, unknown> | undefined) => (body?.messages as { role: string; content: unknown }[]).find((m) => m.role === 'user')?.content;
    expect(userOf(sent[0])).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ]);
    expect(userOf(sent[1])).toBe('look');
  });

  test('row sampling is sent; the user effort replaces the default only on rows with levels', async () => {
    fakeUpstream();
    await testTextModelProvider({ origin: 'http://x', model: seededTextModel('grok') })
      .aiFill({ systemPrompt: 's', userContent: 'u', reasoningEffort: 'high' }, new AbortController().signal);
    await testTextModelProvider({ origin: 'http://x', model: seededTextModel('gpt', { screenRequests: false }) })
      .aiFill({ systemPrompt: 's', userContent: 'u', reasoningEffort: 'high' }, new AbortController().signal);
    expect(sent[0]).toMatchObject({ temperature: 0.7, top_p: 0.95, reasoning_effort: 'high' });
    expect(sent[1]).toMatchObject({ reasoning_effort: 'medium' });
    expect(sent[1]).not.toHaveProperty('temperature');
  });

  test('a pinned effort above low widens the byte cap; the default keeps it', async () => {
    const long = 'z'.repeat(5000);
    fakeUpstream(() => sseText(long));
    const provider = testTextModelProvider({ origin: 'http://x', model: seededTextModel('kimi'), maxResponseBytes: 1024 });
    expect((await collect(provider.enhance('x', [], new AbortController().signal, undefined, { reasoningEffort: 'high' }))).at(-1))
      .toEqual({ type: 'done' });
    const capped = await collect(provider.enhance('x', [], new AbortController().signal));
    expect(capped.at(-1)).toMatchObject({ type: 'failed' });
    expect((capped.at(-1) as { detail: string }).detail).toContain('exceeded');
  });
});

describe('SDK stream differences', () => {
  test('an unparseable chunk is skipped, as the legacy reader did', async () => {
    fakeUpstream(() => sseText('fine', 'data: not json\n\n'));
    const provider = testTextModelProvider({ origin: 'http://x', model: seededTextModel('kimi') });
    expect(await collect(provider.enhance('x', [], new AbortController().signal)))
      .toEqual([{ type: 'delta', text: 'fine' }, { type: 'done' }]);
    expect(await provider.aiFill({ systemPrompt: 's', userContent: 'u' }, new AbortController().signal))
      .toEqual({ type: 'ok', text: 'fine' });
  });

  test('a credential that cannot be read is a failure, not a crash', async () => {
    fakeUpstream();
    const broken = testTextModelProvider({
      origin: 'http://x',
      model: seededTextModel('kimi'),
      credential: () => Promise.reject(new Error('BYOK_ENCRYPTION_KEY is not set')),
    });
    expect(await broken.draftList({ name: 'L', existing: [], target: 3 }, new AbortController().signal))
      .toMatchObject({ type: 'failed', detail: 'BYOK_ENCRYPTION_KEY is not set' });
    expect(sent).toHaveLength(0);
  });
});
