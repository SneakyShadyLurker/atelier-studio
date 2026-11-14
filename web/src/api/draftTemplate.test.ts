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

describe('draftTemplate payload validation', () => {
  test('passes a clarify payload through', async () => {
    globalThis.fetch = sseFetch(doneFrame({ kind: 'clarify', question: 'Which era?' })) as unknown as typeof fetch;
    expect(await draftTemplate({ name: 'X', existingBody: '' })).toEqual({ kind: 'clarify', question: 'Which era?' });
  });

  test('rejects a body payload without warnings', async () => {
    globalThis.fetch = sseFetch(doneFrame({ kind: 'body', body: 'text' })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await draftTemplate({ name: 'X', existingBody: '' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as Error).message).toBe('invalid draft template payload');
  });
});

describe('draftTemplate changes payload (R1.7)', () => {
  const base = 'A red coat in soft light.';
  const change = (id: number, start: number, end: number, replace: string) => ({ id, start, end, replace, why: 'asked' });
  const payload = (overrides: Record<string, unknown> = {}) => ({
    kind: 'changes',
    baseLength: base.length,
    changes: [change(0, 2, 5, 'blue'), change(1, 14, 18, 'hard')],
    unplaced: [],
    summary: null,
    warnings: [],
    ...overrides,
  });

  async function caught(response: unknown): Promise<unknown> {
    globalThis.fetch = sseFetch(doneFrame(response)) as unknown as typeof fetch;
    try {
      await draftTemplate({ name: 'X', existingBody: base, description: 'bluer' });
    } catch (error) {
      return error;
    }
    return undefined;
  }

  test('accepts changes placed against the body it sent', async () => {
    globalThis.fetch = sseFetch(doneFrame(payload())) as unknown as typeof fetch;
    expect(await draftTemplate({ name: 'X', existingBody: base, description: 'bluer' })).toEqual(payload() as never);
  });

  test('accepts an empty change set', async () => {
    globalThis.fetch = sseFetch(doneFrame(payload({ changes: [] }))) as unknown as typeof fetch;
    expect(await draftTemplate({ name: 'X', existingBody: base, description: 'bluer' })).toEqual(payload({ changes: [] }) as never);
  });

  test.each([
    ['a base length that differs from the sent body', payload({ baseLength: base.length + 1 })],
    ['overlapping changes', payload({ changes: [change(0, 2, 8, 'x'), change(1, 6, 10, 'y')] })],
    ['touching changes', payload({ changes: [change(0, 2, 5, 'x'), change(1, 5, 10, 'y')] })],
    ['unsorted changes', payload({ changes: [change(0, 14, 18, 'hard'), change(1, 2, 5, 'blue')] })],
    ['a change past the end of the body', payload({ changes: [change(0, 20, base.length + 1, 'x')] })],
  ])('rejects %s with the ordinary draft error', async (_label, response) => {
    const error = await caught(response);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toBe('invalid draft template payload');
  });
});
