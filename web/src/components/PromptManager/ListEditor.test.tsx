import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PromptLibraryResponse, VariableList } from '@atelier/shared';
import { MAX_OPTIONS_PER_LIST } from '@atelier/shared';
import { promptKeys } from '../../api/prompts';
import ListEditor from './ListEditor';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; mock.restore(); cleanup(); });

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
function list(options: { id: string; value: string; weight?: number }[] = []): VariableList {
  return {
    id: 'list-1', name: 'Colours', sortOrder: 0, createdAt: 0, updatedAt: 0,
    options: options.map((o, i) => ({
      id: o.id,
      listId: 'list-1',
      value: o.value,
      tagIds: [],
      sortOrder: i,
      weight: o.weight ?? 1,
    })),
  };
}
// The draft route streams its result as SSE: success/clarify ride a terminal
// `done` frame. (Failures stay plain JSON — see responseFetch.)
function jsonFetch(body: unknown) {
  return mock(() => Promise.resolve(new Response(`event: done\ndata: ${JSON.stringify(body)}\n\n`, {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  })));
}
function responseFetch(status: number, body: unknown) {
  return mock(() => Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })));
}
function noContentFetch() {
  return mock((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 204 })));
}

function hasBodyInit(value: unknown): value is { readonly body?: BodyInit | null } {
  return typeof value === 'object' && value !== null && 'body' in value;
}

function requestBody(call: readonly unknown[] | undefined): unknown {
  const init = call?.[1];
  const body = hasBodyInit(init) ? init.body : undefined;
  if (typeof body !== 'string') throw new Error('expected string request body');
  return JSON.parse(body) as unknown;
}

describe('ListEditor — tag polarity', () => {
  const dims = [{
    id: 'dim-1',
    name: 'Milieu',
    tags: [{ id: 'tag-wild', dimensionId: 'dim-1', label: 'wild-outdoor', sortOrder: 0 }],
  }];

  test('a chip cycles not set -> required -> excluded -> not set', () => {
    wrap(<ListEditor list={list([{ id: 'o1', value: 'red' }])} dimensions={dims} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show tags for red' }));

    const chip = () => screen.getByRole('button', { name: /^wild-outdoor: / });
    expect(chip().getAttribute('data-polarity')).toBe('off');
    fireEvent.click(chip());
    expect(chip().getAttribute('data-polarity')).toBe('require');
    fireEvent.click(chip());
    expect(chip().getAttribute('data-polarity')).toBe('exclude');
    fireEvent.click(chip());
    expect(chip().getAttribute('data-polarity')).toBe('off');
  });

  test('an excluded tag is sent as excludeTagIds, not tagIds', async () => {
    const fetchMock = responseFetch(200, list([{ id: 'o1', value: 'red' }]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    wrap(<ListEditor list={list([{ id: 'o1', value: 'red' }])} dimensions={dims} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show tags for red' }));
    const chip = () => screen.getByRole('button', { name: /^wild-outdoor: / });
    fireEvent.click(chip());
    fireEvent.click(chip()); // -> excluded
    fireEvent.click(screen.getByRole('button', { name: 'Save list' }));

    await waitFor(() => {
      // The fetch mock takes no declared params, so its recorded calls are typed as
      // an empty tuple — re-type them to read the request we actually sent.
      // The fetch mock takes no declared params, so its recorded calls are typed as
      // an empty tuple — re-type them to read the request we actually sent.
      const calls = fetchMock.mock.calls as unknown as [string, { body: string }][];
      const call = calls.find((entry) => entry[0].endsWith('/options'));
      if (!call) throw new Error('no PUT to /options was sent');
      const sent = JSON.parse(call[1].body) as { options: { tagIds: string[]; excludeTagIds: string[] }[] };
      expect(sent.options[0]?.tagIds).toEqual([]);
      expect(sent.options[0]?.excludeTagIds).toEqual(['tag-wild']);
    });
  });
});

describe('ListEditor — option identity', () => {
  interface SentOption { id?: string; value: string; sortOrder: number }

  function putCall(fetchMock: ReturnType<typeof mock>): { options: SentOption[] } | undefined {
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit | undefined][];
    const call = calls.find((entry) => entry[0].endsWith('/options') && entry[1]?.method === 'PUT');
    return call ? requestBody(call) as { options: SentOption[] } : undefined;
  }

  test('renaming an option keeps its id on the PUT and in the optimistic cache', async () => {
    const original = list([{ id: 'o1', value: 'red' }, { id: 'o2', value: 'blue' }]);
    const renamed = list([{ id: 'o1', value: 'crimson' }, { id: 'o2', value: 'blue' }]);
    let finishPut: () => void = () => undefined;
    const fetchMock = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
      if (init?.method === 'PUT') {
        return new Promise<Response>((resolve) => { finishPut = () => { resolve(json(renamed)); }; });
      }
      return Promise.resolve(json({ templates: [], variableLists: [renamed], dimensions: [] }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<PromptLibraryResponse>(promptKeys.library(), { templates: [], variableLists: [original], dimensions: [] });
    render(<QueryClientProvider client={client}><ListEditor list={original} dimensions={[]} /></QueryClientProvider>);

    fireEvent.change(screen.getByRole('textbox', { name: 'Option 1: red' }), { target: { value: 'crimson' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save list' }));

    await waitFor(() => { expect(putCall(fetchMock)).toBeDefined(); });
    expect(putCall(fetchMock)?.options).toEqual([
      expect.objectContaining({ id: 'o1', value: 'crimson', sortOrder: 0 }),
      expect.objectContaining({ id: 'o2', value: 'blue', sortOrder: 1 }),
    ]);
    // A picker pin addresses the option id, so it still resolves to the row.
    const cached = client.getQueryData<PromptLibraryResponse>(promptKeys.library());
    expect(cached?.variableLists[0]?.options.find((option) => option.id === 'o1')?.value).toBe('crimson');

    finishPut();
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Option 1: crimson' }).disabled).toBe(false);
    });
  });

  test('a new row is sent without an id, adopts the server id, and later weight edits PATCH it', async () => {
    const saved = list([{ id: 'o-new', value: 'green' }, { id: 'o1', value: 'red' }]);
    const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve(new Response(JSON.stringify(saved), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (init?.method === 'PATCH') return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(new Response(JSON.stringify({ templates: [], variableLists: [saved], dimensions: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <ListEditor list={list([{ id: 'o1', value: 'red' }])} dimensions={[]} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /\+ add option/i }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Option 1' }), { target: { value: 'green' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save list' }));

    await waitFor(() => { expect(putCall(fetchMock)).toBeDefined(); });
    const sent = putCall(fetchMock)?.options ?? [];
    expect(sent[0]?.value).toBe('green');
    expect(sent[0]?.sortOrder).toBe(0);
    expect(sent[0]?.id).toBeUndefined();
    expect(sent[1]?.id).toBe('o1');
    expect(sent[1]?.value).toBe('red');
    expect(sent[1]?.sortOrder).toBe(1);
    // Inputs re-enable once the save settled and its keys were reconciled.
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Option 1: green' }).disabled).toBe(false);
    });

    // The parent re-renders with the cached server list after the save.
    view.rerender(
      <QueryClientProvider client={client}>
        <ListEditor list={saved} dimensions={[]} />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save list' }).disabled).toBe(true);
    });

    const weight = screen.getAllByRole('spinbutton', { name: /how often this option appears/i })[0];
    if (!weight) throw new Error('missing weight input');
    fireEvent.change(weight, { target: { value: '5' } });
    fireEvent.blur(weight);

    await waitFor(() => {
      const calls = fetchMock.mock.calls as unknown as [string, RequestInit | undefined][];
      expect(calls.some(([url, init]) => init?.method === 'PATCH' && url === '/api/prompts/lists/list-1/options/o-new')).toBe(true);
    });
  });
});

describe('ListEditor — AI Draft List', () => {
  test('weight input renders for each option with the persisted value', () => {
    wrap(<ListEditor list={list([{ id: 'o1', value: 'red', weight: 7 }])} dimensions={[]} />);

    const input = screen.getByRole('spinbutton', {
      name: /how often this option appears when picked randomly/i,
    });
    expect(input).toHaveProperty('value', '7');
  });

  test('weight 0 is presented as manual only and remains inside the input contract', () => {
    wrap(<ListEditor list={list([{ id: 'o1', value: 'red', weight: 0 }])} dimensions={[]} />);

    const input = screen.getByRole('spinbutton', {
      name: /0 means it is never picked randomly and can only be chosen by pinning/i,
    });
    expect(input).toHaveProperty('value', '0');
    expect(input.getAttribute('min')).toBe('0');
    expect(screen.getByText('Manual only')).toBeTruthy();
  });

  test('weight input PATCHes on blur and preserves the option id', async () => {
    const f = noContentFetch();
    globalThis.fetch = f as unknown as typeof fetch;
    wrap(<ListEditor list={list([{ id: 'o1', value: 'red', weight: 1 }])} dimensions={[]} />);

    const input = screen.getByRole('spinbutton', {
      name: /how often this option appears when picked randomly/i,
    });
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.blur(input);

    await waitFor(() => { expect(f).toHaveBeenCalled(); });
    const call = f.mock.calls[0];
    expect(call?.[0]).toBe('/api/prompts/lists/list-1/options/o1');
    expect(call?.[1]?.method).toBe('PATCH');
    expect(requestBody(call)).toEqual({ weight: 9 });
  });

  test('weight input clamps out-of-range values and announces the clamp', async () => {
    const f = noContentFetch();
    globalThis.fetch = f as unknown as typeof fetch;
    wrap(<ListEditor list={list([{ id: 'o1', value: 'red', weight: 1 }])} dimensions={[]} />);

    const input = screen.getByRole('spinbutton', {
      name: /how often this option appears when picked randomly/i,
    });
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(input).toHaveProperty('value', '100');
      expect(screen.getByRole('status').textContent).toBe('Weight clamped to 100');
    });
    const call = f.mock.calls[0];
    expect(requestBody(call)).toEqual({ weight: 100 });
  });

  test('negative weight input clamps to manual-only weight 0 and announces the clamp', async () => {
    const f = noContentFetch();
    globalThis.fetch = f as unknown as typeof fetch;
    wrap(<ListEditor list={list([{ id: 'o1', value: 'red', weight: 1 }])} dimensions={[]} />);

    const input = screen.getByRole('spinbutton', {
      name: /how often this option appears when picked randomly/i,
    });
    fireEvent.change(input, { target: { value: '-10' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(input).toHaveProperty('value', '0');
      expect(screen.getByRole('status').textContent).toBe('Weight clamped to 0');
    });
    const call = f.mock.calls[0];
    expect(requestBody(call)).toEqual({ weight: 0 });
  });

  test('button disabled when the name is empty', () => {
    wrap(<ListEditor list={{ ...list(), name: '' }} dimensions={[]} />);
    const btn = screen.getByRole('button', { name: /draft list/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute('data-tip')).toBe('Name the list first');
  });

  test('button stays enabled when the list has 20 options', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, value: `v${i}` }));
    wrap(<ListEditor list={list(twenty)} dimensions={[]} />);
    const btn = screen.getByRole('button', { name: /draft list/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  test('button stays enabled one option below the cap', () => {
    const nearFull = Array.from({ length: MAX_OPTIONS_PER_LIST - 1 }, (_, i) => ({ id: `o${i}`, value: `v${i}` }));
    wrap(<ListEditor list={list(nearFull)} dimensions={[]} />);
    const btn = screen.getByRole('button', { name: /draft list/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  test('button disabled when the list is at the option cap', () => {
    const full = Array.from({ length: MAX_OPTIONS_PER_LIST }, (_, i) => ({ id: `o${i}`, value: `v${i}` }));
    wrap(<ListEditor list={list(full)} dimensions={[]} />);
    const btn = screen.getByRole('button', { name: /draft list/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute('data-tip')).toBe(`List is at the ${MAX_OPTIONS_PER_LIST}-option limit`);
  });

  test('drafted entries are appended (deduped) and mark the form dirty', async () => {
    globalThis.fetch = jsonFetch({ kind: 'entries', entries: ['blue', 'green'] }) as unknown as typeof fetch;
    wrap(<ListEditor list={list([{ id: 'o1', value: 'red' }])} dimensions={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft list/i }));
    await waitFor(() => {
      expect(screen.getByDisplayValue('blue')).toBeDefined();
      expect(screen.getByDisplayValue('green')).toBeDefined();
    });
    expect(screen.getByDisplayValue('red')).toBeDefined();
    const saveBtn = screen.getByRole('button', { name: /save list/i });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(false);
  });

  test('a clarify response opens the describe dialog for a non-empty list', async () => {
    globalThis.fetch = jsonFetch({ kind: 'clarify', question: 'Which colours?' }) as unknown as typeof fetch;
    wrap(<ListEditor list={{ ...list([{ id: 'o1', value: 'red' }]), name: 'X' }} dimensions={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft list/i }));
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeDefined();
      expect(screen.getByText('Which colours?')).toBeDefined();
    });
  });

  test('empty list opens the seed dialog without firing the draft mutation', () => {
    const f = jsonFetch({ kind: 'entries', entries: ['blue'] });
    globalThis.fetch = f as unknown as typeof fetch;
    wrap(<ListEditor list={list()} dimensions={[]} />);
    const btn = screen.getByRole('button', { name: /draft list/i });
    expect(btn.getAttribute('data-tip')).toBe('Describe the list and generate up to 10 starter entries');
    fireEvent.click(btn);
    expect(f).not.toHaveBeenCalled();
    expect(screen.getByText('Drafting…')).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText(
      'Describe what this list should contain. The AI will generate up to 10 starter entries you can edit, reorder, or delete.',
    )).toBeDefined();
  });

  test('seed description submit appends entries and closes the dialog', async () => {
    globalThis.fetch = jsonFetch({ kind: 'entries', entries: ['blue', 'green'] }) as unknown as typeof fetch;
    wrap(<ListEditor list={list()} dimensions={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft list/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /list description/i }), { target: { value: 'paint colours' } });
    fireEvent.click(screen.getByRole('button', { name: /generate list/i }));
    await waitFor(() => {
      expect(screen.getByDisplayValue('blue')).toBeDefined();
      expect(screen.getByDisplayValue('green')).toBeDefined();
    });
    // Dismissal rides the shared exit transition (useExitTransition).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('seed description failure keeps the dialog mounted with an inline error', async () => {
    globalThis.fetch = responseFetch(502, { error: 'upstream unavailable' }) as unknown as typeof fetch;
    wrap(<ListEditor list={list()} dimensions={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft list/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /list description/i }), { target: { value: 'paint colours' } });
    fireEvent.click(screen.getByRole('button', { name: /generate list/i }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('Something went wrong on our end. Please try again.');
    });
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  test('cancel from seed dialog leaves the editor empty without appending entries', async () => {
    const f = jsonFetch({ kind: 'entries', entries: ['blue'] });
    globalThis.fetch = f as unknown as typeof fetch;
    wrap(<ListEditor list={list()} dimensions={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft list/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Add options to make this list usable in templates.')).toBeDefined();
  });

  test('cancel then reopen seed dialog starts with a blank textarea', async () => {
    wrap(<ListEditor list={list()} dimensions={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft list/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /list description/i }), { target: { value: 'paint colours' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    fireEvent.click(screen.getByRole('button', { name: /draft list/i }));
    expect(screen.getByRole('textbox', { name: /list description/i })).toHaveProperty('value', '');
  });

  test('tooltip switches from seed copy to expand copy once the list has content', () => {
    wrap(<ListEditor list={list()} dimensions={[]} />);
    expect(screen.getByRole('button', { name: /draft list/i }).getAttribute('data-tip'))
      .toBe('Describe the list and generate up to 10 starter entries');
    fireEvent.click(screen.getByRole('button', { name: /\+ add option/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /option 1/i }), { target: { value: 'red' } });
    expect(screen.getByRole('button', { name: /draft list/i }).getAttribute('data-tip'))
      .toBe('Generate ~20 more entries with the text model assigned to this task');
  });

  test('blank option rows still trigger the seed dialog', () => {
    const f = jsonFetch({ kind: 'entries', entries: ['blue'] });
    globalThis.fetch = f as unknown as typeof fetch;
    wrap(<ListEditor list={list()} dimensions={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ add option/i }));
    fireEvent.click(screen.getByRole('button', { name: /\+ add option/i }));
    fireEvent.click(screen.getByRole('button', { name: /draft list/i }));
    expect(f).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText(/up to 10 starter entries/)).toBeDefined();
  });
});
