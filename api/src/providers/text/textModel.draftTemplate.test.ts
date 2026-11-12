import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { restoreFetch } from '../../test/helpers';
import type { LibraryOverview } from '../../prompts/libraryOverview';
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

function streamed(body: string, finishReason = 'stop'): Response {
  const frames = [
    JSON.stringify({ choices: [{ index: 0, delta: { content: body }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
    '[DONE]',
  ];
  return new Response(frames.map((f) => `data: ${f}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** One delta, then the socket drops mid-stream. */
function droppedAfterFirstDelta(): Response {
  const frame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '{"kind":' }, finish_reason: null }] })}\n\n`;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame));
      controller.error(new TypeError('connection reset'));
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const emptyLibrary: LibraryOverview = { lists: [] };

function provider(baseUrl: string, model = 'kimi-latest') {
  return testTextModelProvider({ origin: baseUrl, token: 'sk-x', model: seededTextModel('kimi', { modelId: model }), maxResponseBytes: 10_000_000 });
}

function knownLibrary(names: string[]): LibraryOverview {
  return {
    lists: names.map((name) => ({ name, optionCount: 1, samples: ['sample'] })),
  };
}

describe('textModel.draftTemplate — request body (model-family mapping)', () => {
  const okPayload = JSON.stringify({ kind: 'body', body: 'ok', warnings: [] });

  for (const reason of ['length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', 'stop']) {
    test(`streamed draft classifies explicit finish_reason ${reason}`, async () => {
      const up = serve(() => streamed(okPayload, reason));
      const result = await provider(up).draftTemplate(
        { name: 'T', existingBody: '', library: emptyLibrary }, new AbortController().signal,
      );
      expect(result.type).toBe(reason === 'stop' ? 'ok' : 'failed');
    });
  }

  test('Kimi provider streams with a strict JSON schema of the two answer shapes', async () => {
    let body: Record<string, unknown> = {};
    const up = serve(async (req) => { body = (await req.json()) as Record<string, unknown>; return streamed(okPayload); });
    await provider(up, 'kimi-latest').draftTemplate(
      { name: 'T', existingBody: '', library: emptyLibrary },
      new AbortController().signal,
    );
    expect(body).toMatchObject({
      model: 'kimi-latest',
      stream: true,
      reasoning_effort: 'low',
      max_completion_tokens: 5500,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'template_draft',
          strict: true,
          schema: { type: 'object', properties: { kind: { enum: ['body', 'clarify'] } } },
        },
      },
    });
    expect(body).not.toHaveProperty('verbosity');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('max_tokens');
  });

  test('a row without structured output sends no response_format', async () => {
    let body: Record<string, unknown> = {};
    const up = serve(async (req) => { body = (await req.json()) as Record<string, unknown>; return streamed(okPayload); });
    const p = testTextModelProvider({ origin: up, token: 'sk-x', model: seededTextModel('kimi', { structuredOutput: 'none' }) });
    const result = await p.draftTemplate({ name: 'T', existingBody: '', library: emptyLibrary }, new AbortController().signal);
    expect(result.type).toBe('ok');
    expect(body).not.toHaveProperty('response_format');
  });

  test('a stream that drops mid-answer is retried through the draft policy', async () => {
    let calls = 0;
    const up = serve(() => (++calls === 1 ? droppedAfterFirstDelta() : streamed(okPayload)));
    const result = await provider(up).draftTemplate({ name: 'T', existingBody: '', library: emptyLibrary }, new AbortController().signal);
    expect(result).toEqual({ type: 'ok', payload: { kind: 'body', body: 'ok', warnings: [] } });
    expect(calls).toBe(2);
  });

  test('a quota 429 returns kind quota with its retry-after', async () => {
    const up = serve(() => new Response(JSON.stringify({ error: { message: 'usage limit reached' } }), {
      status: 429,
      headers: { 'Retry-After': '900' },
    }));
    const result = await provider(up).draftTemplate({ name: 'T', existingBody: '', library: emptyLibrary }, new AbortController().signal);
    expect(result).toMatchObject({ type: 'failed', kind: 'quota', status: 429, retryAfterSeconds: 900 });
  });

  test('a caller abort rejects with the abort reason instead of returning a failure', async () => {
    const up = serve(() => streamed(okPayload));
    const controller = new AbortController();
    const reason = new Error('route deadline');
    controller.abort(reason);
    let caught: unknown;
    try {
      await provider(up).draftTemplate({ name: 'T', existingBody: '', library: emptyLibrary }, controller.signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });

  test('unparseable content fails with a kind', async () => {
    const up = serve(() => streamed('not json at all'));
    const result = await provider(up).draftTemplate({ name: 'T', existingBody: '', library: emptyLibrary }, new AbortController().signal);
    expect(result).toEqual({ type: 'failed', kind: 'transient', status: null, detail: 'unparseable draft response' });
  });
});

describe('textModel.draftTemplate — truncation', () => {
  test('truncation: body longer than MAX_DRAFT_RAW_BODY_CHARS is truncated and warning is emitted', async () => {
    // 2001 code points → triggers the 2000 cap
    const longBody = 'A'.repeat(2001);
    const modelPayload = JSON.stringify({ kind: 'body', body: longBody, warnings: [] });
    const up = serve(() => streamed(modelPayload));
    const r = await provider(up).draftTemplate(
      { name: 'T', existingBody: '', library: emptyLibrary },
      new AbortController().signal,
    );
    expect(r.type).toBe('ok');
    if (r.type === 'ok' && r.payload.kind === 'body') {
      expect(Array.from(r.payload.body).length).toBeLessThanOrEqual(2000);
      expect(r.payload.warnings).toContain('The draft was cut off at the length limit');
    }
  });

  test('truncation: emoji at the 2000-codepoint boundary is not split into an orphan surrogate', async () => {
    // 1999 ASCII chars + one emoji (U+1F305 🌅) + "TAIL" = 2004 code points → cap triggers.
    // UTF-16 .slice(0, 2000) would land between the surrogate pair; Array.from avoids that.
    const prefix = 'A'.repeat(1999);
    const emoji = '\u{1F305}'; // 2 UTF-16 code units, 1 code point
    const longBody = prefix + emoji + 'TAIL';
    const modelPayload = JSON.stringify({ kind: 'body', body: longBody, warnings: [] });
    const up = serve(() => streamed(modelPayload));
    const r = await provider(up).draftTemplate(
      { name: 'T', existingBody: '', library: emptyLibrary },
      new AbortController().signal,
    );
    expect(r.type).toBe('ok');
    if (r.type === 'ok' && r.payload.kind === 'body') {
      // JSON round-trip must be lossless (orphan surrogates get mangled into U+FFFD).
      const roundTripped = JSON.parse(JSON.stringify(r.payload.body)) as string;
      expect(roundTripped).toBe(r.payload.body);
      // Exactly 2000 code points: the emoji fits at index 1999 (the 2000th cp).
      expect(Array.from(r.payload.body).length).toBe(2000);
      // Emoji must be present whole — not replaced by junk or U+FFFD.
      expect(r.payload.body).not.toContain('�');
      expect(r.payload.body).toContain(emoji);
    }
  });

  test('truncation: unclosed {{var:: token at cap boundary is stripped, not left as literal', async () => {
    // 1995 ASCII chars + "{{var::ab" (9 chars) + "TAIL" = 2008 code points.
    // After cap: first 2000 chars = prefix(1995) + "{{var" (5 chars).
    // The mid-token cleanup should strip the dangling "{{var".
    const prefix = 'A'.repeat(1995);
    const partial = '{{var::ab'; // 9 code points; total with "TAIL" = 2008
    const longBody = prefix + partial + 'TAIL';
    const modelPayload = JSON.stringify({ kind: 'body', body: longBody, warnings: [] });
    const up = serve(() => streamed(modelPayload));
    const r = await provider(up).draftTemplate(
      { name: 'T', existingBody: '', library: emptyLibrary },
      new AbortController().signal,
    );
    expect(r.type).toBe('ok');
    if (r.type === 'ok' && r.payload.kind === 'body') {
      expect(r.payload.body).not.toContain('{{');
      expect(r.payload.body).toBe(prefix);
      expect(r.payload.warnings).toContain('The draft was cut off at the length limit');
    }
  });

  test('unknown var tokens are stripped and produce warnings', async () => {
    const modelPayload = JSON.stringify({
      kind: 'body',
      body: '{{var::camera}} {{var::lens}}',
      warnings: [],
    });
    const up = serve(() => streamed(modelPayload));
    const r = await provider(up).draftTemplate(
      { name: 'T', existingBody: '', library: knownLibrary(['lens']) },
      new AbortController().signal,
    );
    expect(r.type).toBe('ok');
    if (r.type === 'ok' && r.payload.kind === 'body') {
      // camera is unknown → replaced with literal; lens is known → kept
      expect(r.payload.body).toContain('{{var::lens}}');
      expect(r.payload.body).not.toContain('{{var::camera}}');
      expect(r.payload.warnings.some((w) => w.includes('camera'))).toBe(true);
    }
  });

  test('list name with spaces resolves correctly after regex fix', async () => {
    // "lens choice" is a valid list name (NameSchema allows spaces).
    // The old regex [^}|}\\s]+ would capture only "lens", losing " choice".
    // The new regex [^}]+? captures the full "lens choice".
    const modelPayload = JSON.stringify({
      kind: 'body',
      body: '{{var::lens choice}}',
      warnings: [],
    });
    const up = serve(() => streamed(modelPayload));
    const r = await provider(up).draftTemplate(
      { name: 'T', existingBody: '', library: knownLibrary(['lens choice']) },
      new AbortController().signal,
    );
    expect(r.type).toBe('ok');
    if (r.type === 'ok' && r.payload.kind === 'body') {
      // Known list name → token must survive (not stripped).
      expect(r.payload.body).toContain('{{var::lens choice}}');
      expect(r.payload.warnings).toHaveLength(0);
    }
  });
});

describe('textModel.draftTemplate — rework of an existing body', () => {
  test('the brief carries the existing body and the change instructions; the budget grows with the body', async () => {
    let body: Record<string, unknown> = {};
    const up = serve(async (req) => {
      body = (await req.json()) as Record<string, unknown>;
      return streamed(JSON.stringify({ kind: 'body', body: 'revised', warnings: [] }));
    });
    const existingBody = 'A'.repeat(3000);
    const r = await provider(up).draftTemplate(
      { name: 'T', existingBody, description: 'make it moodier', library: emptyLibrary },
      new AbortController().signal,
    );
    expect(r).toEqual({ type: 'ok', payload: { kind: 'body', body: 'revised', warnings: [] } });
    expect(body.max_completion_tokens).toBe(5500 + 1000);
    const user = JSON.stringify(body.messages);
    expect(user).toContain('existing_body');
    expect(user).toContain('make it moodier');
  });

  test('a pinned effort above low reasons through at least the enhance budget', async () => {
    let body: Record<string, unknown> = {};
    const up = serve(async (req) => {
      body = (await req.json()) as Record<string, unknown>;
      return streamed(JSON.stringify({ kind: 'body', body: 'ok', warnings: [] }));
    });
    await provider(up).draftTemplate(
      { name: 'T', existingBody: '', library: emptyLibrary, reasoningEffort: 'high' },
      new AbortController().signal,
    );
    expect(body.reasoning_effort).toBe('high');
    expect(body.max_completion_tokens).toBe(36_000);
  });

  test("the user's own macros and tokens survive verbatim; new non-var or unknown tokens are still stripped", async () => {
    const existingBody = 'A {{pick::red|blue}} coat, {{var::my_old_list}}, {{random::{{var::lens}}|wide}} and {{// note}}.';
    const revised = 'A moody {{pick::red|blue}} coat, {{var::my_old_list}}, {{random::{{var::lens}}|wide}} and {{// note}}, {{roll::d6}} {{var::invented}} {{var::lens}}.';
    const up = serve(() => streamed(JSON.stringify({ kind: 'body', body: revised, warnings: [] })));
    const r = await provider(up).draftTemplate(
      { name: 'T', existingBody, description: 'moodier', library: knownLibrary(['lens']) },
      new AbortController().signal,
    );
    expect(r.type).toBe('ok');
    if (r.type === 'ok' && r.payload.kind === 'body') {
      expect(r.payload.body).toBe('A moody {{pick::red|blue}} coat, {{var::my_old_list}}, {{random::{{var::lens}}|wide}} and {{// note}},  invented {{var::lens}}.');
      expect(r.payload.warnings).toEqual([
        'Removed unknown {{var::invented}} reference',
        'Removed 1 non-var macro token (advanced syntax — add by hand)',
      ]);
    }
  });

  test('a rework that edits inside an existing macro keeps the macro and its nested tokens', async () => {
    // Most real bodies are one ai-fill wrapper, so any edit changes its text.
    const existingBody = '{{ai-fill: a warm portrait in {{var::city}}, {{random::rain::fog}} outside, {{var::my_old_list}}}}';
    const revised = '{{ai-fill: a cold portrait in {{var::city}}, {{random::rain::fog::snow}} outside, {{var::my_old_list}}, {{roll::d6}} {{var::invented}} {{var::lens}}}}';
    const up = serve(() => streamed(JSON.stringify({ kind: 'body', body: revised, warnings: [] })));
    const r = await provider(up).draftTemplate(
      { name: 'T', existingBody, description: 'colder, add snow', library: knownLibrary(['lens']) },
      new AbortController().signal,
    );
    expect(r.type).toBe('ok');
    if (r.type === 'ok' && r.payload.kind === 'body') {
      // The wrapper and the edited random stay; `city` and `my_old_list` are the
      // user's own (unknown to the library); the new roll form and the invented
      // list go, exactly as they would outside a wrapper.
      expect(r.payload.body).toBe('{{ai-fill: a cold portrait in {{var::city}}, {{random::rain::fog::snow}} outside, {{var::my_old_list}},  invented {{var::lens}}}}');
      expect(r.payload.warnings).toEqual([
        'Removed unknown {{var::invented}} reference',
        'Removed 1 non-var macro token (advanced syntax — add by hand)',
      ]);
    }
  });

  test('an edited comment macro keeps its form whatever its first word', async () => {
    const existingBody = '{{ai-fill: warm {{//keep city token {{var::city}}}}}}';
    const revised = '{{ai-fill: cold {{//retain city token {{var::city}}}}}}';
    const up = serve(() => streamed(JSON.stringify({ kind: 'body', body: revised, warnings: [] })));
    const r = await provider(up).draftTemplate(
      { name: 'T', existingBody, description: 'colder', library: emptyLibrary },
      new AbortController().signal,
    );
    expect(r.type).toBe('ok');
    if (r.type === 'ok' && r.payload.kind === 'body') {
      expect(r.payload.body).toBe(revised);
      expect(r.payload.warnings).toEqual([]);
    }
  });

  test('a fresh draft still loses every non-var macro, wrappers included', async () => {
    const drafted = '{{ai-fill: a portrait in {{var::lens}}}} and {{random::a::b}}.';
    const up = serve(() => streamed(JSON.stringify({ kind: 'body', body: drafted, warnings: [] })));
    const r = await provider(up).draftTemplate(
      { name: 'T', existingBody: '', description: 'a portrait', library: knownLibrary(['lens']) },
      new AbortController().signal,
    );
    expect(r.type).toBe('ok');
    if (r.type === 'ok' && r.payload.kind === 'body') {
      expect(r.payload.body).toBe(' and .');
      expect(r.payload.warnings).toEqual(['Removed 2 non-var macro tokens (advanced syntax — add by hand)']);
    }
  });

  test('the length cap is the existing body plus MAX_DRAFT_RAW_BODY_CHARS', async () => {
    const existingBody = 'B'.repeat(1500);
    const fits = 'C'.repeat(3500);
    const upFits = serve(() => streamed(JSON.stringify({ kind: 'body', body: fits, warnings: [] })));
    const kept = await provider(upFits).draftTemplate(
      { name: 'T', existingBody, description: 'longer', library: emptyLibrary },
      new AbortController().signal,
    );
    expect(kept).toEqual({ type: 'ok', payload: { kind: 'body', body: fits, warnings: [] } });

    const upOver = serve(() => streamed(JSON.stringify({ kind: 'body', body: fits + 'D', warnings: [] })));
    const cut = await provider(upOver).draftTemplate(
      { name: 'T', existingBody, description: 'longer', library: emptyLibrary },
      new AbortController().signal,
    );
    expect(cut).toEqual({ type: 'ok', payload: { kind: 'body', body: fits, warnings: ['The draft was cut off at the length limit'] } });
  });
});
