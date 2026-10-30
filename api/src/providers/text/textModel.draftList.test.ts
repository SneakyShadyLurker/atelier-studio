import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { restoreFetch } from '../../test/helpers';
import { seededTextModel, testTextModelProvider } from '../../test/textModelProvider';

const servers: Bun.Server<unknown>[] = [];
beforeEach(() => { restoreFetch(); });
afterEach(async () => {
  restoreFetch();
  await Promise.all(servers.splice(0).map((s) => s.stop(true)));
});
function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
function chatSse(frames: readonly string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
function contentFrames(text: string): string[] {
  return [
    JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ];
}
function provider(baseUrl: string) {
  return testTextModelProvider({ origin: baseUrl, token: 'sk-x', model: seededTextModel('kimi', { modelId: 'kimi-latest' }), maxResponseBytes: 1_000_000 });
}

describe('textModel.draftList', () => {
  test('parses an entries payload', async () => {
    let body: Record<string, unknown> = {};
    const up = serve(async (request) => {
      body = (await request.json()) as Record<string, unknown>;
      return chatSse(contentFrames(JSON.stringify({ kind: 'entries', entries: ['red', 'blue'] })));
    });
    const r = await provider(up).draftList({ name: 'Colours', existing: [], target: 20 }, new AbortController().signal);
    expect(r).toEqual({ type: 'ok', payload: { kind: 'entries', entries: ['red', 'blue'] } });
    expect(body).toMatchObject({
      model: 'kimi-latest',
      reasoning_effort: 'low',
      max_completion_tokens: 5200,
      response_format: { type: 'json_object' },
    });
    expect(body).not.toHaveProperty('verbosity');
  });

  test('parses a clarify payload', async () => {
    const up = serve(() => chatSse(contentFrames(JSON.stringify({ kind: 'clarify', question: 'What kind of X?' }))));
    const r = await provider(up).draftList({ name: 'X', existing: [], target: 20 }, new AbortController().signal);
    expect(r).toEqual({ type: 'ok', payload: { kind: 'clarify', question: 'What kind of X?' } });
  });

  test('strips code fences before parsing', async () => {
    const fenced = '```json\n' + JSON.stringify({ kind: 'entries', entries: ['a'] }) + '\n```';
    const up = serve(() => chatSse(contentFrames(fenced)));
    const r = await provider(up).draftList({ name: 'L', existing: [], target: 20 }, new AbortController().signal);
    expect(r).toEqual({ type: 'ok', payload: { kind: 'entries', entries: ['a'] } });
  });

  test('strips fences even when the model appends trailing prose', async () => {
    const fenced = '```json\n' + JSON.stringify({ kind: 'entries', entries: ['a'] }) + '\n```\nHere you go!';
    const up = serve(() => chatSse(contentFrames(fenced)));
    const r = await provider(up).draftList({ name: 'L', existing: [], target: 20 }, new AbortController().signal);
    expect(r).toEqual({ type: 'ok', payload: { kind: 'entries', entries: ['a'] } });
  });

  test('in-stream error frame -> failed', async () => {
    const up = serve(() => chatSse([JSON.stringify({ error: { message: 'mid-stream boom' } }), '[DONE]']));
    const r = await provider(up).draftList({ name: 'L', existing: [], target: 20 }, new AbortController().signal);
    expect(r.type).toBe('failed');
  });

  test('unparseable content -> failed', async () => {
    const up = serve(() => chatSse(contentFrames('not json at all')));
    const r = await provider(up).draftList({ name: 'L', existing: [], target: 20 }, new AbortController().signal);
    expect(r.type).toBe('failed');
  });

  test('upstream non-200 -> failed with status', async () => {
    const up = serve(() => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }));
    const r = await provider(up).draftList({ name: 'L', existing: [], target: 20 }, new AbortController().signal);
    expect(r).toMatchObject({ type: 'failed', status: 500 });
  });

  test('parses fenced JSON whose entry values contain triple backticks', async () => {
    const payload = { kind: 'entries', entries: ['```js', 'plain'] };
    const fenced = '```json\n' + JSON.stringify(payload) + '\n```';
    const up = serve(() => chatSse(contentFrames(fenced)));
    const r = await provider(up).draftList({ name: 'Code snippets', existing: [], target: 20 }, new AbortController().signal);
    expect(r).toEqual({ type: 'ok', payload: { kind: 'entries', entries: ['```js', 'plain'] } });
  });

  test('oversize response -> failed', async () => {
    const huge = JSON.stringify({ kind: 'entries', entries: [' '.repeat(4000)] });
    const up = serve(() => chatSse(contentFrames(huge)));
    const p = testTextModelProvider({ origin: up, token: 'sk-x', model: seededTextModel('kimi', { modelId: 'kimi-latest' }), maxResponseBytes: 256 });
    const r = await p.draftList({ name: 'L', existing: [], target: 20 }, new AbortController().signal);
    expect(r.type).toBe('failed');
  });
});
