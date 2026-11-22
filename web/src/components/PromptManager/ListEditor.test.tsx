import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PromptLibraryResponse, TextModelsResponse, VariableList } from '@atelier/shared';
import { MAX_OPTIONS_PER_LIST, TEXT_TASKS } from '@atelier/shared';
import { promptKeys } from '../../api/prompts';
import { useAtelierStore } from '../../store/atelier';
import Toast from '../Toast';
import ListEditor from './ListEditor';
import { PromptDraftProvider, usePromptDraftStore, type PromptDraftStore } from './draftStore';
import { seedTextModelGate } from '../../../test/fixtures/textModelGate';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; mock.restore(); cleanup(); });

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  seedTextModelGate(client);
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

describe('ListEditor — weights', () => {
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

});

describe('ListEditor — tags disclosure', () => {
  const dims = [{
    id: 'dim-1',
    name: 'Milieu',
    tags: [{ id: 'tag-wild', dimensionId: 'dim-1', label: 'wild-outdoor', sortOrder: 0 }],
  }];

  test('the tag panel opens and closes on one mounted, inert-when-closed panel', () => {
    wrap(<ListEditor list={list([{ id: 'o1', value: 'red' }])} dimensions={dims} />);
    const show = screen.getByRole('button', { name: 'Show tags for red' });
    const panel = document.getElementById(show.getAttribute('aria-controls') ?? '');
    if (!panel) throw new Error('tag panel missing');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(show);
    expect(panel.getAttribute('data-open')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(false);
    const chip = screen.getByRole('button', { name: /^wild-outdoor: / });
    fireEvent.click(screen.getByRole('button', { name: 'Hide tags for red' }));
    expect(panel.hasAttribute('data-open')).toBe(false);
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.contains(chip)).toBe(true);
    expect(screen.queryByRole('button', { name: /^wild-outdoor: / })).toBeNull();
  });
});

// --- Draft List: dialog, review, Apply, Discard and Undo (spec list-draft-review R4 to R6) ---

const SCARF_DIMS = [{
  id: 'dim-1',
  name: 'Season',
  tags: [{ id: 'tag-winter', dimensionId: 'dim-1', label: 'winter', sortOrder: 0 }],
}];

const LISTING: TextModelsResponse = {
  models: [
    { id: 'writer-a', displayName: 'Writer A', providerName: 'Provider', vision: false, reasoningLevels: ['low', 'high'], status: 'available' },
    { id: 'writer-b', displayName: 'Writer B', providerName: 'Provider', vision: false, reasoningLevels: ['low', 'high'], status: 'available' },
  ],
  tasks: TEXT_TASKS.map((task) => (task === 'list-draft'
    ? { task, pick: 'writer-a', effectiveModelId: 'writer-a', pickState: 'active' }
    : { task, effectiveModelId: 'writer-a' })),
  defaults: { default: 'writer-a', byTask: {} },
  writers: {},
  lockedWriters: [],
};

function scarves(): VariableList {
  const values: [string, string, number, string[]][] = [
    ['o1', 'a red scarf', 1, ['tag-winter']],
    ['o2', 'a blue scarf', 1, []],
    ['o3', 'a white scarf', 2, []],
  ];
  return {
    id: 'list-1', name: 'scarf', sortOrder: 0, createdAt: 0, updatedAt: 0,
    options: values.map(([id, value, weight, tagIds], index) => ({ id, listId: 'list-1', value, tagIds, sortOrder: index, weight })),
  };
}

const REWORK_ANSWER = {
  kind: 'changes',
  baseCount: 3,
  changes: [
    { id: 0, op: 'edit', index: 0, value: 'a red silk scarf', weight: 5, why: 'Names the fabric.' },
    { id: 1, op: 'remove', index: 1, why: 'Too plain.' },
    { id: 2, op: 'add', value: 'a green scarf', weight: 1, why: 'Adds a colour.' },
  ],
  unplaced: [],
  summary: 'Named the fabric and swapped a colour.',
};

interface ServerCalls {
  order: string[];
  drafts: Record<string, unknown>[];
  picks: unknown[];
  puts: unknown[];
  patches: string[];
}

/** Routes the editor's requests and records them. `answers` are the draft answers in turn. */
function listServer(options: { answers?: readonly unknown[]; pickStatus?: number; patchStatus?: number; hold?: Promise<void>; saved?: VariableList } = {}): ServerCalls {
  const calls: ServerCalls = { order: [], drafts: [], picks: [], puts: [], patches: [] };
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    if (url.endsWith('/text-models/tasks/list-draft') && method === 'PUT') {
      calls.order.push('PUT pick');
      calls.picks.push(body);
      return Promise.resolve(options.pickStatus === undefined ? Response.json(LISTING) : Response.json({ error: 'nope' }, { status: options.pickStatus }));
    }
    if (url.endsWith('/text-models')) return Promise.resolve(Response.json(LISTING));
    if (url.endsWith('/prompts/lists/draft')) {
      calls.order.push('POST draft');
      calls.drafts.push(body as Record<string, unknown>);
      const answer = options.answers?.[calls.drafts.length - 1] ?? REWORK_ANSWER;
      return Promise.resolve(new Response(`event: done\ndata: ${JSON.stringify(answer)}\n\n`, {
        status: 200, headers: { 'Content-Type': 'text/event-stream' },
      }));
    }
    // `hold` keeps a save or a weight PATCH in flight until the test lets it go.
    const held = options.hold ?? Promise.resolve();
    if (method === 'PUT' && url.endsWith('/options')) {
      calls.puts.push(body);
      return held.then(() => Response.json(options.saved ?? scarves()));
    }
    if (method === 'PATCH') {
      calls.patches.push(url);
      const { patchStatus } = options;
      if (patchStatus !== undefined) return held.then(() => Response.json({ error: 'nope' }, { status: patchStatus }));
      return held.then(() => new Response(null, { status: 204 }));
    }
    return Promise.resolve(Response.json({ templates: [], variableLists: [options.saved ?? scarves()], dimensions: [] }));
  }) as unknown as typeof fetch;
  return calls;
}

interface Mounted {
  readonly store: PromptDraftStore;
  /** Mounts a new editor instance (on `target`) under the same draft store; null unmounts it. */
  readonly remount: (target: VariableList | null) => void;
}

/** The editor beside the real toast, inside a draft store, on the seeded text-model listing. */
function mountEditor(target: VariableList = scarves(), prepare?: (store: PromptDraftStore) => void): Mounted {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  seedTextModelGate(client, { models: LISTING });
  const holder: { store: PromptDraftStore | null } = { store: null };
  function Capture() {
    const store = usePromptDraftStore();
    if (holder.store === null && store !== null) {
      holder.store = store;
      prepare?.(store);
    }
    return null;
  }
  const ui = (key: number, shown: VariableList | null) => (
    <QueryClientProvider client={client}>
      <PromptDraftProvider>
        <Capture />
        {shown !== null && <ListEditor key={key} list={shown} dimensions={SCARF_DIMS} />}
        <Toast />
      </PromptDraftProvider>
    </QueryClientProvider>
  );
  let mounts = 0;
  const view = render(ui(mounts, target));
  if (holder.store === null) throw new Error('missing draft store');
  const store = holder.store;
  return {
    store,
    remount: (next) => {
      mounts += 1;
      view.rerender(ui(mounts, next));
    },
  };
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const head = () => document.querySelector('[data-zone="head"]');
const sheet = () => screen.queryByRole('group', { name: 'Options, under review' });
const optionValues = () => screen.queryAllByRole<HTMLInputElement>('textbox', { name: /^Option \d+/ }).map((input) => input.value);
const weights = () => screen.queryAllByRole<HTMLInputElement>('spinbutton').map((input) => input.value);
const undo = () => screen.getByRole('button', { name: 'Undo' });

async function openReview(instructions = 'name the fabric'): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: /^(Draft List|Rework again)$/ }));
  fireEvent.click(screen.getByRole('radio', { name: 'Rework' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Change instructions' }), { target: { value: instructions } });
  fireEvent.click(screen.getByRole('button', { name: 'Rework list' }));
  return screen.findByRole('group', { name: 'Options, under review' });
}

afterEach(() => { useAtelierStore.setState({ toasts: [] }); });

describe('ListEditor — Draft List button', () => {
  test('disabled without a name, with its tip', () => {
    wrap(<ListEditor list={{ ...list(), name: '' }} dimensions={[]} />);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Draft List' });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-tip')).toBe('Name the list first');
  });

  test('stays enabled at the option limit and opens on Rework with Add options off (R4.1)', () => {
    listServer();
    const full = Array.from({ length: MAX_OPTIONS_PER_LIST }, (_, i) => ({ id: `o${String(i)}`, value: `scarf ${String(i)}` }));
    wrap(<ListEditor list={list(full)} dimensions={[]} />);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Draft List' });
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('data-tip')).toBe('Describe what to add or change, and pick the text model that writes it');
    fireEvent.click(button);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Add options' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Rework' }).checked).toBe(true);
    expect(screen.getByText('This list is at its option limit, so there is no room to add.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Drafting…' })).toBeTruthy();
  });
});

describe('ListEditor — seed (R6.1)', () => {
  test('an empty list seeds: the answer replaces the blank rows as unsaved rows with their weights', async () => {
    const calls = listServer({ answers: [{ kind: 'list', name: null, options: [{ value: 'a red scarf', weight: 1 }, { value: 'a none scarf', weight: 9 }] }] });
    wrap(<ListEditor list={list()} dimensions={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ add option/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Draft List' }));
    expect(screen.getByRole('heading', { name: 'Describe the list' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'List description' }), { target: { value: 'scarves' } });
    fireEvent.click(screen.getByRole('button', { name: 'Draft list' }));
    await waitFor(() => { expect(optionValues()).toEqual(['a red scarf', 'a none scarf']); });
    expect(weights()).toEqual(['1', '9']);
    expect(calls.drafts).toEqual([{ mode: 'extend', name: 'Colours', options: [], description: 'scarves' }]);
    expect(sheet()).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save list' }).disabled).toBe(false);
  });
});

describe('ListEditor — review (R5)', () => {
  test('a changes answer opens the review in the body zone; Save, the table and Add option give way', async () => {
    const calls = listServer();
    mountEditor();
    const review = await openReview();
    expect(calls.drafts).toEqual([{
      mode: 'rework',
      name: 'scarf',
      options: [{ value: 'a red scarf', weight: 1 }, { value: 'a blue scarf', weight: 1 }, { value: 'a white scarf', weight: 2 }],
      description: 'name the fabric',
    }]);
    expect(document.querySelector('[data-zone="body"]')?.contains(review)).toBe(true);
    expect(optionValues()).toEqual([]);
    expect(head()?.contains(screen.getByRole('button', { name: 'Rework again' }))).toBe(true);
    expect(head()?.contains(screen.getByRole('button', { name: 'Discard' }))).toBe(true);
    expect(head()?.contains(screen.getByRole('button', { name: 'Apply 3 changes' }))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save list' })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /\+ add option/i }).disabled).toBe(true);
    expect(screen.getByText('Named the fabric and swapped a colour.')).toBeTruthy();
  });

  test('Apply writes the accepted changes: an edit keeps its key and tags, a removal goes, adds follow', async () => {
    listServer();
    const { store } = mountEditor();
    await openReview();
    fireEvent.click(within(screen.getByRole('group', { name: 'Change 2 of 3' })).getByRole('button', { name: 'Reject' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply 2 changes' }));
    await flush();
    expect(sheet()).toBeNull();
    expect(optionValues()).toEqual(['a red silk scarf', 'a blue scarf', 'a white scarf', 'a green scarf']);
    expect(weights()).toEqual(['5', '1', '2', '1']);
    expect(store.getListReview('list-1')).toBeUndefined();
    expect(useAtelierStore.getState().toasts.find((toast) => toast.text === 'Applied 2 changes')?.tone).toBe('success');
    fireEvent.click(screen.getByRole('button', { name: 'Show tags for a red silk scarf' }));
    expect(screen.getByRole('button', { name: 'winter: required' })).toBeTruthy();
    // Apply never saves: the list is unsaved work, and the edited row kept its id.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save list' }).disabled).toBe(false);
    expect(store.getList('list-1')?.options.map((row) => row.key).slice(0, 3)).toEqual(['o1', 'o2', 'o3']);
  });

  test('Apply then Undo restores the exact rows and the review with its decisions', async () => {
    listServer();
    const { store } = mountEditor();
    await openReview();
    fireEvent.click(within(screen.getByRole('group', { name: 'Change 3 of 3' })).getByRole('button', { name: 'Reject' }));
    const decided = store.getListReview('list-1');
    fireEvent.click(screen.getByRole('button', { name: 'Apply 2 changes' }));
    await flush();
    expect(optionValues()).toEqual(['a red silk scarf', 'a white scarf']);
    fireEvent.click(undo());
    await flush();
    expect(sheet()).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Change 3 of 3' }).getAttribute('data-decision')).toBe('rejected');
    expect(screen.getByRole('button', { name: 'Apply 2 changes' })).toBeTruthy();
    expect(store.getListReview('list-1')).toEqual(decided);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await flush();
    expect(optionValues()).toEqual(['a red scarf', 'a blue scarf', 'a white scarf']);
    expect(weights()).toEqual(['1', '1', '2']);
  });

  test('Discard then Undo restores the review; the rows never changed', async () => {
    listServer();
    const { store } = mountEditor();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Reject all' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Change 1 of 3' })).getByRole('button', { name: 'Accept' }));
    const decided = store.getListReview('list-1');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await flush();
    expect(sheet()).toBeNull();
    expect(optionValues()).toEqual(['a red scarf', 'a blue scarf', 'a white scarf']);
    expect(useAtelierStore.getState().toasts.find((toast) => toast.text === 'Changes discarded')?.tone).toBe('soft');
    fireEvent.click(undo());
    await flush();
    expect(store.getListReview('list-1')).toEqual(decided);
    expect(screen.getByRole('button', { name: 'Apply 1 change' })).toBeTruthy();
  });

  test('a tag change after Apply retires its Undo', async () => {
    listServer();
    mountEditor();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Show tags for a white scarf' }));
    fireEvent.click(screen.getByRole('button', { name: 'winter: not set' }));
    fireEvent.click(undo());
    await flush();
    expect(sheet()).toBeNull();
    expect(optionValues()).toEqual(['a red silk scarf', 'a white scarf', 'a green scarf']);
  });

  test("a save's key settlement after Apply retires its Undo", async () => {
    const saved: VariableList = {
      ...scarves(),
      options: [
        { id: 'o1', listId: 'list-1', value: 'a red silk scarf', tagIds: ['tag-winter'], sortOrder: 0, weight: 5 },
        { id: 'o3', listId: 'list-1', value: 'a white scarf', tagIds: [], sortOrder: 1, weight: 2 },
        { id: 'o-green', listId: 'list-1', value: 'a green scarf', tagIds: [], sortOrder: 2, weight: 1 },
      ],
    };
    const calls = listServer({ saved });
    mountEditor();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Save list' }));
    await waitFor(() => { expect(calls.puts).toHaveLength(1); });
    await waitFor(() => { expect(useAtelierStore.getState().toasts.some((toast) => toast.text === 'Variable list saved')).toBe(true); });
    fireEvent.click(undo());
    await flush();
    expect(sheet()).toBeNull();
    expect(optionValues()).toEqual(['a red silk scarf', 'a white scarf', 'a green scarf']);
  });

  test('at zero accepted changes with unsaved edits pending, no entry point applies or saves', async () => {
    const calls = listServer();
    mountEditor();
    // An unsaved edit before the draft: the review's base carries it.
    fireEvent.change(screen.getByRole('textbox', { name: 'Option 3: a white scarf' }), { target: { value: 'a cream scarf' } });
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Reject all' }));
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(apply);
    fireEvent.submit(screen.getByRole('form'));
    fireEvent.keyDown(screen.getByRole('group', { name: 'Change 1 of 3' }), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(screen.getByRole('group', { name: 'Change 1 of 3' }), { key: 'Enter', ctrlKey: true });
    await flush();
    expect(sheet()).not.toBeNull();
    expect(calls.puts).toEqual([]);
    expect(calls.patches).toEqual([]);
    expect(useAtelierStore.getState().toasts.some((toast) => toast.text.startsWith('Applied'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await flush();
    expect(optionValues()).toEqual(['a red scarf', 'a blue scarf', 'a cream scarf']);
  });

  test('Cmd/Ctrl+Enter applies from the form while changes are accepted', async () => {
    listServer();
    mountEditor();
    await openReview();
    fireEvent.keyDown(screen.getByRole('group', { name: 'Change 1 of 3' }), { key: 'Enter', ctrlKey: true });
    await flush();
    expect(sheet()).toBeNull();
    expect(optionValues()).toEqual(['a red silk scarf', 'a white scarf', 'a green scarf']);
  });

  test('Cmd/Ctrl+Enter inside the Rework again dialog leaves the review unapplied', async () => {
    const calls = listServer({ answers: [REWORK_ANSWER, { ...REWORK_ANSWER, changes: [], summary: 'Nothing else to change.' }] });
    mountEditor();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Rework again' }));
    const area = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Change instructions' });
    // The dialog reopens on the review's mode with its instructions.
    expect(area.value).toBe('name the fabric');
    fireEvent.keyDown(area, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true });
    await waitFor(() => { expect(screen.getByText('Nothing else to change.')).toBeTruthy(); });
    expect(calls.drafts).toHaveLength(2);
    expect(calls.drafts[1]).toMatchObject({ mode: 'rework', description: 'name the fabric' });
    expect(sheet()).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Apply 3 changes' })).toBeTruthy();
    expect(useAtelierStore.getState().toasts.some((toast) => toast.text.startsWith('Applied'))).toBe(false);
  });

  test('a failed Rework again leaves the review and its decisions as they were', async () => {
    listServer({ answers: [REWORK_ANSWER, { kind: 'changes', baseCount: 9, changes: [], unplaced: [], summary: null }] });
    mountEditor();
    await openReview();
    fireEvent.click(within(screen.getByRole('group', { name: 'Change 1 of 3' })).getByRole('button', { name: 'Reject' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rework again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rework list' }));
    await waitFor(() => { expect(screen.getByText("Couldn't draft the list.")).toBeTruthy(); });
    expect(screen.getByRole('group', { name: 'Change 1 of 3' }).getAttribute('data-decision')).toBe('rejected');
  });
});

describe('ListEditor — weights after a review (R5.11)', () => {
  test('a blur after an applied reweight sends no PATCH; a manual change does', async () => {
    const calls = listServer();
    mountEditor();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    await flush();
    const first = () => screen.getAllByRole<HTMLInputElement>('spinbutton')[0];
    const input = first();
    if (!input) throw new Error('missing weight input');
    expect(input.value).toBe('5');
    fireEvent.focus(input);
    fireEvent.blur(input);
    await flush();
    expect(calls.patches).toEqual([]);
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);
    await waitFor(() => { expect(calls.patches).toEqual(['/api/prompts/lists/list-1/options/o1']); });
  });

  test('a failed weight save returns to the applied weight, not the saved one', async () => {
    const calls = listServer({ patchStatus: 500 });
    mountEditor();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    await flush();
    const first = () => screen.getAllByRole<HTMLInputElement>('spinbutton')[0];
    const input = first();
    if (!input) throw new Error('missing weight input');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);
    await waitFor(() => { expect(calls.patches).toHaveLength(1); });
    // The server still holds 1; the reweight the user accepted was 5.
    await waitFor(() => { expect(first()?.value).toBe('5'); });
  });

  test('a weight save that fails after the editor closed restores the retained draft', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const calls = listServer({ patchStatus: 500, hold });
    const { store, remount } = mountEditor();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    await flush();
    const input = screen.getAllByRole<HTMLInputElement>('spinbutton')[0];
    if (!input) throw new Error('missing weight input');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);
    await waitFor(() => { expect(calls.patches).toHaveLength(1); });
    expect(store.getList('list-1')?.options[0]?.weight).toBe(7);
    // The editor closes while the PATCH is in flight, then the PATCH fails.
    remount(null);
    release();
    await waitFor(() => { expect(store.getList('list-1')?.options[0]?.weight).toBe(5); });
    expect(useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true);
    remount(scarves());
    expect(screen.getAllByRole<HTMLInputElement>('spinbutton')[0]?.value).toBe('5');
    expect(optionValues()[0]).toBe('a red silk scarf');
  });

  test('a weight save that fails after the editor closed leaves no draft when it was the only edit', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const calls = listServer({ patchStatus: 500, hold });
    const { store, remount } = mountEditor();
    const input = screen.getAllByRole<HTMLInputElement>('spinbutton')[0];
    if (!input) throw new Error('missing weight input');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);
    await waitFor(() => { expect(calls.patches).toHaveLength(1); });
    remount(null);
    release();
    await waitFor(() => { expect(useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true); });
    expect(store.getList('list-1')).toBeUndefined();
    expect(store.hasDrafts()).toBe(false);
  });

  test('a blur that changes nothing leaves the Undo of Apply working', async () => {
    listServer();
    mountEditor();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    await flush();
    for (const input of screen.getAllByRole<HTMLInputElement>('spinbutton')) {
      fireEvent.focus(input);
      fireEvent.blur(input);
    }
    await flush();
    fireEvent.click(undo());
    await flush();
    expect(sheet()).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Apply 3 changes' })).toBeTruthy();
  });
});

describe('ListEditor — focus after a review', () => {
  const firstOption = () => screen.getAllByRole<HTMLInputElement>('textbox', { name: /^Option \d+/ })[0];

  test('Apply hands focus to the first option', async () => {
    listServer();
    mountEditor();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    await flush();
    expect(document.activeElement === firstOption()).toBe(true);
  });

  test('Discard hands focus to the first option', async () => {
    listServer();
    mountEditor();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await flush();
    expect(document.activeElement === firstOption()).toBe(true);
  });

  test('with a save in flight the option fields are disabled, so Add option takes focus', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    listServer({ hold });
    mountEditor();
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Save list' }));
    await flush();
    // The save has not settled: Undo still reopens the review, and Apply ends it again.
    fireEvent.click(undo());
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 3 changes' }));
    await flush();
    expect(firstOption()?.disabled).toBe(true);
    expect(document.activeElement === screen.getByRole('button', { name: '+ Add option' })).toBe(true);
    release();
    await flush();
  });

  test('a review that removed every option hands focus to Add option', async () => {
    const one: VariableList = { ...scarves(), options: scarves().options.slice(0, 1) };
    listServer({ answers: [{ kind: 'changes', baseCount: 1, changes: [{ id: 0, op: 'remove', index: 0, why: 'Gone.' }], unplaced: [], summary: null }] });
    mountEditor(one);
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    await flush();
    expect(document.activeElement === screen.getByRole('button', { name: '+ Add option' })).toBe(true);
  });
});

describe('ListEditor — model choice (R4.3)', () => {
  test('the list-draft pick is saved before the draft; the request carries the image model', async () => {
    const previous = useAtelierStore.getState().draft;
    useAtelierStore.setState({ draft: { ...previous, modelId: 'image-model-a' } });
    try {
      const calls = listServer();
      mountEditor();
      fireEvent.click(screen.getByRole('button', { name: 'Draft List' }));
      const model = await screen.findByLabelText<HTMLSelectElement>('Model');
      expect(model.value).toBe('writer-a');
      fireEvent.change(model, { target: { value: 'writer-b' } });
      fireEvent.change(screen.getByRole('textbox', { name: 'What to add' }), { target: { value: 'more' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add options' }));
      await waitFor(() => { expect(calls.drafts).toHaveLength(1); });
      expect(calls.order).toEqual(['PUT pick', 'POST draft']);
      expect(calls.picks).toEqual([{ modelId: 'writer-b', effort: null }]);
      expect(calls.drafts[0]?.modelId).toBe('image-model-a');
    } finally {
      useAtelierStore.setState({ draft: previous });
    }
  });

  test('a rejected pick save shows inline and sends no draft', async () => {
    const calls = listServer({ pickStatus: 500 });
    mountEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Draft List' }));
    fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'writer-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add options' }));
    await waitFor(() => { expect(calls.picks).toHaveLength(1); });
    await waitFor(() => { expect(screen.getByRole('dialog').querySelector('[role="status"]')?.textContent).not.toBe(''); });
    expect(calls.drafts).toEqual([]);
    expect(screen.getByRole('heading', { name: 'Add to the list' })).toBeTruthy();
  });
});

describe('ListEditor — review in the draft store (R5.9)', () => {
  test('a remount reopens a fresh review; a stale one is dropped', async () => {
    listServer();
    const { store, remount } = mountEditor();
    await openReview();
    remount(null);
    expect(store.getListReview('list-1')).toBeDefined();
    remount(scarves());
    expect(sheet()).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Apply 3 changes' })).toBeTruthy();

    // The server's rows moved on: the stored review no longer fits and goes.
    remount(null);
    const moved = { ...scarves(), options: scarves().options.map((option) => (option.id === 'o2' ? { ...option, weight: 4 } : option)) };
    remount(moved);
    expect(sheet()).toBeNull();
    expect(optionValues()).toEqual(['a red scarf', 'a blue scarf', 'a white scarf']);
    await flush();
    expect(store.getListReview('list-1')).toBeUndefined();
  });

  test('a key settlement with only the review retained keeps it fresh for the next mount', () => {
    listServer();
    const settled: VariableList = { ...scarves(), options: [{ id: 'o-red', listId: 'list-1', value: 'a red scarf', tagIds: [], sortOrder: 0, weight: 1 }] };
    const { store, remount } = mountEditor(settled, (prepared) => {
      prepared.setListReview('list-1', {
        mode: 'extend',
        base: [{ key: 'draft:new', value: 'a red scarf', weight: 1 }],
        changes: [{ id: 0, op: 'add', value: 'a blue scarf', weight: 1, why: '' }],
        unplaced: [],
        summary: null,
        instructions: '',
        rejected: [],
      });
      // A save that settles while no editor is mounted and no list draft is retained.
      prepared.settleListOptionKeys('list-1', new Map([['draft:new', 'o-red']]));
    });
    expect(store.getList('list-1')).toBeUndefined();
    remount(settled);
    expect(sheet()).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Apply 1 change' })).toBeTruthy();
  });
});
