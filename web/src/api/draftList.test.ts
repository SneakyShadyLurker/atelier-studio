import { afterEach, describe, expect, mock, test } from 'bun:test';
import { draftVariableList } from './draftList';
import { ApiError } from './client';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; mock.restore(); });

// The route streams its result as SSE; the client resolves the terminal frame.
function sseFetch(frames: string) {
  return mock(() => Promise.resolve(new Response(frames, {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  })));
}
function jsonFetch(status: number, body: unknown) {
  return mock(() => Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })));
}
function doneFrame(payload: unknown): string {
  return `event: done\ndata: ${JSON.stringify(payload)}\n\n`;
}
function errorFrame(message: string): string {
  return `event: error\ndata: ${JSON.stringify({ message })}\n\n`;
}

describe('draftVariableList', () => {
  test('posts to the list draft endpoint and resolves the streamed payload', async () => {
    const f = sseFetch(doneFrame({ kind: 'entries', entries: ['a', 'b'] }));
    globalThis.fetch = f as unknown as typeof fetch;
    const out = await draftVariableList('list-1', { name: 'L', existing: [] });
    expect(out).toEqual({ kind: 'entries', entries: ['a', 'b'] });
    const url = (f.mock.calls as unknown as [string, RequestInit?][])[0]?.[0] ?? '';
    expect(url).toContain('/prompts/lists/list-1/draft');
  });

  test('encodes list ids and sends a request id header', async () => {
    const f = sseFetch(doneFrame({ kind: 'entries', entries: [] }));
    globalThis.fetch = f as unknown as typeof fetch;
    await draftVariableList('list /1', { name: 'L', existing: [] });

    const call = (f.mock.calls as unknown as [string, RequestInit?][])[0];
    const url = call?.[0] ?? '';
    const headers = new Headers(call?.[1]?.headers);
    expect(url).toContain('/prompts/lists/list%20%2F1/draft');
    expect(headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.get('Accept')).toBe('text/event-stream');
  });

  test('passes a clarify payload through', async () => {
    globalThis.fetch = sseFetch(doneFrame({ kind: 'clarify', question: 'q?' })) as unknown as typeof fetch;
    expect(await draftVariableList('l', { name: 'L', existing: [] })).toEqual({ kind: 'clarify', question: 'q?' });
  });

  test('throws ApiError on non-2xx (pre-stream validation error)', async () => {
    globalThis.fetch = jsonFetch(400, { error: 'validation failed' }) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await draftVariableList('l', { name: 'L', existing: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
  });

  test('throws on a terminal SSE error frame with the server message', async () => {
    globalThis.fetch = sseFetch(errorFrame('Couldn\'t draft the list. Try a more specific name.')) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await draftVariableList('l', { name: 'L', existing: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('draft the list');
  });

  test('forwards the abort signal to fetch when provided', async () => {
    const f = sseFetch(doneFrame({ kind: 'entries', entries: [] }));
    globalThis.fetch = f as unknown as typeof fetch;
    const controller = new AbortController();
    await draftVariableList('l', { name: 'L', existing: [] }, controller.signal);
    const init = (f.mock.calls as unknown as [unknown, RequestInit?][])[0]?.[1];
    expect(init?.signal).toBe(controller.signal);
  });
});
