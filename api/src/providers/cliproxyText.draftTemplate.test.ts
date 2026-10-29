import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { restoreFetch } from '../test/helpers';
import { createCliproxyTextProvider } from './cliproxyText';
import type { LibraryOverview } from '../prompts/libraryOverview';
import { testTextPolicies } from '../test/textPolicies';

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

function chatJson(body: string): Response {
  const payload = JSON.stringify({ choices: [{ message: { content: body } }] });
  return new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const emptyLibrary: LibraryOverview = { lists: [] };

function provider(baseUrl: string, model = 'kimi-latest') {
  return createCliproxyTextProvider({ ...testTextPolicies(), baseUrl, token: 'sk-x', model, backend: 'kimi', maxResponseBytes: 10_000_000 });
}

function knownLibrary(names: string[]): LibraryOverview {
  return {
    lists: names.map((name) => ({ name, optionCount: 1, samples: ['sample'] })),
  };
}

describe('cliproxyText.draftTemplate — request body (model-family mapping)', () => {
  const okPayload = JSON.stringify({ kind: 'body', body: 'ok', warnings: [] });

  for (const reason of ['length', 'content_filter', 'tool_calls', 'function_call', 'insufficient_system_resource', 'stop']) {
    test(`nonstream draft classifies explicit finish_reason ${reason}`, async () => {
      const up = serve(() => new Response(JSON.stringify({ choices: [{ message: { content: okPayload }, finish_reason: reason }] })));
      const result = await provider(up).draftTemplate(
        { name: 'T', existingBody: '', library: emptyLibrary }, new AbortController().signal,
      );
      expect(result.type).toBe(reason === 'stop' ? 'ok' : 'failed');
    });
  }

  test('Kimi provider sends its low-reasoning prose shape without response_format', async () => {
    let body: Record<string, unknown> = {};
    const up = serve(async (req) => { body = (await req.json()) as Record<string, unknown>; return chatJson(okPayload); });
    await provider(up, 'kimi-latest').draftTemplate(
      { name: 'T', existingBody: '', library: emptyLibrary },
      new AbortController().signal,
    );
    expect(body).toMatchObject({
      model: 'kimi-latest',
      stream: false,
      reasoning_effort: 'low',
      max_completion_tokens: 5500,
    });
    expect(body).not.toHaveProperty('verbosity');
    expect(body).not.toHaveProperty('response_format');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('max_tokens');
  });
});

describe('cliproxyText.draftTemplate — truncation', () => {
  test('truncation: body longer than MAX_DRAFT_RAW_BODY_CHARS is truncated and warning is emitted', async () => {
    // 2001 code points → triggers the 2000 cap
    const longBody = 'A'.repeat(2001);
    const modelPayload = JSON.stringify({ kind: 'body', body: longBody, warnings: [] });
    const up = serve(() => chatJson(modelPayload));
    const r = await provider(up).draftTemplate(
      { name: 'T', existingBody: '', library: emptyLibrary },
      new AbortController().signal,
    );
    expect(r.type).toBe('ok');
    if (r.type === 'ok' && r.payload.kind === 'body') {
      expect(Array.from(r.payload.body).length).toBeLessThanOrEqual(2000);
      expect(r.payload.warnings).toContain('Body truncated at MAX_DRAFT_RAW_BODY_CHARS');
    }
  });

  test('truncation: emoji at the 2000-codepoint boundary is not split into an orphan surrogate', async () => {
    // 1999 ASCII chars + one emoji (U+1F305 🌅) + "TAIL" = 2004 code points → cap triggers.
    // UTF-16 .slice(0, 2000) would land between the surrogate pair; Array.from avoids that.
    const prefix = 'A'.repeat(1999);
    const emoji = '\u{1F305}'; // 2 UTF-16 code units, 1 code point
    const longBody = prefix + emoji + 'TAIL';
    const modelPayload = JSON.stringify({ kind: 'body', body: longBody, warnings: [] });
    const up = serve(() => chatJson(modelPayload));
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
    const up = serve(() => chatJson(modelPayload));
    const r = await provider(up).draftTemplate(
      { name: 'T', existingBody: '', library: emptyLibrary },
      new AbortController().signal,
    );
    expect(r.type).toBe('ok');
    if (r.type === 'ok' && r.payload.kind === 'body') {
      expect(r.payload.body).not.toContain('{{');
      expect(r.payload.body).toBe(prefix);
      expect(r.payload.warnings).toContain('Body truncated at MAX_DRAFT_RAW_BODY_CHARS');
    }
  });

  test('unknown var tokens are stripped and produce warnings', async () => {
    const modelPayload = JSON.stringify({
      kind: 'body',
      body: '{{var::camera}} {{var::lens}}',
      warnings: [],
    });
    const up = serve(() => chatJson(modelPayload));
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
    const up = serve(() => chatJson(modelPayload));
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
