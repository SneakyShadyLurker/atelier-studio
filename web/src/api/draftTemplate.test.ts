import { afterEach, describe, expect, mock, test } from 'bun:test';
import { draftTemplate } from './draftTemplate';
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

describe('draftTemplate', () => {
  test('POSTs and resolves the streamed body response', async () => {
    const f = sseFetch(doneFrame({ kind: 'body', body: 'hello', warnings: [] }));
    globalThis.fetch = f as unknown as typeof fetch;
    const res = await draftTemplate({ name: 'X', existingBody: '' });
    expect(res).toEqual({ kind: 'body', body: 'hello', warnings: [] });
    const url = (f.mock.calls as unknown as [string, RequestInit?][])[0]?.[0] ?? '';
    expect(url).toContain('/prompts/templates/draft');
    expect(url).not.toContain('/unsaved/');
    const init = (f.mock.calls as unknown as [unknown, RequestInit?][])[0]?.[1];
    expect(new Headers(init?.headers).get('Accept')).toBe('text/event-stream');
  });

  test('throws ApiError on non-2xx (pre-stream validation error)', async () => {
    globalThis.fetch = jsonFetch(400, { error: 'validation failed' }) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await draftTemplate({ name: 'X', existingBody: '' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
  });

  test('throws on a terminal SSE error frame with the server message', async () => {
    globalThis.fetch = sseFetch(errorFrame('Couldn\'t draft the template.')) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await draftTemplate({ name: 'X', existingBody: '' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('draft the template');
  });

  test('forwards AbortSignal', async () => {
    const f = sseFetch(doneFrame({ kind: 'body', body: '', warnings: [] }));
    globalThis.fetch = f as unknown as typeof fetch;
    const ac = new AbortController();
    await draftTemplate({ name: 'X', existingBody: '' }, ac.signal);
    const init = (f.mock.calls as unknown as [unknown, RequestInit?][])[0]?.[1];
    expect(init?.signal).toBe(ac.signal);
  });
});
