import type { LibraryDiagnosisResponse, PromptLibraryResponse } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { libraryDiagnosisKeys } from '../api/libraryDiagnosis';
import { promptKeys } from '../api/prompts';
import {
  useCreateTemplate,
  useDeleteDimension,
  useDeleteTemplate,
  useDimensionMetadataPending,
  useDimensionTagsPending,
  useListMutationPending,
  usePatchDimension,
  usePatchTemplate,
  useTemplatePatchPending,
  useReplaceOptions,
  useReplaceTags,
  useUpdateOption,
} from './usePromptMutations';

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const templateA = {
  id: '019e3d59-b283-744e-8f19-06deeb9c7b7a',
  name: 'Portrait',
  body: 'portrait',
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

const templateB = {
  id: '019e3d59-b283-744e-8f19-06deeb9c7b7b',
  name: 'Product',
  body: 'product',
  sortOrder: 1,
  createdAt: 2,
  updatedAt: 2,
};

const seedLibrary: PromptLibraryResponse = {
  templates: [
    templateA,
    templateB,
  ],
  variableLists: [],
  dimensions: [],
};

const seedLibraryWithOption: PromptLibraryResponse = {
  ...seedLibrary,
  variableLists: [
    {
      id: '019e3d59-b283-744e-8f19-06deeb9c7b7d',
      name: 'Style',
      sortOrder: 0,
      createdAt: 3,
      updatedAt: 3,
      options: [
        {
          id: '019e3d59-b283-744e-8f19-06deeb9c7b7e',
          listId: '019e3d59-b283-744e-8f19-06deeb9c7b7d',
          value: 'cinematic',
          tagIds: [],
          sortOrder: 0,
          weight: 1,
        },
      ],
    },
  ],
};

const seedDiagnosis: LibraryDiagnosisResponse = {
  templates: [
    {
      templateName: 'Portrait',
      satisfiable: true,
    },
  ],
  librarySnapshotHash: 'library-hash',
  templatesDigest: 'templates-digest',
};

afterEach(() => {
  cleanup();
  mock.restore();
});

describe('usePromptMutations', () => {
  test('useDeleteTemplate optimistically removes then rolls back on error', async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    globalThis.fetch = mock(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), seedLibrary);

    const { result } = renderHook(() => useDeleteTemplate(), { wrapper: wrapper(client) });
    let mutation: Promise<undefined> = Promise.resolve(undefined);
    await act(async () => {
      mutation = result.current.mutateAsync(templateA.id).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const optimistic = client.getQueryData<PromptLibraryResponse>(promptKeys.library());
    expect(optimistic?.templates.map((template) => template.id)).toEqual([templateB.id]);

    await act(async () => {
      resolveFetch(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
      await mutation;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const rolledBack = client.getQueryData<PromptLibraryResponse>(promptKeys.library());
    expect(rolledBack).toEqual(seedLibrary);
    expect(client.getQueryState(promptKeys.library())?.isInvalidated).toBe(true);
  });

  test('useCreateTemplate invalidates library on success', async () => {
    globalThis.fetch = mock(() => Response.json({
      id: '019e3d59-b283-744e-8f19-06deeb9c7b7c',
      name: 'New',
      body: 'new body',
      sortOrder: 2,
      createdAt: 3,
      updatedAt: 3,
    }, { status: 201 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), seedLibrary);

    const { result } = renderHook(() => useCreateTemplate(), { wrapper: wrapper(client) });

    await act(async () => {
      await result.current.mutateAsync({ name: 'New', body: 'new body' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(client.getQueryState(promptKeys.library())?.isInvalidated).toBe(true);
  });

  test('useUpdateOption invalidates library and diagnosis caches on success', async () => {
    globalThis.fetch = mock(() => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), seedLibraryWithOption);
    client.setQueryData(libraryDiagnosisKeys.current(), seedDiagnosis);

    const { result } = renderHook(() => useUpdateOption(), { wrapper: wrapper(client) });
    const list = seedLibraryWithOption.variableLists[0];
    const option = list?.options[0];
    if (!list || !option) throw new Error('expected seeded option');

    await act(async () => {
      await result.current.mutateAsync({
        listId: list.id,
        optionId: option.id,
        patch: { tagIds: ['019e3d59-b283-744e-8f19-06deeb9c7b7f'] },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(client.getQueryState(promptKeys.library())?.isInvalidated).toBe(true);
    expect(client.getQueryState(libraryDiagnosisKeys.current())?.isInvalidated).toBe(true);
  });

  test('prompt mutations are serialized so rollback cannot clobber a later optimistic write', async () => {
    let callCount = 0;
    let resolveDelete: (response: Response) => void = () => undefined;
    globalThis.fetch = mock(() => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<Response>((resolve) => {
          resolveDelete = resolve;
        });
      }
      return Response.json({ ...templateB, name: 'Product patched' });
    }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), seedLibrary);

    const { result } = renderHook(
      () => ({
        deleteTemplate: useDeleteTemplate(),
        patchTemplate: usePatchTemplate(),
      }),
      { wrapper: wrapper(client) },
    );

    let deleteMutation: Promise<undefined> = Promise.resolve(undefined);
    let patchMutation: Promise<unknown> = Promise.resolve(undefined);
    await act(async () => {
      deleteMutation = result.current.deleteTemplate.mutateAsync(templateA.id).catch(() => undefined);
      patchMutation = result.current.patchTemplate.mutateAsync({
        id: templateB.id,
        body: { name: 'Product patched' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(callCount).toBe(1);
    expect(client.getQueryData<PromptLibraryResponse>(promptKeys.library())?.templates).toEqual([templateB]);

    await act(async () => {
      resolveDelete(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
      await Promise.all([deleteMutation, patchMutation]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const final = client.getQueryData<PromptLibraryResponse>(promptKeys.library());
    expect(final?.templates.map((template) => ({ id: template.id, name: template.name }))).toEqual([
      { id: templateA.id, name: 'Portrait' },
      { id: templateB.id, name: 'Product patched' },
    ]);
  });

  test('a save started by an unmounted editor stays pending for its own list and dimension only', async () => {
    const list = seedLibraryWithOption.variableLists[0];
    if (!list) throw new Error('Missing fixture list');
    const releases: (() => void)[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === 'PUT') {
        return new Promise<Response>((resolve) => {
          releases.push(() => {
            resolve(url.endsWith('/tags')
              ? Response.json({ id: 'dim-1', name: 'Epoch', tags: [] })
              : Response.json(list));
          });
        });
      }
      return Response.json(seedLibraryWithOption);
    }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), seedLibraryWithOption);

    const first = renderHook(() => ({ options: useReplaceOptions(), tags: useReplaceTags() }), { wrapper: wrapper(client) });
    let saves: Promise<unknown> = Promise.resolve();
    await act(async () => {
      saves = Promise.all([
        first.result.current.options.mutateAsync({ listId: list.id, options: [] }),
        first.result.current.tags.mutateAsync({ dimId: 'dim-1', tags: [] }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    first.unmount();

    const reopened = renderHook(() => ({
      list: useListMutationPending(list.id),
      otherList: useListMutationPending('other-list'),
      dimension: useDimensionTagsPending('dim-1'),
      otherDimension: useDimensionTagsPending('dim-2'),
    }), { wrapper: wrapper(client) });
    expect(reopened.result.current).toEqual({ list: true, otherList: false, dimension: true, otherDimension: false });

    // The scope runs the options PUT first; the tag PUT waits behind it.
    await waitFor(() => { expect(releases).toHaveLength(1); });
    act(() => { releases.shift()?.(); });
    await waitFor(() => { expect(reopened.result.current.list).toBe(false); });
    expect(reopened.result.current.dimension).toBe(true);

    await waitFor(() => { expect(releases).toHaveLength(1); });
    await act(async () => {
      releases.shift()?.();
      await saves;
    });
    await waitFor(() => { expect(reopened.result.current.dimension).toBe(false); });
  });

  test('a template or dimension PATCH started by an unmounted editor stays pending for its own id only', async () => {
    const releases: (() => void)[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (init?.method === 'PATCH') {
        return new Promise<Response>((resolve) => {
          releases.push(() => {
            resolve(url.includes('/prompts/dimensions/')
              ? Response.json({ id: 'dim-1', name: 'Era', tags: [] })
              : Response.json({ ...templateA, name: 'Portrait patched' }));
          });
        });
      }
      return Response.json(seedLibrary);
    }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), seedLibrary);

    const first = renderHook(() => ({ template: usePatchTemplate(), dimension: usePatchDimension() }), { wrapper: wrapper(client) });
    let saves: Promise<unknown> = Promise.resolve();
    await act(async () => {
      saves = Promise.all([
        first.result.current.template.mutateAsync({ id: templateA.id, body: { name: 'Portrait patched' } }),
        first.result.current.dimension.mutateAsync({ id: 'dim-1', name: 'Era' }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    first.unmount();

    const reopened = renderHook(() => ({
      template: useTemplatePatchPending(templateA.id),
      otherTemplate: useTemplatePatchPending(templateB.id),
      newTemplate: useTemplatePatchPending(null),
      dimension: useDimensionMetadataPending('dim-1'),
      otherDimension: useDimensionMetadataPending('dim-2'),
      dimensionTags: useDimensionTagsPending('dim-1'),
    }), { wrapper: wrapper(client) });
    expect(reopened.result.current).toEqual({
      template: true,
      otherTemplate: false,
      newTemplate: false,
      dimension: true,
      otherDimension: false,
      dimensionTags: false,
    });

    // The scope runs the template PATCH first; the dimension PATCH waits behind it.
    await waitFor(() => { expect(releases).toHaveLength(1); });
    act(() => { releases.shift()?.(); });
    await waitFor(() => { expect(reopened.result.current.template).toBe(false); });
    expect(reopened.result.current.dimension).toBe(true);

    await waitFor(() => { expect(releases).toHaveLength(1); });
    await act(async () => {
      releases.shift()?.();
      await saves;
    });
    await waitFor(() => { expect(reopened.result.current.dimension).toBe(false); });
  });
});

describe('tag mutations keep option constraints', () => {
  const tag = (id: string, label: string, sortOrder: number, parentId: string | null = null) => ({
    id, dimensionId: 'dim-1', label, sortOrder, parentId,
  });
  const taggedLibrary: PromptLibraryResponse = {
    templates: [],
    dimensions: [{ id: 'dim-1', name: 'Milieu', tags: [tag('t1', 'A', 0), tag('t2', 'B', 1), tag('t3', 'C', 2)] }],
    variableLists: [{
      id: 'list-1',
      name: 'Style',
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      options: [
        { id: 'o1', listId: 'list-1', value: 'red', tagIds: ['t1'], excludeTagIds: ['t2'], sortOrder: 0, weight: 1 },
        { id: 'o2', listId: 'list-1', value: 'blue', tagIds: ['t3'], excludeTagIds: ['t1'], sortOrder: 1, weight: 1 },
      ],
    }],
  };

  function memberships(client: QueryClient) {
    return client.getQueryData<PromptLibraryResponse>(promptKeys.library())?.variableLists[0]?.options
      .map((option) => ({ id: option.id, tagIds: option.tagIds, excludeTagIds: option.excludeTagIds }));
  }

  function pendingFetch(): { respond: (response: Response) => void } {
    const handle: { respond: (response: Response) => void } = { respond: () => undefined };
    globalThis.fetch = mock(() => new Promise<Response>((resolve) => {
      handle.respond = resolve;
    })) as unknown as typeof fetch;
    return handle;
  }

  test('rename, reorder and parent moves keep every require/exclude membership', async () => {
    const server = pendingFetch();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), taggedLibrary);
    const { result } = renderHook(() => useReplaceTags(), { wrapper: wrapper(client) });

    let mutation: Promise<unknown> = Promise.resolve();
    await act(async () => {
      mutation = result.current.mutateAsync({
        dimId: 'dim-1',
        tags: [
          { id: 't2', label: 'B', parentId: null, sortOrder: 0 },
          { id: 't1', label: 'A renamed', parentId: 't2', sortOrder: 1 },
          { id: 't3', label: 'C', parentId: null, sortOrder: 2 },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const optimistic = client.getQueryData<PromptLibraryResponse>(promptKeys.library());
    expect(optimistic?.dimensions[0]?.tags.map((t) => ({ id: t.id, label: t.label, parentId: t.parentId }))).toEqual([
      { id: 't2', label: 'B', parentId: null },
      { id: 't1', label: 'A renamed', parentId: 't2' },
      { id: 't3', label: 'C', parentId: null },
    ]);
    expect(memberships(client)).toEqual([
      { id: 'o1', tagIds: ['t1'], excludeTagIds: ['t2'] },
      { id: 'o2', tagIds: ['t3'], excludeTagIds: ['t1'] },
    ]);

    await act(async () => {
      server.respond(Response.json({
        id: 'dim-1',
        name: 'Milieu',
        tags: [tag('t2', 'B', 0), tag('t1', 'A renamed', 1, 't2'), tag('t3', 'C', 2)],
      }));
      await mutation;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Before the invalidation refetch lands, the reconciled cache still holds them.
    expect(memberships(client)).toEqual([
      { id: 'o1', tagIds: ['t1'], excludeTagIds: ['t2'] },
      { id: 'o2', tagIds: ['t3'], excludeTagIds: ['t1'] },
    ]);
  });

  test('removing a tag prunes only that id from required and excluded memberships', async () => {
    const server = pendingFetch();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), taggedLibrary);
    const { result } = renderHook(() => useReplaceTags(), { wrapper: wrapper(client) });

    let mutation: Promise<unknown> = Promise.resolve();
    await act(async () => {
      mutation = result.current.mutateAsync({
        dimId: 'dim-1',
        tags: [
          { id: 't1', label: 'A', parentId: null, sortOrder: 0 },
          { id: 't3', label: 'C', parentId: null, sortOrder: 1 },
          { label: 'D', parentId: null, sortOrder: 2 },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(memberships(client)).toEqual([
      { id: 'o1', tagIds: ['t1'], excludeTagIds: [] },
      { id: 'o2', tagIds: ['t3'], excludeTagIds: ['t1'] },
    ]);

    await act(async () => {
      server.respond(Response.json({
        id: 'dim-1',
        name: 'Milieu',
        tags: [tag('t1', 'A', 0), tag('t3', 'C', 1), tag('t4', 'D', 2)],
      }));
      await mutation;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(memberships(client)).toEqual([
      { id: 'o1', tagIds: ['t1'], excludeTagIds: [] },
      { id: 'o2', tagIds: ['t3'], excludeTagIds: ['t1'] },
    ]);
    expect(client.getQueryData<PromptLibraryResponse>(promptKeys.library())?.dimensions[0]?.tags.map((t) => t.id))
      .toEqual(['t1', 't3', 't4']);
  });

  test('a failed tag save rolls back to the original constraints', async () => {
    const server = pendingFetch();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), taggedLibrary);
    const { result } = renderHook(() => useReplaceTags(), { wrapper: wrapper(client) });

    let mutation: Promise<unknown> = Promise.resolve();
    await act(async () => {
      mutation = result.current.mutateAsync({
        dimId: 'dim-1',
        tags: [{ id: 't3', label: 'C', parentId: null, sortOrder: 0 }],
      }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(memberships(client)).toEqual([
      { id: 'o1', tagIds: [], excludeTagIds: [] },
      { id: 'o2', tagIds: ['t3'], excludeTagIds: [] },
    ]);

    await act(async () => {
      server.respond(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
      await mutation;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(client.getQueryData<PromptLibraryResponse>(promptKeys.library())).toEqual(taggedLibrary);
  });

  test('deleting a dimension prunes its tags from excluded memberships too', async () => {
    const server = pendingFetch();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), taggedLibrary);
    const { result } = renderHook(() => useDeleteDimension(), { wrapper: wrapper(client) });

    let mutation: Promise<unknown> = Promise.resolve();
    await act(async () => {
      mutation = result.current.mutateAsync('dim-1').catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(memberships(client)).toEqual([
      { id: 'o1', tagIds: [], excludeTagIds: [] },
      { id: 'o2', tagIds: [], excludeTagIds: [] },
    ]);

    await act(async () => {
      server.respond(new Response(null, { status: 204 }));
      await mutation;
    });
  });
});
