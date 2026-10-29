import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import type { CharacterCardKind } from '@atelier/shared';
import { ephemeraEnabled, loadConfig, type EphemeraConfig } from '../../config';
import { createCharacterFromImage, type CharacterCardOutcome, type EphemeraPhase } from './client';
import { NdjsonOversizeError, readNdjsonLines } from './ndjson';

const KEY = 'i'.repeat(48);
const ORIGIN = 'https://ephemera.example.org';
const CHARACTER_ID = '6f1c1c0e-8a43-4c1e-9d55-0c4f3b8f2a11';

let server: Server<undefined> | null = null;

afterEach(async () => {
  await server?.stop(true);
  server = null;
});

function serve(handler: (req: Request) => Response | Promise<Response>): EphemeraConfig {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  const config = loadConfig({
    CLIPROXY_BASE_URL: 'http://127.0.0.1:1',
    CLIPROXY_TOKEN: 'stub',
    DATA_DIR: '/tmp/atelier-ephemera-client-test',
    EPHEMERA_BASE_URL: server.url.origin,
    EPHEMERA_INTEGRATION_KEY: KEY,
    EPHEMERA_ORIGIN: ORIGIN,
  });
  if (!ephemeraEnabled(config)) throw new Error('expected the integration to be configured');
  return config;
}

function ndjson(lines: readonly string[], status = 200): Response {
  return new Response(lines.map((line) => `${line}\n`).join(''), {
    status,
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
  });
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function call(
  config: EphemeraConfig,
  notes: string | null = 'a portrait prompt',
  signal: AbortSignal = AbortSignal.timeout(5_000),
  direction: string | null = null,
  kind: CharacterCardKind = 'subject',
): Promise<{ outcome: CharacterCardOutcome; phases: EphemeraPhase[] }> {
  const phases: EphemeraPhase[] = [];
  const outcome = await createCharacterFromImage(
    config,
    {
      userId: 'alice',
      characterId: CHARACTER_ID,
      image: { bytes: PNG, mime: 'image/png', filename: 'tile.png' },
      notes,
      direction,
      kind,
    },
    signal,
    (phase) => { phases.push(phase); },
  );
  return { outcome, phases };
}

const RESULT_LINE = JSON.stringify({ type: 'result', id: CHARACTER_ID, name: 'Mara Quill' });

describe('createCharacterFromImage', () => {
  test('sends multipart file, id and notes with the integration headers', async () => {
    interface Seen {
      headers: Headers;
      path: string;
      method: string;
      fileType: string | null;
      fileBytes: Uint8Array | null;
      id: unknown;
      notes: unknown;
      direction: unknown;
      kind: unknown;
    }
    const seen: Seen[] = [];
    const config = serve(async (req) => {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- test server uses Bun's built-in multipart parser.
      const form = await req.formData();
      const file = form.get('file');
      seen.push({
        headers: req.headers,
        path: new URL(req.url).pathname,
        method: req.method,
        fileType: file instanceof File ? file.type : null,
        fileBytes: file instanceof File ? new Uint8Array(await file.arrayBuffer()) : null,
        id: form.get('id'),
        notes: form.get('notes'),
        direction: form.get('direction'),
        kind: form.get('kind'),
      });
      return ndjson([RESULT_LINE]);
    });
    await call(config);
    expect(seen).toHaveLength(1);
    const [request] = seen;
    if (!request) throw new Error('fake Ephemera was not called');
    const { headers } = request;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/api/creator/card/from-image');
    expect(headers.get('x-ephemera-proxy-key')).toBe(KEY);
    expect(headers.get('remote-user')).toBe('alice');
    expect(headers.get('origin')).toBe(ORIGIN);
    expect(headers.get('accept')).toBe('application/x-ndjson');
    expect(headers.get('content-type')).toStartWith('multipart/form-data');
    expect(request.fileType).toBe('image/png');
    expect(request.fileBytes).toEqual(PNG);
    expect(request.id).toBe(CHARACTER_ID);
    expect(request.notes).toBe('a portrait prompt');
    // No steering: the field is absent, so Ephemera's prompt stays as before.
    expect(request.direction).toBeNull();
    expect(request.kind).toBe('subject');
  });

  test('always sends the chosen kind', async () => {
    const seen: unknown[] = [];
    const config = serve(async (req) => {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- test server uses Bun's built-in multipart parser.
      const form = await req.formData();
      seen.push(form.get('kind'));
      return ndjson([RESULT_LINE]);
    });
    await call(config, 'a portrait prompt', AbortSignal.timeout(5_000), null, 'group');
    await call(config, 'a portrait prompt', AbortSignal.timeout(5_000), null, 'scenario');
    expect(seen).toEqual(['group', 'scenario']);
  });

  test('sends the direction only when it has text', async () => {
    const seen: unknown[] = [];
    const config = serve(async (req) => {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- test server uses Bun's built-in multipart parser.
      const form = await req.formData();
      seen.push(form.get('direction'));
      return ndjson([RESULT_LINE]);
    });
    await call(config, 'a portrait prompt', AbortSignal.timeout(5_000), 'a retired sea captain, gruff but kind');
    await call(config, 'a portrait prompt', AbortSignal.timeout(5_000), '');
    expect(seen).toEqual(['a retired sea captain, gruff but kind', null]);
  });

  test('relays status phases in order and returns the result with its url', async () => {
    const config = serve(() => ndjson([
      JSON.stringify({ type: 'status', phase: 'writing' }),
      '',
      JSON.stringify({ type: 'status', phase: 'rewriting' }),
      JSON.stringify({ type: 'status', phase: 'saving' }),
      RESULT_LINE,
    ]));
    const { outcome, phases } = await call(config, null);
    expect(phases).toEqual(['writing', 'rewriting', 'saving']);
    expect(outcome).toEqual({
      ok: true,
      characterId: CHARACTER_ID,
      name: 'Mara Quill',
      url: `${ORIGIN}/characters/${CHARACTER_ID}`,
    });
  });

  test('maps Ephemera HTTP refusals to the public codes', async () => {
    const cases: readonly [number, string][] = [
      [403, 'ephemera-forbidden'],
      [429, 'ephemera-busy'],
      [400, 'ephemera-unavailable'],
      [413, 'unsupported-image'],
      [415, 'unsupported-image'],
      [422, 'unsupported-image'],
      [500, 'ephemera-unavailable'],
      [502, 'ephemera-unavailable'],
    ];
    for (const [status, code] of cases) {
      const config = serve(() => Response.json({ error: 'secret upstream detail' }, { status }));
      const { outcome } = await call(config);
      expect(outcome).toMatchObject({ ok: false, code, status });
      expect(JSON.stringify(outcome)).not.toContain('secret upstream detail');
      await server?.stop(true);
      server = null;
    }
  });

  test('a redirect ends as ephemera-unavailable without being followed', async () => {
    let followed = false;
    const config = serve((req) => {
      if (new URL(req.url).pathname === '/elsewhere') {
        followed = true;
        return ndjson([RESULT_LINE]);
      }
      return new Response(null, { status: 302, headers: { Location: '/elsewhere' } });
    });
    const { outcome } = await call(config);
    expect(outcome).toMatchObject({ ok: false, code: 'ephemera-unavailable' });
    expect(followed).toBe(false);
  });

  test('a non-NDJSON body ends as ephemera-unavailable and its text appears nowhere', async () => {
    const html = '<html><body>Bad gateway from the hidden host</body></html>';
    const config = serve(() => new Response(html, { headers: { 'Content-Type': 'text/html' } }));
    const { outcome } = await call(config);
    expect(outcome).toEqual({
      ok: false,
      code: 'ephemera-unavailable',
      message: 'Ephemera is unavailable right now. The card may already be saved; clicking again later finds it instead of making a duplicate.',
      status: 200,
    });
    expect(JSON.stringify(outcome)).not.toContain('hidden host');
  });

  test('a malformed event line ends as ephemera-unavailable', async () => {
    const config = serve(() => ndjson([JSON.stringify({ type: 'status', phase: 'writing' }), '{not json']));
    const { outcome, phases } = await call(config);
    expect(phases).toEqual(['writing']);
    expect(outcome).toMatchObject({ ok: false, code: 'ephemera-unavailable' });
  });

  test('an unknown event type ends as ephemera-unavailable', async () => {
    const config = serve(() => ndjson([JSON.stringify({ type: 'delta', text: 'draft card text' }), RESULT_LINE]));
    const { outcome } = await call(config);
    expect(outcome).toMatchObject({ ok: false, code: 'ephemera-unavailable' });
    expect(JSON.stringify(outcome)).not.toContain('draft card text');
  });

  test('a stream that closes without a terminal event ends as ephemera-unavailable', async () => {
    const config = serve(() => ndjson([JSON.stringify({ type: 'status', phase: 'writing' })]));
    const { outcome } = await call(config);
    expect(outcome).toMatchObject({ ok: false, code: 'ephemera-unavailable' });
  });

  test('maps every stream error code per the spec table', async () => {
    const cases: readonly [string, string, string][] = [
      ['no_model', 'no-model', "Pick a reply model in Ephemera's settings first."],
      ['text_only_model', 'text-only-model', "Ephemera's chosen model cannot read images. Pick a vision model there."],
      ['context_window_unknown', 'too-large', "Ephemera's chosen model cannot take a card this size. Pick another model there."],
      ['too_large', 'too-large', "Ephemera's chosen model cannot take a card this size. Pick another model there."],
      ['invalid_card', 'invalid-card', 'The model did not write a usable card. Try again.'],
      ['upstream', 'provider-error', 'The AI service returned an error. Please try again.'],
      ['timeout', 'timeout', 'Writing the card took too long. It may already be saved; clicking again finds it instead of making a duplicate.'],
      ['save_failed', 'card-failed', "Couldn't create the card. Please try again."],
      ['internal', 'card-failed', "Couldn't create the card. Please try again."],
    ];
    for (const [wire, code, message] of cases) {
      const config = serve(() => ndjson([JSON.stringify({ type: 'error', code: wire })]));
      const { outcome } = await call(config);
      expect(outcome).toEqual({ ok: false, code, message, status: 200 } as CharacterCardOutcome);
      await server?.stop(true);
      server = null;
    }
  });

  test('a hostile result name is returned as the validated string only', async () => {
    const hostile = '**Mara** <img src=x onerror=alert(1)> \u0007\u001b[31m';
    const config = serve(() => ndjson([
      JSON.stringify({ type: 'result', id: CHARACTER_ID, name: hostile, extra: 'unvalidated field' }),
    ]));
    const { outcome } = await call(config);
    expect(outcome).toEqual({
      ok: true,
      characterId: CHARACTER_ID,
      name: hostile,
      url: `${ORIGIN}/characters/${CHARACTER_ID}`,
    });
    expect(JSON.stringify(outcome)).not.toContain('unvalidated field');
  });

  test('an aborted signal rejects and aborts the outbound request', async () => {
    const upstream = { aborted: false };
    const config = serve((req) => {
      req.signal.addEventListener('abort', () => { upstream.aborted = true; });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: 'status', phase: 'writing' })}\n`));
        },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    const ac = new AbortController();
    const pending = createCharacterFromImage(
      config,
      { userId: 'alice', characterId: CHARACTER_ID, image: { bytes: PNG, mime: 'image/png', filename: 'tile.png' }, notes: null, direction: null, kind: 'subject' },
      ac.signal,
      () => { ac.abort(new Error('client went away')); },
    );
    expect(await pending.then(() => 'resolved', () => 'rejected')).toBe('rejected');
    for (let i = 0; i < 50 && !upstream.aborted; i++) await Bun.sleep(10);
    expect(upstream.aborted).toBe(true);
  });
});

describe('readNdjsonLines', () => {
  function chunked(parts: readonly string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    });
  }

  test('skips blank keepalive lines and joins a line split across chunks', async () => {
    const lines: string[] = [];
    for await (const line of readNdjsonLines(chunked(['\n\n{"type":"st', 'atus"}\n', '\r\n', '{"a":1}']), { maxBytes: 65_536 })) {
      lines.push(line);
    }
    expect(lines).toEqual(['{"type":"status"}', '{"a":1}']);
  });

  test('throws a typed error once the body passes the byte cap', async () => {
    const big = `${'x'.repeat(40_000)}\n${'y'.repeat(40_000)}\n`;
    const read = async (): Promise<string[]> => {
      const lines: string[] = [];
      for await (const line of readNdjsonLines(chunked([big]), { maxBytes: 65_536 })) lines.push(line);
      return lines;
    };
    expect(await read().then(() => null, (error: unknown) => error)).toBeInstanceOf(NdjsonOversizeError);
  });
});
