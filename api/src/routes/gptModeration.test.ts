import { afterEach, expect, mock, test } from 'bun:test';
import { setTextModelProviderForTests } from '../providers/text/registry';
import { generateEvents, jsonRequest, parseSse, testRuntime } from '../test/helpers';
import { setJevSystemOneProviderForTests } from '../providers/jevSystemOne';
import type { GptModerationCategory } from '@atelier/shared';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setJevSystemOneProviderForTests(null);
  setTextModelProviderForTests(null);
});

function blockCategories(categories: readonly GptModerationCategory[]) {
  setJevSystemOneProviderForTests(() => Promise.resolve(Response.json({ answers: {
    explicit_nudity: { type: 'noul', noul: categories.includes('nudity') ? 0.99 : 0.01 },
    sexual_minor_or_unknown_age: { type: 'noul', noul: categories.includes('sexual-age') ? 0.99 : 0.01 },
    graphic_violence: { type: 'noul', noul: categories.includes('graphic-violence') ? 0.99 : 0.01 },
  } })));
  const network = mock(() => { throw new Error('unexpected GPT call'); });
  globalThis.fetch = network as unknown as typeof fetch;
  return network;
}

test.each([
  [['nudity'], 'sexual-age'],
  [['sexual-age'], 'sexual-age'],
  [['graphic-violence'], 'graphic-violence'],
  [['nudity', 'sexual-age'], 'sexual-age'],
  [['nudity', 'graphic-violence'], 'sexual-age-and-violence'],
  [['sexual-age', 'graphic-violence'], 'sexual-age-and-violence'],
  [['nudity', 'sexual-age', 'graphic-violence'], 'sexual-age-and-violence'],
] as const)('image categories %j survive SSE, history, replay and SQLite', async (categories, reason) => {
  const runtime = testRuntime({ seedLegacyText: true, ENABLE_MOCK_PROVIDER: 'false' });
  const network = blockCategories(categories);
  const frames = await generateEvents(runtime.app, {
    prompt: 'moderation fixture', modelId: 'gpt-image-2.5-sunburst', ratio: '1:1', count: 1, seed: 1,
  });
  const notice = { reason, categories: [...categories], target: 'image' };
  expect(frames.find((frame) => frame.event === 'tile')?.data).toMatchObject({ status: 'failed', moderation: notice });
  expect(frames.at(-1)?.event).toBe('done');
  const history = await runtime.fetch('/api/history', { headers: { 'Remote-User': 'test' } });
  const body = await history.json() as { items: { tiles: unknown[] }[] };
  expect(body.items[0]?.tiles[0]).toMatchObject({ status: 'failed', moderation: notice });
  const batchId = (frames.find((frame) => frame.event === 'batch')?.data as { batchId: string }).batchId;
  const replay = await parseSse(await runtime.fetch(`/api/batches/${batchId}/events`, { headers: { 'Remote-User': 'test' } }));
  expect(replay.find((frame) => frame.event === 'tile')?.data).toMatchObject({ status: 'failed', moderation: notice });
  expect(runtime.db.query('SELECT moderation_reason, moderation_categories FROM tiles').get()).toEqual({ moderation_reason: reason, moderation_categories: JSON.stringify(categories) });
  expect(network).not.toHaveBeenCalled();
});

test('enhance reports the local block as a terminal SSE error before any GPT call', async () => {
  const runtime = testRuntime({ seedLegacyText: true, ENABLE_MOCK_PROVIDER: 'false' });
  const network = blockCategories(['nudity']);
  const response = await jsonRequest(runtime.app, '/api/enhance-prompt', { prompt: 'moderation fixture', modelId: 'gpt-image-2.5-sunburst' });
  const frames = await parseSse(response);
  expect(frames.find((frame) => frame.event === 'error')?.data).toMatchObject({
    code: 'moderation-blocked', moderation: { reason: 'sexual-age', categories: ['nudity'], target: 'text' },
  });
  expect(frames.some((frame) => frame.event === 'delta')).toBe(false);
  expect(network).not.toHaveBeenCalled();
});
