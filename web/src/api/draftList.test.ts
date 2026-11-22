import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { DraftVariableListRequest } from '@atelier/shared';
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

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the request to fail');
}

const OPTIONS = [{ value: 'a red scarf', weight: 1 }, { value: 'a blue scarf', weight: 2 }];
const CREATE: DraftVariableListRequest = { mode: 'create', options: [], description: 'scarves' };
const SEED: DraftVariableListRequest = { mode: 'extend', name: 'scarf', options: [], description: 'scarves' };
const EXTEND: DraftVariableListRequest = { mode: 'extend', name: 'scarf', options: OPTIONS };
const REWORK: DraftVariableListRequest = { mode: 'rework', name: 'scarf', options: OPTIONS, description: 'shorter' };

const listAnswer = (name: string | null) => ({ kind: 'list', name, options: [{ value: 'a green scarf', weight: 1 }] });
const changesAnswer = (changes: unknown[], baseCount = 2) => ({ kind: 'changes', baseCount, changes, unplaced: [], summary: null });
const ADD = { id: 0, op: 'add', value: 'a green scarf', weight: 1, why: '' };

describe('draftVariableList', () => {
  test('posts the request to the list draft route and resolves the streamed payload', async () => {
    const f = sseFetch(doneFrame(changesAnswer([ADD])));
    globalThis.fetch = f as unknown as typeof fetch;
    const out = await draftVariableList({ ...EXTEND, modelId: 'image-model' });
    expect(out).toEqual(changesAnswer([ADD]) as typeof out);
    const call = (f.mock.calls as unknown as [string, RequestInit?][])[0];
    const url = call?.[0] ?? '';
    expect(new URL(url, 'http://host').pathname).toBe('/api/prompts/lists/draft');
    expect(call?.[1]?.method).toBe('POST');
    expect(JSON.parse(typeof call?.[1]?.body === 'string' ? call[1].body : '{}')).toEqual({ ...EXTEND, modelId: 'image-model' });
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get('Accept')).toBe('text/event-stream');
  });

  test('throws ApiError on non-2xx (pre-stream validation error)', async () => {
    globalThis.fetch = jsonFetch(400, { error: 'validation failed' }) as unknown as typeof fetch;
    expect(await failure(draftVariableList(EXTEND))).toBeInstanceOf(ApiError);
  });

  test('throws on a terminal SSE error frame with the server message', async () => {
    globalThis.fetch = sseFetch(errorFrame("Couldn't draft the list.")) as unknown as typeof fetch;
    const caught = await failure(draftVariableList(EXTEND));
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('draft the list');
  });

  test('forwards the abort signal to fetch when provided', async () => {
    const f = sseFetch(doneFrame(changesAnswer([ADD])));
    globalThis.fetch = f as unknown as typeof fetch;
    const controller = new AbortController();
    await draftVariableList(EXTEND, controller.signal);
    const init = (f.mock.calls as unknown as [unknown, RequestInit?][])[0]?.[1];
    expect(init?.signal).toBe(controller.signal);
  });
});

// R4.6: an answer is accepted only when its kind fits the request's mode and
// its changes address exactly the options sent.
describe('draftVariableList answer guard', () => {
  const accepted: [string, DraftVariableListRequest, unknown][] = [
    ['create takes a named list', CREATE, listAnswer('scarf')],
    ['a seed takes an unnamed list', SEED, listAnswer(null)],
    ['a populated extend takes additions', EXTEND, changesAnswer([ADD])],
    ['a populated extend takes no changes', EXTEND, changesAnswer([])],
    ['a populated extend with no instructions takes a question', EXTEND, { kind: 'clarify', question: 'Which scarves?' }],
    ['rework takes edits, removes and adds in order', REWORK, changesAnswer([
      { id: 0, op: 'edit', index: 0, value: 'red scarf', weight: 1, why: 'Shorter.' },
      { id: 1, op: 'remove', index: 1, why: 'Near duplicate.' },
      { ...ADD, id: 2 },
    ])],
  ];
  for (const [name, request, answer] of accepted) {
    test(name, async () => {
      globalThis.fetch = sseFetch(doneFrame(answer)) as unknown as typeof fetch;
      expect(await draftVariableList(request)).toEqual(answer as Awaited<ReturnType<typeof draftVariableList>>);
    });
  }

  const rejected: [string, DraftVariableListRequest, unknown][] = [
    ['create rejects an unnamed list', CREATE, listAnswer(null)],
    ['create rejects changes', CREATE, changesAnswer([ADD], 0)],
    ['a seed rejects a named list', SEED, listAnswer('scarf')],
    ['a seed rejects a question', SEED, { kind: 'clarify', question: 'Which?' }],
    ['a populated extend rejects a list', EXTEND, listAnswer(null)],
    ['a populated extend rejects an edit', EXTEND, changesAnswer([{ id: 0, op: 'edit', index: 0, value: 'x', weight: 1, why: '' }])],
    ['a populated extend with instructions rejects a question', { ...EXTEND, description: 'more' }, { kind: 'clarify', question: 'Which?' }],
    ['rework rejects a question', REWORK, { kind: 'clarify', question: 'Which?' }],
    ['rework rejects a list', REWORK, listAnswer(null)],
    ['a wrong base count', REWORK, changesAnswer([ADD], 3)],
    ['an index past the base', REWORK, changesAnswer([{ id: 0, op: 'remove', index: 2, why: '' }])],
    ['ids out of order', REWORK, changesAnswer([{ ...ADD, id: 1 }])],
    ['an edit after an add', REWORK, changesAnswer([ADD, { id: 1, op: 'remove', index: 0, why: '' }])],
    ['two changes on one row', REWORK, changesAnswer([
      { id: 0, op: 'remove', index: 0, why: '' },
      { id: 1, op: 'edit', index: 0, value: 'x', weight: 1, why: '' },
    ])],
    ['a malformed payload', REWORK, { kind: 'entries', entries: ['a'] }],
  ];
  for (const [name, request, answer] of rejected) {
    test(name, async () => {
      globalThis.fetch = sseFetch(doneFrame(answer)) as unknown as typeof fetch;
      const caught = await failure(draftVariableList(request));
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as Error).message).toBe('invalid draft list payload');
    });
  }
});
