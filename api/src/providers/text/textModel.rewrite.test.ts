import { afterEach, describe, expect, test } from 'bun:test';
import { restoreFetch } from '../../test/helpers';
import { genericTextModel, testTextModelProvider } from '../../test/textModelProvider';

// `rewrite` accumulates a whole answer inside its policy, so a transient
// mid-stream fault is retried before any text reaches the caller, unlike
// `enhance`, whose deltas are already out.

afterEach(() => { restoreFetch(); });

const encoder = new TextEncoder();

function frame(value: unknown): string {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
}

function delta(text: string): string {
  return frame({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
}

function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** One delta, then the socket drops. */
function droppedAfterFirstDelta(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(delta('half')));
      controller.error(new TypeError('connection reset'));
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function completed(text: string): Response {
  return sse(delta(text) + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + frame('[DONE]'));
}

function scripted(responses: (() => Response)[]): { calls: () => number } {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(() => {
    const next = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    if (next === undefined) throw new Error('no scripted response');
    return Promise.resolve(next());
  }, { preconnect: original.preconnect });
  return { calls: () => calls };
}

function provider() {
  return testTextModelProvider({ origin: 'http://x', token: 't', model: genericTextModel('m') });
}

describe('textModel.rewrite', () => {
  test('a stream that drops after the first delta is retried once and succeeds', async () => {
    const upstream = scripted([droppedAfterFirstDelta, () => completed('a whole rewrite')]);
    const result = await provider().rewrite({ prompt: 'a fox' }, new AbortController().signal);
    expect(result).toEqual({ type: 'ok', text: 'a whole rewrite' });
    expect(upstream.calls()).toBe(2);
  });

  test('a stream that drops on both attempts fails transient after two attempts', async () => {
    const upstream = scripted([droppedAfterFirstDelta]);
    const result = await provider().rewrite({ prompt: 'a fox' }, new AbortController().signal);
    expect(result).toMatchObject({ type: 'failed', kind: 'transient' });
    expect(upstream.calls()).toBe(2);
  });

  test('a quota frame returns kind quota without a retry', async () => {
    const upstream = scripted([() => sse(frame({ error: { message: 'You exceeded your usage limit' } }) + frame('[DONE]'))]);
    const result = await provider().rewrite({ prompt: 'a fox' }, new AbortController().signal);
    expect(result).toMatchObject({ type: 'failed', kind: 'quota' });
    expect(upstream.calls()).toBe(1);
  });

  test('a length finish maps as enhance maps it: permanent, detail length, no retry', async () => {
    const upstream = scripted([() => sse(delta('cut') + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }) + frame('[DONE]'))]);
    const result = await provider().rewrite({ prompt: 'a fox' }, new AbortController().signal);
    expect(result).toEqual({ type: 'failed', kind: 'permanent', status: null, detail: 'length' });
    expect(upstream.calls()).toBe(1);
  });

  test('an aborted caller signal rejects with the abort reason', async () => {
    scripted([() => completed('never read')]);
    const controller = new AbortController();
    const reason = new Error('caller gone');
    controller.abort(reason);
    let caught: unknown;
    try {
      await provider().rewrite({ prompt: 'a fox' }, controller.signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });

  test('sends the system prompt, budget, images and response format it is given', async () => {
    let body: Record<string, unknown> = {};
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign((_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      return Promise.resolve(completed('{"a":1}'));
    }, { preconnect: original.preconnect });
    const result = await provider().rewrite({
      prompt: 'a fox',
      systemPrompt: 'rewrite system',
      images: [{ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }],
      responseFormat: 'json_object',
      maxOutputTokens: 1234,
    }, new AbortController().signal);
    expect(result).toEqual({ type: 'ok', text: '{"a":1}' });
    expect(body).toMatchObject({
      stream: true,
      max_completion_tokens: 1234,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'rewrite system' },
        { role: 'user', content: [{ type: 'text', text: 'a fox' }, { type: 'image_url' }] },
      ],
    });
    // No Anthropic cache marker leaks onto the OpenAI-compatible wire.
    expect((body.messages as unknown[])[0]).toEqual({ role: 'system', content: 'rewrite system' });
  });
});
