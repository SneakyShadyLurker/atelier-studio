import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../../db/migrate';
import { createTextProviderStore, type TextProviderStore } from '../../db/textProviders';
import { createTextSecretsForKey } from '../../keystore/instanceSecrets';
import { testConfig } from '../../test/helpers';
import { setTextModelProviderForTests, TextModelNotFoundError, textModelProviderFor } from './registry';

// Spec § 5.5: one cached feature provider per model row, rebuilt when the
// text config revision moves; the test override wins.

let server: ReturnType<typeof Bun.serve>;
let origin = '';
const seen: { authorization: string | null; body: Record<string, unknown> }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      seen.push({ authorization: req.headers.get('authorization'), body: await req.json() as Record<string, unknown> });
      const frame = JSON.stringify({ choices: [{ index: 0, delta: { content: '{"kind":"entries","entries":["navy"]}' }, finish_reason: 'stop' }] });
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  void server.stop(true);
});

afterEach(() => {
  setTextModelProviderForTests(null);
});

async function setup(): Promise<{ store: TextProviderStore; modelRowId: string }> {
  const db = new Database(':memory:');
  migrate(db, mkdtempSync(join(tmpdir(), 'atelier-text-registry-')));
  const secrets = createTextSecretsForKey('e'.repeat(64));
  if (secrets === undefined) throw new Error('no secrets');
  const store = createTextProviderStore({ db, secrets });
  const provider = await store.createProvider({
    name: 'Local',
    protocol: 'openai-compatible',
    baseUrl: `${origin}/v1`,
    apiKey: 'sk-stored-key',
  });
  const [model] = store.createModels(provider.id, [{ modelId: 'local-model', reasoningLevels: ['low', 'high'], reasoningDefault: 'low' }]);
  if (model === undefined) throw new Error('model not created');
  return { store, modelRowId: model.id };
}

describe('textModelProviderFor', () => {
  test('the same row twice is the same instance', async () => {
    const config = testConfig();
    const { store, modelRowId } = await setup();
    expect(textModelProviderFor(config, store, modelRowId)).toBe(textModelProviderFor(config, store, modelRowId));
  });

  test('a revision bump builds a new instance with the edited row', async () => {
    const config = testConfig();
    const { store, modelRowId } = await setup();
    const before = textModelProviderFor(config, store, modelRowId);
    store.updateModel(modelRowId, { fixedOutputTokens: 1234 });
    const after = textModelProviderFor(config, store, modelRowId);
    expect(after).not.toBe(before);
    expect(textModelProviderFor(config, store, modelRowId)).toBe(after);

    const result = await after.draftList({ name: 'Colours', existing: [], target: 5 }, new AbortController().signal);
    expect(result).toEqual({ type: 'ok', payload: { kind: 'entries', entries: ['navy'] } });
    const request = seen.at(-1);
    // The stored key is decrypted at use time and the edited row is live.
    expect(request?.authorization).toBe('Bearer sk-stored-key');
    expect(request?.body).toMatchObject({ model: 'local-model', reasoning_effort: 'low', max_completion_tokens: 1234 });
  });

  test('the test override wins over every row', async () => {
    const config = testConfig();
    const { store, modelRowId } = await setup();
    const fake = {
      enhance: async function* () {
        await Promise.resolve();
        yield { type: 'done' as const };
      },
      draftList: () => Promise.resolve({ type: 'failed' as const, status: null, detail: 'fake' }),
      draftTemplate: () => Promise.resolve({ type: 'failed' as const, status: null, detail: 'fake' }),
      inferDimensions: () => Promise.resolve({ type: 'ok' as const, ops: [] }),
      inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok' as const, ops: [] }),
      rescueDimension: () => Promise.resolve({ type: 'ok' as const, ops: [] }),
    };
    setTextModelProviderForTests(fake);
    const provider = textModelProviderFor(config, store, modelRowId);
    expect(await provider.draftList({ name: 'x', existing: [], target: 1 }, new AbortController().signal))
      .toMatchObject({ type: 'failed', detail: 'fake' });
    // Omitted methods are back-filled as the legacy setter did.
    expect(await provider.inferTaxonomy('{}', new AbortController().signal)).toEqual({ type: 'ok', ops: [] });
    expect(await provider.aiFill({ systemPrompt: 's', userContent: 'u' }, new AbortController().signal))
      .toMatchObject({ type: 'failed', detail: 'not implemented' });
    expect(textModelProviderFor(config, store, 'no-such-row')).toBe(provider);
  });

  test('an unknown row id throws', async () => {
    const { store } = await setup();
    expect(() => textModelProviderFor(testConfig(), store, 'no-such-row')).toThrow(TextModelNotFoundError);
  });
});
