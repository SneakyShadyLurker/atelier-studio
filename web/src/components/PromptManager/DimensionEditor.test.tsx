import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { TagDimension } from '@atelier/shared';
import { useAtelierStore } from '../../store/atelier';
import DimensionEditor from './DimensionEditor';

afterEach(() => {
  mock.restore();
  cleanup();
  useAtelierStore.setState({ toasts: [] });
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// Captures every tag PUT body; `respond` decides each reply (or defers it).
function captureTagPuts(respond: (body: { tags: Record<string, unknown>[] }, call: number) => Response | Promise<Response>) {
  const bodies: string[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    if (requestUrl(input).endsWith('/prompts/dimensions/dim-1/tags') && init?.method === 'PUT' && typeof init.body === 'string') {
      bodies.push(init.body);
      return respond(JSON.parse(init.body) as { tags: Record<string, unknown>[] }, bodies.length);
    }
    return Response.json({ templates: [], variableLists: [], dimensions: [] });
  }) as unknown as typeof fetch;
  return bodies;
}

// Echoes a tag PUT as the server would: supplied ids kept, new rows minted.
function echoSaved(body: { tags: Record<string, unknown>[] }, mint: (index: number) => string): TagDimension {
  return {
    ...dimension,
    tags: body.tags.map((tag, index) => ({
      id: typeof tag.id === 'string' ? tag.id : mint(index),
      dimensionId: 'dim-1',
      label: String(tag.label),
      sortOrder: Number(tag.sortOrder),
      ...(typeof tag.parentId === 'string' ? { parentId: tag.parentId } : {}),
    })),
  };
}

async function flushSettlement(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const dimension: TagDimension = {
  id: 'dim-1',
  name: 'Epoch',
  tags: [
    { id: 't1', dimensionId: 'dim-1', label: 'ancient', sortOrder: 0 },
    { id: 't2', dimensionId: 'dim-1', label: 'modern', sortOrder: 1 },
  ],
};

describe('DimensionEditor — hierarchy and description', () => {
  test('tag-only edits save without renaming when the name field is cleared', async () => {
    const onRename = mock((_: string, __?: string) => undefined);
    const bodies = captureTagPuts((body) => Response.json(echoSaved(body, (index) => `saved-${index}`)));
    wrap(<DimensionEditor dimension={dimension} onRename={onRename} />);
    fireEvent.change(screen.getByLabelText('Dimension name'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Parent of ancient'), { target: { value: 't2' } });
    const save = screen.getByRole('button', { name: /save dimension/i });
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);
    await waitFor(() => { expect(bodies).toHaveLength(1); });
    expect(onRename).not.toHaveBeenCalled();
  });

  test('description edits retain the saved name when the name field is cleared', () => {
    const onRename = mock((_: string, __?: string) => undefined);
    wrap(<DimensionEditor dimension={dimension} onRename={onRename} />);
    fireEvent.change(screen.getByLabelText('Dimension name'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Dimension description'), { target: { value: 'time of day' } });
    fireEvent.click(screen.getByRole('button', { name: /save dimension/i }));
    expect(onRename).toHaveBeenCalledWith('Epoch', 'time of day');
  });

  test('an over-length restored name cannot be submitted with description edits', () => {
    const onRename = mock((_: string, __?: string) => undefined);
    wrap(<DimensionEditor dimension={dimension} onRename={onRename} />);
    fireEvent.change(screen.getByLabelText('Dimension name'), { target: { value: 'x'.repeat(65) } });
    fireEvent.change(screen.getByLabelText('Dimension description'), { target: { value: 'time of day' } });
    expect(screen.getByRole('button', { name: /save dimension/i }).hasAttribute('disabled')).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: 'Edit dimension Epoch' }));
    expect(onRename).not.toHaveBeenCalled();
  });

  test('a tag cannot be offered itself as a parent, and picking one marks dirty', () => {
    wrap(<DimensionEditor dimension={dimension} onRename={() => undefined} />);
    const parentOfAncient = screen.getByLabelText<HTMLSelectElement>('Parent of ancient');
    const offered = [...parentOfAncient.options].map((option) => option.textContent);
    expect(offered).toEqual(['no parent', '↳ modern']);

    expect(screen.getByRole('button', { name: /save dimension/i }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(parentOfAncient, { target: { value: 't2' } });
    expect(screen.getByRole('button', { name: /save dimension/i }).hasAttribute('disabled')).toBe(false);
  });

  test('a tag already parented cannot become its own descendant’s child', () => {
    const nested: TagDimension = {
      ...dimension,
      // modern -> ancient, so ancient must not be offered "modern" as its parent.
      tags: [
        { id: 't1', dimensionId: 'dim-1', label: 'ancient', sortOrder: 0 },
        { id: 't2', dimensionId: 'dim-1', label: 'modern', sortOrder: 1, parentId: 't1' },
      ],
    };
    wrap(<DimensionEditor dimension={nested} onRename={() => undefined} />);
    const offered = [...screen.getByLabelText<HTMLSelectElement>('Parent of ancient').options]
      .map((option) => option.textContent);
    expect(offered).toEqual(['no parent']);
  });

  test('editing the description alone enables Save and reaches onRename', () => {
    const onRename = mock((_: string, __?: string) => undefined);
    wrap(<DimensionEditor dimension={dimension} onRename={onRename} />);
    fireEvent.change(screen.getByLabelText('Dimension description'), {
      target: { value: '  the hour this reads as  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save dimension/i }));
    expect(onRename).toHaveBeenCalledWith('Epoch', 'the hour this reads as');
  });
});

describe('DimensionEditor — name-save contract', () => {
  test('blurring the name does NOT commit (no commit-on-blur)', () => {
    const onRename = mock((_: string) => undefined);
    wrap(<DimensionEditor dimension={dimension} onRename={onRename} />);
    const field = screen.getByLabelText('Dimension name');
    fireEvent.change(field, { target: { value: 'Era' } });
    fireEvent.blur(field);
    expect(onRename).not.toHaveBeenCalled();
  });

  test('"Save dimension" commits the trimmed name via onRename', () => {
    const onRename = mock((_: string, __?: string) => undefined);
    wrap(<DimensionEditor dimension={dimension} onRename={onRename} />);
    const field = screen.getByLabelText('Dimension name');
    fireEvent.change(field, { target: { value: '  Era  ' } });
    fireEvent.click(screen.getByRole('button', { name: /save dimension/i }));
    // Second arg is the description, undefined when it was not edited.
    expect(onRename).toHaveBeenCalledWith('Era', undefined);
  });

  test('Save is disabled until the name (or tags) change', () => {
    wrap(<DimensionEditor dimension={dimension} onRename={() => undefined} />);
    const save = screen.getByRole('button', { name: /save dimension/i });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Dimension name'), { target: { value: 'Era' } });
    expect(save.hasAttribute('disabled')).toBe(false);
  });

  test('Save stays disabled while a rename is pending (no duplicate PATCH)', () => {
    wrap(<DimensionEditor dimension={dimension} onRename={() => undefined} renamePending />);
    fireEvent.change(screen.getByLabelText('Dimension name'), { target: { value: 'Era' } });
    expect(screen.getByRole('button', { name: /save dimension/i }).hasAttribute('disabled')).toBe(true);
  });

  test('re-seeds the name field when the dimension is renamed externally', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = render(
      <QueryClientProvider client={qc}><DimensionEditor dimension={dimension} onRename={() => undefined} /></QueryClientProvider>,
    );
    expect(screen.getByDisplayValue('Epoch')).toBeTruthy();
    view.rerender(
      <QueryClientProvider client={qc}><DimensionEditor dimension={{ ...dimension, name: 'Era' }} onRename={() => undefined} /></QueryClientProvider>,
    );
    expect(screen.getByDisplayValue('Era')).toBeTruthy();
  });
});

describe('DimensionEditor — parent links on removal', () => {
  const tree: TagDimension = {
    ...dimension,
    tags: [
      { id: 't1', dimensionId: 'dim-1', label: 'ancient', sortOrder: 0 },
      { id: 't2', dimensionId: 'dim-1', label: 'classical', sortOrder: 1, parentId: 't1' },
      { id: 't3', dimensionId: 'dim-1', label: 'hellenistic', sortOrder: 2, parentId: 't2' },
    ],
  };
  const expectedTags = [
    { id: 't2', label: 'classical', sortOrder: 0, parentId: null },
    { id: 't3', label: 'hellenistic', sortOrder: 1, parentId: 't2' },
  ];

  test('removing a parent unparents its children, keeps grandchildren, and saves', async () => {
    const bodies = captureTagPuts((body) => Response.json(echoSaved(body, (index) => `minted-${index}`)));
    wrap(<DimensionEditor dimension={tree} onRename={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag ancient' }));
    expect(screen.getByLabelText<HTMLSelectElement>('Parent of classical').value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /save dimension/i }));

    await waitFor(() => { expect(bodies).toHaveLength(1); });
    expect((JSON.parse(bodies[0] ?? '{}') as { tags: unknown }).tags).toEqual(expectedTags);
    await waitFor(() => { expect(useAtelierStore.getState().toasts.some((toast) => toast.text === 'Dimension saved')).toBe(true); });
  });

  test('blanking a parent drops it and its children’s links from the payload', async () => {
    const bodies = captureTagPuts((body) => Response.json(echoSaved(body, (index) => `minted-${index}`)));
    wrap(<DimensionEditor dimension={tree} onRename={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Tag 1: ancient'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /save dimension/i }));

    await waitFor(() => { expect(bodies).toHaveLength(1); });
    expect((JSON.parse(bodies[0] ?? '{}') as { tags: unknown }).tags).toEqual(expectedTags);
    await waitFor(() => { expect(useAtelierStore.getState().toasts.some((toast) => toast.text === 'Dimension saved')).toBe(true); });
  });
});

describe('DimensionEditor — own optimistic rename and rollback', () => {
  function harness(onRename: (name: string, description?: string) => Promise<unknown>) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const ui = (dim: TagDimension, pending: boolean) => (
      <QueryClientProvider client={qc}>
        <DimensionEditor dimension={dim} onRename={onRename} renamePending={pending} />
      </QueryClientProvider>
    );
    const view = render(ui(dimension, false));
    return { rerender: (dim: TagDimension, pending: boolean) => { view.rerender(ui(dim, pending)); } };
  }
  const nameValue = () => screen.getByLabelText<HTMLInputElement>('Dimension name').value;
  const descriptionValue = () => screen.getByLabelText<HTMLInputElement>('Dimension description').value;

  test('a failed save keeps the submitted text through a batched rollback and later external renames', async () => {
    let rejectRename: (error: Error) => void = () => undefined;
    const { rerender } = harness(() => new Promise((_, reject) => { rejectRename = reject; }));
    fireEvent.change(screen.getByLabelText('Dimension name'), { target: { value: 'Era' } });
    fireEvent.change(screen.getByLabelText('Dimension description'), { target: { value: 'Visual period' } });
    fireEvent.click(screen.getByRole('button', { name: /save dimension/i }));

    rerender({ ...dimension, name: 'Era', description: 'Visual period' }, true);
    // Rollback and pending=false land in one render, before the Promise rejects.
    rerender(dimension, false);
    expect(nameValue()).toBe('Era');
    expect(descriptionValue()).toBe('Visual period');

    rejectRename(new Error('Rename refused'));
    await flushSettlement();
    expect(nameValue()).toBe('Era');
    expect(descriptionValue()).toBe('Visual period');
    expect(screen.getByRole('button', { name: /save dimension/i }).hasAttribute('disabled')).toBe(false);
    expect(useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true);

    rerender({ ...dimension, name: 'Period' }, false);
    expect(nameValue()).toBe('Era');
  });

  test('after a successful save, a clean field follows a later external rename again', async () => {
    let resolveRename: (value: unknown) => void = () => undefined;
    const { rerender } = harness(() => new Promise((resolve) => { resolveRename = resolve; }));
    fireEvent.change(screen.getByLabelText('Dimension name'), { target: { value: 'Era' } });
    fireEvent.click(screen.getByRole('button', { name: /save dimension/i }));
    rerender({ ...dimension, name: 'Era' }, true);
    resolveRename(undefined);
    await flushSettlement();
    rerender({ ...dimension, name: 'Era' }, false);
    expect(nameValue()).toBe('Era');

    rerender({ ...dimension, name: 'Period', description: 'Set elsewhere' }, false);
    expect(nameValue()).toBe('Period');
    expect(descriptionValue()).toBe('Set elsewhere');
  });
});

describe('DimensionEditor — saved tag ids while the request is in flight', () => {
  test('rows added and reordered during a save adopt their ids, so the next save sends them', async () => {
    let releaseFirst: () => void = () => undefined;
    const bodies = captureTagPuts((body, call) => {
      const saved = Response.json(echoSaved(body, (index) => `persisted-${call}-${index}`));
      if (call > 1) return saved;
      return new Promise<Response>((resolve) => { releaseFirst = () => { resolve(saved); }; });
    });
    wrap(<DimensionEditor dimension={dimension} onRename={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '+ Add tag' }));
    fireEvent.change(screen.getByLabelText('Tag 1'), { target: { value: 'medieval' } });
    fireEvent.click(screen.getByRole('button', { name: /save dimension/i }));
    await waitFor(() => { expect(bodies).toHaveLength(1); });

    // Structural edits stay available while the save is in flight.
    fireEvent.click(screen.getByRole('button', { name: '+ Add tag' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder medieval' }), { key: 'ArrowDown', altKey: true });
    releaseFirst();
    await waitFor(() => { expect(useAtelierStore.getState().toasts.some((toast) => toast.text === 'Dimension saved')).toBe(true); });

    fireEvent.change(screen.getByLabelText('Tag 1'), { target: { value: 'future' } });
    fireEvent.click(screen.getByRole('button', { name: /save dimension/i }));
    await waitFor(() => { expect(bodies).toHaveLength(2); });
    const second = bodies[1] ?? '';
    expect(second.includes('draft:')).toBe(false);
    const sent = (JSON.parse(second) as { tags: { id?: string; label: string }[] }).tags;
    expect(sent.map((tag) => [tag.label, tag.id ?? null])).toEqual([
      ['future', null],
      ['ancient', 't1'],
      ['medieval', 'persisted-1-0'],
      ['modern', 't2'],
    ]);
  });
});
