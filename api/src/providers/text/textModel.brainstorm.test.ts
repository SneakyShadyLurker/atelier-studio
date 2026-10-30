import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type BrainstormChunk } from '../cliproxyText';
import {
  BRAINSTORM_RECORD_SEPARATOR,
  BRAINSTORM_FIELD_SEPARATOR,
  BRAINSTORM_CONSTRAINTS_GPT,
} from '../../prompts/brainstormCharactersSystemPrompt';
import { restoreFetch } from '../../test/helpers';
import { seededTextModel, testTextModelProvider } from '../../test/textModelProvider';

const RS = BRAINSTORM_RECORD_SEPARATOR;
const FS = BRAINSTORM_FIELD_SEPARATOR;

const rec = (scene: string, subject: string, details: string): string =>
  `${scene}\n${FS}\n${subject}\n${FS}\n${details}`;

// These suites drive brainstormCharacters with modelId 'gpt-image-2.5-sunburst', so the
// provider assembles with the GPT (anatomy-safe) constraints variant.
const assembled = (scene: string, subject: string, details: string): string =>
  `Scene / Image type: ${scene}\nSubject: ${subject}\nDetails: ${details}\n${BRAINSTORM_CONSTRAINTS_GPT}`;

const servers: Bun.Server<unknown>[] = [];

beforeEach(() => {
  restoreFetch();
});

afterEach(async () => {
  restoreFetch();
  await Promise.all(servers.splice(0).map((s) => s.stop(true)));
});

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function chatSse(text: string): Response {
  const frame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;
  return new Response(`${frame}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function provider(baseUrl: string) {
  return testTextModelProvider({ origin: baseUrl, token: 'sk-test', model: seededTextModel('kimi', { modelId: 'kimi-latest' }), maxResponseBytes: 1_000_000 });
}

describe('brainstormCharacters', () => {
  for (const reason of [undefined, 'length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource']) {
    test(`preserves complete prior records and rejects an unterminated tail on ${reason ?? 'EOF'}`, async () => {
      const text = `${rec('scene1', 'subject1', 'details1')}\n${RS}\n${rec('scene2', 'subject2', 'partial details')}`;
      const data = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: reason }] });
      const baseUrl = serve(() => new Response(`data: ${data}\n\n${reason === undefined ? '' : 'data: [DONE]\n\n'}`));
      const chunks: BrainstormChunk[] = [];
      for await (const chunk of provider(baseUrl).brainstormCharacters(
        { count: 2, modelId: 'gpt-image-2.5-sunburst' }, new AbortController().signal,
      )) chunks.push(chunk);
      expect(chunks.filter((chunk) => chunk.type === 'prompt')).toEqual([
        { type: 'prompt', index: 0, text: assembled('scene1', 'subject1', 'details1') },
      ]);
      expect(chunks.at(-1)).toMatchObject({ type: 'failed' });
      expect(chunks.some((chunk) => chunk.type === 'done')).toBe(false);
    });
  }
  test('fulfilling the requested full record count succeeds without needing an EOF terminal', async () => {
    const data = JSON.stringify({ choices: [{ delta: { content: `${rec('scene', 'subject', 'details')}\n${RS}\n` } }] });
    const baseUrl = serve(() => new Response(`data: ${data}\n\n`));
    const chunks: BrainstormChunk[] = [];
    for await (const chunk of provider(baseUrl).brainstormCharacters(
      { count: 1, modelId: 'gpt-image-2.5-sunburst' }, new AbortController().signal,
    )) chunks.push(chunk);
    expect(chunks.at(-1)).toEqual({ type: 'done', count: 1 });
  });

  test('splits records and assembles each into the labeled scaffold + constraints', async () => {
    const out = `${rec('s1', 'u1', 'd1')}\n${RS}\n${rec('s2', 'u2', 'd2')}\n${RS}\n`;
    const baseUrl = serve(() => chatSse(out));
    const chunks: { type: string; index?: number; text?: string; count?: number }[] = [];
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 5, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      chunks.push(c);
    }
    const prompts = chunks.filter((c) => c.type === 'prompt');
    expect(prompts.map((p) => p.text)).toEqual([assembled('s1', 'u1', 'd1'), assembled('s2', 'u2', 'd2')]);
    expect(prompts.map((p) => p.index)).toEqual([0, 1]);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', count: 2 });
  });

  test('caps emitted prompts at count', async () => {
    const out = [rec('a', 'a', 'a'), rec('b', 'b', 'b'), rec('c', 'c', 'c')]
      .map((r) => `${r}\n${RS}\n`)
      .join('');
    const baseUrl = serve(() => chatSse(out));
    const prompts: string[] = [];
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 2, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      if (c.type === 'prompt') prompts.push(c.text);
    }
    expect(prompts).toEqual([assembled('a', 'a', 'a'), assembled('b', 'b', 'b')]);
  });

  test('emits the final record (assembled) when the model omits the trailing separator', async () => {
    const out = `${rec('s1', 'u1', 'd1')}\n${RS}\n${rec('s2', 'u2', 'd2')}`;
    const baseUrl = serve(() => chatSse(out));
    const chunks: { type: string; index?: number; text?: string; count?: number }[] = [];
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 5, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      chunks.push(c);
    }
    const prompts = chunks.filter((c) => c.type === 'prompt');
    expect(prompts.map((p) => p.text)).toEqual([assembled('s1', 'u1', 'd1'), assembled('s2', 'u2', 'd2')]);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', count: 2 });
  });

  test('count=1 with no separator yields the single assembled prompt, not zero', async () => {
    const out = rec('lone scene', 'lone subject', 'lone details');
    const baseUrl = serve(() => chatSse(out));
    const chunks: { type: string; text?: string; count?: number }[] = [];
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 1, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      chunks.push(c);
    }
    expect(chunks.filter((c) => c.type === 'prompt').map((p) => p.text)).toEqual([
      assembled('lone scene', 'lone subject', 'lone details'),
    ]);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', count: 1 });
  });

  test('does not exceed count when a trailing record follows the cap', async () => {
    const out = `${rec('a', 'a', 'a')}\n${RS}\n${rec('b', 'b', 'b')}\n${RS}\n${rec('c', 'c', 'c')}`;
    const baseUrl = serve(() => chatSse(out));
    const prompts: string[] = [];
    let doneCount = -1;
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 2, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      if (c.type === 'prompt') prompts.push(c.text);
      if (c.type === 'done') doneCount = c.count;
    }
    expect(prompts).toEqual([assembled('a', 'a', 'a'), assembled('b', 'b', 'b')]);
    expect(doneCount).toBe(2);
  });

  test('skips a record with no usable field content (separators/whitespace only)', async () => {
    // A non-empty-but-contentless record must not be promoted to a
    // constraints-only prompt or counted toward done.
    const out = `${FS}\n${FS}\n${RS}\n${rec('s', 'u', 'd')}\n${RS}\n`;
    const baseUrl = serve(() => chatSse(out));
    const chunks: { type: string; index?: number; text?: string; count?: number }[] = [];
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 5, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      chunks.push(c);
    }
    const prompts = chunks.filter((c) => c.type === 'prompt');
    expect(prompts.map((p) => p.text)).toEqual([assembled('s', 'u', 'd')]);
    expect(prompts.map((p) => p.index)).toEqual([0]);
    expect(chunks.at(-1)).toMatchObject({ type: 'done', count: 1 });
  });

  test('skips a malformed record and still emits later well-formed records', async () => {
    const out = `a malformed record with no field separators\n${RS}\n${rec('valid scene', 'valid subject', 'valid details')}\n${RS}\n`;
    const baseUrl = serve(() => chatSse(out));
    const chunks: BrainstormChunk[] = [];
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 5, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      chunks.push(c);
    }
    expect(chunks).toEqual([
      { type: 'prompt', index: 0, text: assembled('valid scene', 'valid subject', 'valid details') },
      { type: 'done', count: 1 },
    ]);
  });

  test('emits a four-field record with every extra field merged under Details', async () => {
    const out = `scene${FS}subject${FS}detail one${FS}detail two\n${RS}\n`;
    const baseUrl = serve(() => chatSse(out));
    const chunks: BrainstormChunk[] = [];
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 1, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      chunks.push(c);
    }

    expect(chunks).toEqual([
      {
        type: 'prompt',
        index: 0,
        text: assembled('scene', 'subject', 'detail one\ndetail two'),
      },
      { type: 'done', count: 1 },
    ]);
  });

  test('salvages a two-field record when the clean stream has no valid record', async () => {
    const out = `scene${FS}subject\n${RS}\n`;
    const baseUrl = serve(() => chatSse(out));
    const chunks: BrainstormChunk[] = [];
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 1, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      chunks.push(c);
    }

    expect(chunks).toEqual([
      { type: 'prompt', index: 0, text: `scene. subject\n${BRAINSTORM_CONSTRAINTS_GPT}` },
      { type: 'done', count: 1 },
    ]);
  });

  test('salvages a complete zero-separator tail instead of failing the run', async () => {
    const out = 'a complete ready-to-render character image prompt';
    const baseUrl = serve(() => chatSse(out));
    const chunks: BrainstormChunk[] = [];
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 1, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      chunks.push(c);
    }

    expect(chunks).toEqual([
      {
        type: 'prompt',
        index: 0,
        text: `a complete ready-to-render character image prompt\n${BRAINSTORM_CONSTRAINTS_GPT}`,
      },
      { type: 'done', count: 1 },
    ]);
  });

  test('caps deferred short-record salvage at the requested count', async () => {
    const out = `first complete prose\n${RS}\nsecond complete prose\n${RS}\nthird complete prose\n${RS}\n`;
    const baseUrl = serve(() => chatSse(out));
    const chunks: BrainstormChunk[] = [];
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 1, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      chunks.push(c);
    }

    expect(chunks).toEqual([
      { type: 'prompt', index: 0, text: `first complete prose\n${BRAINSTORM_CONSTRAINTS_GPT}` },
      { type: 'done', count: 1 },
    ]);
  });

  test('classifies a provider content-filter error frame as a refusal', async () => {
    const baseUrl = serve(() => new Response(
      'event: error\ndata: {"error":{"message":"request was considered high risk"}}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ));
    const chunks: BrainstormChunk[] = [];
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 1, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{
      type: 'failed',
      kind: 'content-filter',
      status: null,
      detail: '{"message":"request was considered high risk"}',
    }]);
  });

  test('classifies an HTTP content-filter response as a refusal', async () => {
    const baseUrl = serve(() => Response.json(
      { error: { message: 'content_filter' } },
      { status: 400 },
    ));
    const chunks: BrainstormChunk[] = [];
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 1, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'failed', kind: 'content-filter' });
  });

  test('rejects refusal prose even when it imitates the three-field shape', async () => {
    const refusal = rec(
      'I can’t fulfill this request.',
      'I cannot create sexualized content involving a minor.',
      'I won’t write an image prompt for it.',
    );
    const baseUrl = serve(() => chatSse(`${refusal}\n${RS}\n`));
    const chunks: BrainstormChunk[] = [];
    for await (const c of provider(baseUrl).brainstormCharacters(
      { count: 1, modelId: 'gpt-image-2.5-sunburst' },
      new AbortController().signal,
    )) {
      chunks.push(c);
    }
    expect(chunks).toEqual([{
      type: 'failed',
      kind: 'content-filter',
      status: null,
      detail: 'brainstorm output did not satisfy the prompt contract',
    }]);
  });
});
