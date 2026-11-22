import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { DraftVariableListRequest, ListOptionDraft } from '@atelier/shared';
import { MAX_OPTIONS_PER_LIST } from '@atelier/shared';
import type { OptionDraft } from '../components/PromptManager/draftStore';
import type { ListReview } from '../components/PromptManager/listReview';
import { useDraftList } from './useDraftList';
import { useAtelierStore } from '../store/atelier';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
  useAtelierStore.setState({ toasts: [] });
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

// The draft route streams its result as SSE: a 200 success carries the
// payload in a terminal `done` frame.
function done(body: unknown): Response {
  return new Response(`event: done\ndata: ${JSON.stringify(body)}\n\n`, {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  });
}

function row(key: string, value: string, weight = 1): OptionDraft {
  return { key, value, tagIds: [], excludeTagIds: [], weight, weightInput: String(weight), expanded: false };
}

const ROWS = [row('a', 'a red scarf'), row('blank', ''), row('b', ' a blue scarf ', 2)];
const SENT = [{ value: 'a red scarf', weight: 1 }, { value: 'a blue scarf', weight: 2 }];
const ADD = { id: 0, op: 'add', value: 'a green scarf', weight: 1, why: '' };
const changes = (list: unknown[], extra: Record<string, unknown> = {}) => ({ kind: 'changes', baseCount: 2, changes: list, unplaced: [], summary: null, ...extra });

/** A draft server: answers each POST with `answer(request, call)`; `onAnswer` runs before the response resolves. */
function draftServer(answer: (request: DraftVariableListRequest, call: number) => unknown, onAnswer?: () => void) {
  const requests: DraftVariableListRequest[] = [];
  globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as DraftVariableListRequest;
    requests.push(request);
    onAnswer?.();
    return Promise.resolve(done(answer(request, requests.length)));
  }) as unknown as typeof fetch;
  return requests;
}

function harness(
  rows: readonly OptionDraft[] | { rows: readonly OptionDraft[] } = ROWS,
  commitChoice: () => Promise<void> = () => Promise.resolve(),
) {
  // A shared state object lets a draft server change the rows mid-request.
  const state = 'rows' in rows ? rows : { rows };
  const onSeed = mock((_: readonly ListOptionDraft[]) => undefined);
  const onReview = mock((_: ListReview) => undefined);
  const commit = mock(commitChoice);
  const view = renderHook(
    () => useDraftList({ name: 'scarf', getRows: () => state.rows, commitChoice: commit, onSeed, onReview }),
    { wrapper: wrapper() },
  );
  return {
    view,
    onSeed,
    onReview,
    commit,
    get current() { return view.result.current; },
  };
}

describe('useDraftList', () => {
  test('an empty list opens the seed dialog; its answer fills the rows', async () => {
    const requests = draftServer(() => ({ kind: 'list', name: null, options: [{ value: 'a green scarf', weight: 3 }] }));
    const h = harness([row('blank', '')]);
    act(() => { h.current.draft(); });
    expect(h.current.dialogMode).toBe('seed');
    expect(requests).toHaveLength(0);
    act(() => { h.current.submitDescription(''); });
    expect(requests).toHaveLength(0);
    act(() => { h.current.submitDescription('  scarves  '); });
    await waitFor(() => { expect(h.current.status).toBe('done'); });
    expect(requests[0]).toEqual({ mode: 'extend', name: 'scarf', options: [], description: 'scarves' });
    expect(h.onSeed).toHaveBeenCalledWith([{ value: 'a green scarf', weight: 3 }]);
    expect(h.current.dialogMode).toBeNull();
  });

  test('a populated list opens on Add options; a blank Add sends the trimmed base without a description', async () => {
    const requests = draftServer(() => changes([ADD]));
    const h = harness();
    act(() => { h.current.draft(); });
    expect(h.current.dialogMode).toBe('rework');
    expect(h.current.choice).toBe('extend');
    expect(h.current.full).toBe(false);
    act(() => { h.current.submitDescription('   '); });
    await waitFor(() => { expect(h.current.status).toBe('done'); });
    expect(requests).toEqual([{ mode: 'extend', name: 'scarf', options: SENT }]);
    const review = h.onReview.mock.calls[0]?.[0];
    expect(review?.mode).toBe('extend');
    expect(review?.instructions).toBe('');
    expect(review?.base).toEqual([{ key: 'a', value: 'a red scarf', weight: 1 }, { key: 'b', value: 'a blue scarf', weight: 2 }]);
  });

  test('Rework needs instructions and opens a rework review', async () => {
    const requests = draftServer(() => changes([{ id: 0, op: 'remove', index: 1, why: 'Too blue.' }]));
    const h = harness();
    act(() => { h.current.draft(); });
    act(() => { h.current.setChoice('rework'); });
    act(() => { h.current.submitDescription(''); });
    expect(requests).toHaveLength(0);
    act(() => { h.current.submitDescription('drop the blue one'); });
    await waitFor(() => { expect(h.onReview).toHaveBeenCalledTimes(1); });
    expect(requests[0]).toEqual({ mode: 'rework', name: 'scarf', options: SENT, description: 'drop the blue one' });
    expect(h.onReview.mock.calls[0]?.[0]).toMatchObject({ mode: 'rework', instructions: 'drop the blue one', rejected: [] });
  });

  test('draft("rework") reopens on Rework', () => {
    draftServer(() => changes([]));
    const h = harness();
    act(() => { h.current.draft('rework'); });
    expect(h.current.choice).toBe('rework');
  });

  test('at the option limit Add options is off and Rework is chosen', () => {
    draftServer(() => changes([]));
    const rows = Array.from({ length: MAX_OPTIONS_PER_LIST }, (_, i) => row(`k${String(i)}`, `scarf ${String(i)}`));
    const h = harness(rows);
    act(() => { h.current.draft(); });
    expect(h.current.full).toBe(true);
    expect(h.current.choice).toBe('rework');
    act(() => { h.current.setChoice('extend'); });
    expect(h.current.choice).toBe('rework');
  });

  test('a question after a blank Add opens the clarify dialog; the answer is sent as Add instructions', async () => {
    const requests = draftServer((request) => (request.description === undefined
      ? { kind: 'clarify', question: 'Which scarves?' }
      : changes([ADD])));
    const h = harness();
    act(() => { h.current.draft(); });
    act(() => { h.current.submitDescription(''); });
    await waitFor(() => { expect(h.current.dialogMode).toBe('clarify'); });
    expect(h.current.clarifyQuestion).toBe('Which scarves?');
    act(() => { h.current.submitDescription('winter ones'); });
    await waitFor(() => { expect(h.onReview).toHaveBeenCalledTimes(1); });
    expect(requests[1]).toEqual({ mode: 'extend', name: 'scarf', options: SENT, description: 'winter ones' });
  });

  // R4.5: no placed change keeps the dialog open with a note.
  const notices: [string, 'extend' | 'rework', Record<string, unknown>, string][] = [
    ['unplaced operations', 'rework', { unplaced: [{ op: 'remove', find: 'a pink scarf', value: null, weight: null, why: '', reason: 'missing' }], summary: 'Removed it.' },
      "The model's edits did not line up with the list. Try again, or pick another model."],
    ['a summary', 'rework', { summary: 'The list already reads well.' }, 'The list already reads well.'],
    ['a blank summary on Rework', 'rework', { summary: '  ' }, 'The model found nothing to change.'],
    ['nothing on Add', 'extend', {}, 'No new options to add.'],
  ];
  for (const [name, mode, extra, notice] of notices) {
    test(`no placed change with ${name} keeps the dialog open with its note`, async () => {
      draftServer(() => changes([], extra));
      const h = harness();
      act(() => { h.current.draft(); });
      act(() => { h.current.setChoice(mode); });
      act(() => { h.current.submitDescription('something'); });
      await waitFor(() => { expect(h.current.notice).toBe(notice); });
      expect(h.current.dialogMode).toBe('rework');
      expect(h.onReview).not.toHaveBeenCalled();
    });
  }

  test('the model choice is saved before the request; a failed save sends nothing', async () => {
    const order: string[] = [];
    const requests = draftServer(() => { order.push('draft'); return changes([ADD]); });
    const h = harness(ROWS, () => { order.push('commit'); return Promise.resolve(); });
    act(() => { h.current.draft(); });
    act(() => { h.current.submitDescription('more'); });
    await waitFor(() => { expect(h.current.status).toBe('done'); });
    expect(order).toEqual(['commit', 'draft']);

    const failing = harness(ROWS, () => Promise.reject(new Error('save failed')));
    act(() => { failing.current.draft(); });
    act(() => { failing.current.submitDescription('more'); });
    await waitFor(() => { expect(failing.current.status).toBe('error'); });
    expect(failing.current.error).toBe("Couldn't draft the list.");
    expect(failing.current.dialogMode).toBe('rework');
    expect(requests).toHaveLength(1);
  });

  test('the request carries the Composer image model as modelId', async () => {
    const previous = useAtelierStore.getState().draft;
    useAtelierStore.setState({ draft: { ...previous, modelId: 'image-model-a' } });
    try {
      const requests = draftServer(() => changes([ADD]));
      const h = harness();
      act(() => { h.current.draft(); });
      act(() => { h.current.submitDescription('more'); });
      await waitFor(() => { expect(requests).toHaveLength(1); });
      expect(requests[0]?.modelId).toBe('image-model-a');
    } finally {
      useAtelierStore.setState({ draft: previous });
    }
  });

  // R4.6: an answer for rows that changed meanwhile is the ordinary error, whatever its kind.
  const staleRows: [string, OptionDraft[]][] = [
    ['one changed key', [row('a2', 'a red scarf'), row('b', 'a blue scarf', 2)]],
    ['one changed weight', [row('a', 'a red scarf'), row('b', 'a blue scarf', 3)]],
  ];
  const kinds: [string, unknown][] = [
    ['changes', changes([ADD])],
    ['no change', changes([])],
    ['clarify', { kind: 'clarify', question: 'Which?' }],
  ];
  for (const [rowsName, rows] of staleRows) {
    for (const [kindName, answer] of kinds) {
      test(`a ${kindName} answer for rows with ${rowsName} (same count) is rejected as stale`, async () => {
        const state: { rows: readonly OptionDraft[] } = { rows: ROWS };
        draftServer(() => answer, () => { state.rows = rows; });
        const h = harness(state);
        act(() => { h.current.draft(); });
        act(() => { h.current.submitDescription(''); });
        await waitFor(() => { expect(h.current.status).toBe('error'); });
        expect(h.current.error).toBe('The list changed while the draft was running. Try again.');
        expect(h.current.dialogMode).toBe('rework');
        expect(h.onReview).not.toHaveBeenCalled();
      });
    }
  }

  test('a stale seed answer fills nothing', async () => {
    const state: { rows: readonly OptionDraft[] } = { rows: [] };
    draftServer(() => ({ kind: 'list', name: null, options: [{ value: 'a green scarf', weight: 1 }] }), () => { state.rows = [row('typed', 'a typed scarf')]; });
    const h = harness(state);
    act(() => { h.current.draft(); });
    act(() => { h.current.submitDescription('scarves'); });
    await waitFor(() => { expect(h.current.status).toBe('error'); });
    expect(h.onSeed).not.toHaveBeenCalled();
  });
});
