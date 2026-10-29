import type { PromptLibraryResponse } from '@atelier/shared';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, type PropsWithChildren } from 'react';
import { promptKeys } from '../../api/prompts';
import { useAtelierStore } from '../../store/atelier';
import PromptManager from './index';
import { PromptDraftProvider, PromptDraftStore, usePromptDraftStore } from './draftStore';

// /api/prompts/dimensions/infer is SSE — emit a `done` event so the client's
// stream parser resolves with the payload.
function sseDoneResponse(payload: unknown): Response {
  return new Response(`:keepalive\n\nevent: done\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function sseStreamResponse(
  bind: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      bind(controller);
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const template = {
  id: '019e42fd-1111-7000-8000-000000000001',
  name: 'Editorial portrait',
  body: 'photorealistic {{var::era}} portrait',
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 2,
};

const library: PromptLibraryResponse = {
  templates: [template],
  variableLists: [{
    id: '019e42fd-1111-7000-8000-000000000010',
    name: 'era',
    options: [{
      id: '019e42fd-1111-7000-8000-000000000011',
      listId: '019e42fd-1111-7000-8000-000000000010',
      value: 'ancient',
      tagIds: [],
      sortOrder: 0,
      weight: 1,
    }],
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  }],
  dimensions: [{
    id: '019e42fd-1111-7000-8000-000000000020',
    name: 'Epoch',
    tags: [{
      id: '019e42fd-1111-7000-8000-000000000021',
      dimensionId: '019e42fd-1111-7000-8000-000000000020',
      label: 'Ancient',
      sortOrder: 0,
    }],
  }],
};

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}><PromptDraftProvider>{children}</PromptDraftProvider></QueryClientProvider>;
  };
}

function renderManager(seed: PromptLibraryResponse = library) {
  const onBack = mock(() => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(promptKeys.library(), seed);
  globalThis.fetch = mock(() => Response.json(seed)) as unknown as typeof fetch;
  return {
    onBack,
    client,
    ...render(<PromptManager onBack={onBack} />, { wrapper: wrapper(client) }),
  };
}

function renderManagerLoading() {
  const onBack = mock(() => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  globalThis.fetch = mock(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
  return {
    onBack,
    client,
    ...render(<PromptManager onBack={onBack} />, { wrapper: wrapper(client) }),
  };
}

function assertZones(
  form: HTMLElement,
  expected: { head: number; body: number; entry: number; foot: number },
) {
  const count = (z: string) => form.querySelectorAll(`[data-zone="${z}"]`).length;
  expect(count('head')).toBe(expected.head);
  expect(count('body')).toBe(expected.body);
  expect(count('entry')).toBe(expected.entry);
  expect(count('foot')).toBe(expected.foot);
}

afterEach(() => {
  cleanup();
  mock.restore();
  window.localStorage.clear();
  useAtelierStore.setState({ promptManagerTab: 'templates', toasts: [] });
});

const emptyLibrary: PromptLibraryResponse = { templates: [], variableLists: [], dimensions: [] };

describe('PromptManager', () => {
  test('keeps template edits across resource switches and leaving the library', async () => {
    const second = { ...template, id: 'second-template', name: 'Second study', body: 'baseline' };
    const { rerender, onBack } = renderManager({ ...library, templates: [template, second] });
    const body = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Body' });
    fireEvent.change(body, { target: { value: 'Unfinished portrait' } });
    fireEvent.click(screen.getByRole('button', { name: 'Second study' }));
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Body' }).value).toBe('baseline');
    fireEvent.click(screen.getByRole('button', { name: 'Editorial portrait' }));
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Body' }).value).toBe('Unfinished portrait');

    rerender(<></>);
    rerender(<PromptManager onBack={onBack} />);
    expect((await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Body' })).value).toBe('Unfinished portrait');
  });

  test('keeps list and dimension drafts across tab switches', async () => {
    const { rerender, onBack } = renderManager();
    fireEvent.click(await screen.findByRole('tab', { name: 'Variable lists' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Variable list name' }), { target: { value: 'Period' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Dimensions' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Dimension description' }), { target: { value: 'Visual period' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Variable lists' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Variable list name' }).value).toBe('Period');
    fireEvent.click(screen.getByRole('tab', { name: 'Dimensions' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Dimension description' }).value).toBe('Visual period');
    rerender(<></>);
    rerender(<PromptManager onBack={onBack} />);
    expect((await screen.findByRole<HTMLInputElement>('textbox', { name: 'Dimension description' })).value).toBe('Visual period');
    fireEvent.click(screen.getByRole('tab', { name: 'Variable lists' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Variable list name' }).value).toBe('Period');
  });

  test('rebases a newly saved dimension tag and revisits clean', async () => {
    renderManager();
    let current = library;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes('/prompts/dimensions/') && url.endsWith('/tags') && init?.method === 'PUT') {
        const prior = current.dimensions[0];
        if (!prior) throw new Error('Missing fixture dimension');
        const saved = {
          ...prior,
          tags: [{ id: 'new-tag', dimensionId: prior.id, label: 'Medieval', sortOrder: 0 }, ...prior.tags.map((tag) => ({ ...tag, sortOrder: tag.sortOrder + 1 }))],
        };
        current = { ...current, dimensions: [saved] };
        return Response.json(saved);
      }
      return Response.json(current);
    }) as unknown as typeof fetch;
    fireEvent.click(await screen.findByRole('tab', { name: 'Dimensions' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add tag' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Tag 1' }), { target: { value: 'Medieval' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save dimension' }));
    await waitFor(() => { expect(useAtelierStore.getState().toasts.some((toast) => toast.text === 'Dimension saved')).toBe(true); });
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save dimension' }).disabled).toBe(true); });
    fireEvent.click(screen.getByRole('tab', { name: 'Templates' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Dimensions' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save dimension' }).disabled).toBe(true);
  });

  test('a failed rename keeps the submitted name and description through rollback and reopen', async () => {
    const { client } = renderManager();
    let failPatch: () => void = () => undefined;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/prompts/dimensions/019e42fd-1111-7000-8000-000000000020') && init?.method === 'PATCH') {
        return new Promise<Response>((resolve) => {
          failPatch = () => { resolve(Response.json({ error: 'Rename refused' }, { status: 500 })); };
        });
      }
      return Response.json(library);
    }) as unknown as typeof fetch;
    const cachedName = () => client.getQueryData<PromptLibraryResponse>(promptKeys.library())?.dimensions[0]?.name;
    const fieldValue = (name: string) => screen.getByRole<HTMLInputElement>('textbox', { name }).value;

    fireEvent.click(await screen.findByRole('tab', { name: 'Dimensions' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Dimension name' }), { target: { value: 'Era' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Dimension description' }), { target: { value: 'Visual period' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save dimension' }));
    await waitFor(() => { expect(cachedName()).toBe('Era'); });

    // Leave and reopen the editor while the optimistic rename is in flight.
    fireEvent.click(screen.getByRole('tab', { name: 'Templates' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Dimensions' }));
    expect(fieldValue('Dimension name')).toBe('Era');
    failPatch();

    await waitFor(() => { expect(useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true); });
    await waitFor(() => { expect(cachedName()).toBe('Epoch'); });
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save dimension' }).disabled).toBe(false); });
    expect(fieldValue('Dimension name')).toBe('Era');
    expect(fieldValue('Dimension description')).toBe('Visual period');

    fireEvent.click(screen.getByRole('tab', { name: 'Templates' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Dimensions' }));
    expect(fieldValue('Dimension name')).toBe('Era');
    expect(fieldValue('Dimension description')).toBe('Visual period');
  });

  // Reopening the whole library during a save gives the editor a new, idle
  // mutation observer while the optimistic cache already matches the submitted
  // text; leaving again before the request answers must not lose that text.
  describe('a save still in flight across two library visits', () => {
    const dimensionPath = '/prompts/dimensions/019e42fd-1111-7000-8000-000000000020';
    const templatePath = `/prompts/templates/${template.id}`;
    const second = { ...template, id: 'second-template', name: 'Second study', body: 'baseline' };
    const twoTemplates: PromptLibraryResponse = { ...library, templates: [template, second] };

    interface HeldPatch {
      readonly sent: string[];
      settle: (ok: boolean) => void;
    }

    // Holds every PATCH to `path` until `settle`; a success also becomes what
    // later library refetches return.
    function holdPatch(
      seed: PromptLibraryResponse,
      path: string,
      apply: (current: PromptLibraryResponse, body: Record<string, unknown>) => {
        readonly library: PromptLibraryResponse;
        readonly saved: unknown;
      },
    ): HeldPatch {
      let current = seed;
      const held: HeldPatch = { sent: [], settle: () => undefined };
      globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith(path) && init?.method === 'PATCH' && typeof init.body === 'string') {
          held.sent.push(init.body);
          const body = JSON.parse(init.body) as Record<string, unknown>;
          return new Promise<Response>((resolve) => {
            held.settle = (ok) => {
              if (!ok) {
                resolve(Response.json({ error: 'Save refused' }, { status: 500 }));
                return;
              }
              const next = apply(current, body);
              current = next.library;
              resolve(Response.json(next.saved));
            };
          });
        }
        return Response.json(current);
      }) as unknown as typeof fetch;
      return held;
    }

    const savedDimension = (current: PromptLibraryResponse, body: Record<string, unknown>) => {
      const prior = current.dimensions[0];
      if (!prior) throw new Error('Missing fixture dimension');
      const saved = {
        ...prior,
        name: String(body.name),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
      };
      return { library: { ...current, dimensions: [saved] }, saved };
    };
    const savedTemplate = (current: PromptLibraryResponse, body: Record<string, unknown>) => {
      const saved = { ...template, name: String(body.name), body: String(body.body) };
      return {
        library: { ...current, templates: current.templates.map((item) => (item.id === saved.id ? saved : item)) },
        saved,
      };
    };

    const fieldValue = (name: string) => screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name }).value;
    const fieldDisabled = (name: string) => screen.getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name }).disabled;
    const buttonDisabled = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name }).disabled;
    const toasted = (text: string) => useAtelierStore.getState().toasts.some((toast) => toast.text === text);
    const errorToasted = () => useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error');

    async function submitDimensionRename(held: HeldPatch): Promise<void> {
      fireEvent.click(await screen.findByRole('tab', { name: 'Dimensions' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Dimension name' }), { target: { value: 'Era' } });
      fireEvent.change(screen.getByRole('textbox', { name: 'Dimension description' }), { target: { value: 'Visual period' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save dimension' }));
      await waitFor(() => { expect(held.sent).toHaveLength(1); });
    }

    async function submitTemplateEdit(held: HeldPatch): Promise<void> {
      fireEvent.change(await screen.findByRole('textbox', { name: 'Body' }), { target: { value: 'Submitted body' } });
      fireEvent.change(screen.getByRole('textbox', { name: 'Template name' }), { target: { value: 'Revised portrait' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
      await waitFor(() => { expect(held.sent).toHaveLength(1); });
    }

    test('a dimension rename refused after the second visit reopens with the submitted text', async () => {
      const { client, rerender, onBack } = renderManager();
      const held = holdPatch(library, dimensionPath, savedDimension);
      const cachedName = () => client.getQueryData<PromptLibraryResponse>(promptKeys.library())?.dimensions[0]?.name;
      await submitDimensionRename(held);
      expect(cachedName()).toBe('Era');

      rerender(<></>);
      rerender(<PromptManager onBack={onBack} />);
      expect((await screen.findByRole<HTMLInputElement>('textbox', { name: 'Dimension name' })).value).toBe('Era');
      expect(fieldValue('Dimension description')).toBe('Visual period');
      // The new manager's own PATCH observer is idle, yet the save is seen.
      expect(buttonDisabled('Save dimension')).toBe(true);
      expect(fieldDisabled('Dimension name')).toBe(true);
      fireEvent.submit(screen.getByRole('form', { name: /^Edit dimension / }));
      expect(held.sent).toHaveLength(1);

      rerender(<></>);
      held.settle(false);
      await waitFor(() => { expect(errorToasted()).toBe(true); });
      await waitFor(() => { expect(client.isMutating()).toBe(0); });
      expect(cachedName()).toBe('Epoch');

      rerender(<PromptManager onBack={onBack} />);
      expect((await screen.findByRole<HTMLInputElement>('textbox', { name: 'Dimension name' })).value).toBe('Era');
      expect(fieldValue('Dimension description')).toBe('Visual period');
      expect(buttonDisabled('Save dimension')).toBe(false);
      expect(held.sent).toHaveLength(1);
    });

    test('a dimension rename saved after the second visit reopens clean and follows the server again', async () => {
      const { client, rerender, onBack } = renderManager();
      const held = holdPatch(library, dimensionPath, savedDimension);
      await submitDimensionRename(held);

      rerender(<></>);
      rerender(<PromptManager onBack={onBack} />);
      expect((await screen.findByRole<HTMLInputElement>('textbox', { name: 'Dimension name' })).value).toBe('Era');
      rerender(<></>);
      held.settle(true);
      await waitFor(() => { expect(toasted('Dimension saved')).toBe(true); });
      await waitFor(() => { expect(client.isMutating()).toBe(0); });

      rerender(<PromptManager onBack={onBack} />);
      expect((await screen.findByRole<HTMLInputElement>('textbox', { name: 'Dimension name' })).value).toBe('Era');
      expect(fieldValue('Dimension description')).toBe('Visual period');
      expect(buttonDisabled('Save dimension')).toBe(true);

      // No pending base or retained draft is left, so a clean field follows
      // a later external rename.
      await waitFor(() => { expect(client.isFetching()).toBe(0); });
      act(() => {
        const current = client.getQueryData<PromptLibraryResponse>(promptKeys.library());
        const dimension = current?.dimensions[0];
        if (!current || !dimension) throw new Error('Missing cached dimension');
        client.setQueryData(promptKeys.library(), { ...current, dimensions: [{ ...dimension, name: 'Period' }] });
      });
      await waitFor(() => { expect(fieldValue('Dimension name')).toBe('Period'); });
      expect(held.sent).toHaveLength(1);
    });

    test('a template save refused after the second visit reopens with the submitted name and body', async () => {
      const { client, rerender, onBack } = renderManager(twoTemplates);
      const held = holdPatch(twoTemplates, templatePath, savedTemplate);
      const cachedBody = () => client.getQueryData<PromptLibraryResponse>(promptKeys.library())?.templates[0]?.body;
      await submitTemplateEdit(held);
      expect(cachedBody()).toBe('Submitted body');

      rerender(<></>);
      rerender(<PromptManager onBack={onBack} />);
      expect((await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Body' })).value).toBe('Submitted body');
      expect(fieldValue('Template name')).toBe('Revised portrait');
      expect(buttonDisabled('Save template')).toBe(true);
      fireEvent.submit(screen.getByRole('form', { name: /^Edit template / }));
      expect(held.sent).toHaveLength(1);

      rerender(<></>);
      held.settle(false);
      await waitFor(() => { expect(errorToasted()).toBe(true); });
      await waitFor(() => { expect(client.isMutating()).toBe(0); });
      expect(cachedBody()).toBe(template.body);

      rerender(<PromptManager onBack={onBack} />);
      expect((await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Body' })).value).toBe('Submitted body');
      expect(fieldValue('Template name')).toBe('Revised portrait');
      expect(buttonDisabled('Save template')).toBe(false);
      expect(held.sent).toHaveLength(1);
    });

    test('a template save answered after the second visit clears its draft and keeps other templates editable', async () => {
      const { client, rerender, onBack } = renderManager(twoTemplates);
      const held = holdPatch(twoTemplates, templatePath, savedTemplate);
      await submitTemplateEdit(held);

      rerender(<></>);
      rerender(<PromptManager onBack={onBack} />);
      expect((await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Body' })).value).toBe('Submitted body');
      // Another template stays independent of the pending save.
      fireEvent.click(screen.getByRole('button', { name: 'Second study' }));
      expect(fieldDisabled('Body')).toBe(false);
      fireEvent.change(screen.getByRole('textbox', { name: 'Body' }), { target: { value: 'Second edit' } });
      fireEvent.click(screen.getByRole('button', { name: 'Revised portrait' }));
      expect(fieldDisabled('Body')).toBe(true);

      rerender(<></>);
      held.settle(true);
      await waitFor(() => { expect(toasted('Template saved')).toBe(true); });
      await waitFor(() => { expect(client.isMutating()).toBe(0); });

      rerender(<PromptManager onBack={onBack} />);
      expect((await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Body' })).value).toBe('Submitted body');
      expect(fieldValue('Template name')).toBe('Revised portrait');
      expect(buttonDisabled('Save template')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Second study' }));
      expect(fieldValue('Body')).toBe('Second edit');
      // With no stale draft left, the template reopens on a later server change.
      await waitFor(() => { expect(client.isFetching()).toBe(0); });
      act(() => {
        const current = client.getQueryData<PromptLibraryResponse>(promptKeys.library());
        if (!current) throw new Error('Missing cached library');
        client.setQueryData(promptKeys.library(), {
          ...current,
          templates: current.templates.map((item) => (item.id === template.id ? { ...item, body: 'Server body' } : item)),
        });
      });
      fireEvent.click(screen.getByRole('button', { name: 'Revised portrait' }));
      expect(fieldValue('Body')).toBe('Server body');
      expect(held.sent).toHaveLength(1);
    });
  });

  test('a reopened editor adopts ids from a delayed tag save, so the next save never re-inserts', async () => {
    renderManager();
    let current = library;
    let releaseFirst: () => void = () => undefined;
    const putBodies: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/prompts/dimensions/019e42fd-1111-7000-8000-000000000020/tags') && init?.method === 'PUT' && typeof init.body === 'string') {
        putBodies.push(init.body);
        const prior = current.dimensions[0];
        if (!prior) throw new Error('Missing fixture dimension');
        const sent = (JSON.parse(init.body) as { tags: { id?: string; label: string; sortOrder: number }[] }).tags;
        const saved = {
          ...prior,
          tags: sent.map((tag) => ({
            id: tag.id ?? `persisted-${putBodies.length}-${tag.sortOrder}`,
            dimensionId: prior.id,
            label: tag.label,
            sortOrder: tag.sortOrder,
          })),
        };
        const respond = () => {
          current = { ...current, dimensions: [saved] };
          return Response.json(saved);
        };
        if (putBodies.length > 1) return respond();
        return new Promise<Response>((resolve) => { releaseFirst = () => { resolve(respond()); }; });
      }
      return Response.json(current);
    }) as unknown as typeof fetch;

    fireEvent.click(await screen.findByRole('tab', { name: 'Dimensions' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add tag' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Tag 1' }), { target: { value: 'Medieval' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save dimension' }));
    await waitFor(() => { expect(putBodies).toHaveLength(1); });

    // A structural edit during the request, then leave and reopen the editor.
    fireEvent.click(screen.getByRole('button', { name: '+ Add tag' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Templates' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Dimensions' }));
    expect(screen.getAllByRole('textbox', { name: /^Tag \d/ })).toHaveLength(3);
    // The reopened instance sees the replacement still in flight, so it can
    // neither enable Save nor submit the same rows again without their ids.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save dimension' }).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: 'Edit dimension Epoch' }));
    releaseFirst();
    await waitFor(() => { expect(useAtelierStore.getState().toasts.some((toast) => toast.text === 'Dimension saved')).toBe(true); });

    await waitFor(() => { expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Tag 1' }).disabled).toBe(false); });
    expect(putBodies).toHaveLength(1);
    fireEvent.change(screen.getByRole('textbox', { name: 'Tag 1' }), { target: { value: 'Modern' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save dimension' }));
    await waitFor(() => { expect(putBodies).toHaveLength(2); });
    const second = putBodies[1] ?? '';
    expect(second.includes('draft:')).toBe(false);
    const sent = (JSON.parse(second) as { tags: { id?: string; label: string }[] }).tags;
    expect(sent.map((tag) => [tag.label, tag.id ?? null])).toEqual([
      ['Modern', null],
      ['Medieval', 'persisted-1-0'],
      ['Ancient', '019e42fd-1111-7000-8000-000000000021'],
    ]);
  });

  describe('list option ids after an options save', () => {
    const listId = '019e42fd-1111-7000-8000-000000000010';
    const ancientOptionId = '019e42fd-1111-7000-8000-000000000011';
    const ancientTagId = '019e42fd-1111-7000-8000-000000000021';

    interface SentListOption {
      readonly id?: string;
      readonly value: string;
      readonly tagIds: readonly string[];
      readonly excludeTagIds?: readonly string[];
      readonly sortOrder: number;
      readonly weight?: number;
    }

    interface ListServer {
      readonly puts: (readonly SentListOption[])[];
      readonly optionPatches: string[];
      renames: number;
      releasePut: () => void;
      releaseRename: () => void;
    }

    // Renames always answer 409 (only the first may be held); options PUTs echo
    // the server's ids, minting `persisted-<call>-<sortOrder>` for new rows.
    function mockListServer(hold: { readonly put?: boolean; readonly rename?: boolean }): ListServer {
      let current = library;
      const server: ListServer = {
        puts: [],
        optionPatches: [],
        renames: 0,
        releasePut: () => undefined,
        releaseRename: () => undefined,
      };
      globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith(`/prompts/lists/${listId}`) && init?.method === 'PATCH') {
          server.renames += 1;
          const refuse = () => Response.json({ error: 'A list with that name already exists' }, { status: 409 });
          if (!hold.rename || server.renames > 1) return refuse();
          return new Promise<Response>((resolve) => { server.releaseRename = () => { resolve(refuse()); }; });
        }
        if (url.endsWith(`/prompts/lists/${listId}/options`) && init?.method === 'PUT' && typeof init.body === 'string') {
          const sent = (JSON.parse(init.body) as { options: SentListOption[] }).options;
          server.puts.push(sent);
          const call = server.puts.length;
          const prior = current.variableLists[0];
          if (!prior) throw new Error('Missing fixture list');
          const saved = {
            ...prior,
            options: sent.map((option) => ({
              id: option.id ?? `persisted-${call}-${option.sortOrder}`,
              listId,
              value: option.value,
              tagIds: [...option.tagIds],
              excludeTagIds: [...(option.excludeTagIds ?? [])],
              sortOrder: option.sortOrder,
              weight: option.weight ?? 1,
            })),
          };
          const respond = () => {
            current = { ...current, variableLists: [saved] };
            return Response.json(saved);
          };
          if (!hold.put || call > 1) return respond();
          return new Promise<Response>((resolve) => { server.releasePut = () => { resolve(respond()); }; });
        }
        if (url.includes(`/prompts/lists/${listId}/options/`) && init?.method === 'PATCH') {
          server.optionPatches.push(url.slice(url.lastIndexOf('/') + 1));
          return new Response(null, { status: 204 });
        }
        return Response.json(current);
      }) as unknown as typeof fetch;
      return server;
    }

    function renderListManager() {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      client.setQueryData(promptKeys.library(), library);
      const storeHolder: { current: PromptDraftStore | null } = { current: null };
      function StoreProbe() {
        const store = usePromptDraftStore();
        useEffect(() => { storeHolder.current = store; }, [store]);
        return null;
      }
      render(<><StoreProbe /><PromptManager onBack={mock()} /></>, { wrapper: wrapper(client) });
      return {
        client,
        storedKeys: () => storeHolder.current?.getList(listId)?.options.map((option) => option.key) ?? null,
      };
    }

    const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Save list' });
    const firstWeight = () => {
      const editor = screen.getByRole('form', { name: /^Edit variable list / });
      const input = within(editor).getAllByRole<HTMLInputElement>('spinbutton')[0];
      if (!input) throw new Error('Missing weight input');
      return input;
    };
    const toasted = (text: string) => useAtelierStore.getState().toasts.some((toast) => toast.text === text);
    const errorToasted = () => useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error');
    const sentShape = (options: readonly SentListOption[] | undefined) =>
      (options ?? []).map((option) => [option.value, option.id ?? null, option.tagIds.join(',')]);

    async function addMedievalAndSave(rename: boolean): Promise<void> {
      fireEvent.click(await screen.findByRole('tab', { name: 'Variable lists' }));
      if (rename) fireEvent.change(screen.getByRole('textbox', { name: 'Variable list name' }), { target: { value: 'Period' } });
      fireEvent.click(screen.getByRole('button', { name: '+ Add option' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Option 1' }), { target: { value: 'medieval' } });
      fireEvent.click(saveButton());
    }

    // A later weight edit PATCHes the saved row, and a text edit keeps its id.
    async function expectServerIdsUsed(server: ListServer): Promise<void> {
      await waitFor(() => { expect(firstWeight().disabled).toBe(false); });
      fireEvent.change(firstWeight(), { target: { value: '5' } });
      fireEvent.blur(firstWeight());
      await waitFor(() => { expect(server.optionPatches).toEqual(['persisted-1-0']); });
      await waitFor(() => { expect(firstWeight().disabled).toBe(false); });

      const putsBefore = server.puts.length;
      fireEvent.change(screen.getByRole('textbox', { name: 'Option 1: medieval' }), { target: { value: 'gothic' } });
      fireEvent.click(saveButton());
      await waitFor(() => { expect(server.puts.length).toBe(putsBefore + 1); });
      const resent = sentShape(server.puts[putsBefore]).map(([value, id]) => [value, id]);
      expect(resent).toEqual([['gothic', 'persisted-1-0'], ['ancient', ancientOptionId]]);
    }

    test('a refused rename does not stop a saved options PUT from settling its ids', async () => {
      const server = mockListServer({});
      const { storedKeys } = renderListManager();
      await addMedievalAndSave(true);

      await waitFor(() => { expect(errorToasted()).toBe(true); });
      await waitFor(() => { expect(server.puts.length).toBe(1); });
      expect(sentShape(server.puts[0])).toEqual([['medieval', null, ''], ['ancient', ancientOptionId, '']]);
      // The rename is still unsaved, so the draft stays, addressing server ids.
      await waitFor(() => { expect(storedKeys()).toEqual(['persisted-1-0', ancientOptionId]); });
      expect(toasted('Variable list saved')).toBe(false);
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Variable list name' }).value).toBe('Period');

      await expectServerIdsUsed(server);
    });

    test('a list reopened before its delayed options save answers stays pending, then adopts the ids', async () => {
      const server = mockListServer({ put: true });
      const { storedKeys } = renderListManager();
      await addMedievalAndSave(false);
      await waitFor(() => { expect(server.puts.length).toBe(1); });

      fireEvent.click(screen.getByRole('tab', { name: 'Templates' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Variable lists' }));
      // Edits made in the reopened editor while the save is in flight.
      fireEvent.click(screen.getByRole('button', { name: 'Show tags for medieval' }));
      fireEvent.click(screen.getByRole('button', { name: 'Ancient: not set' }));
      expect(saveButton().disabled).toBe(true);
      expect(firstWeight().disabled).toBe(true);
      fireEvent.submit(screen.getByRole('form', { name: 'Edit variable list era' }));

      server.releasePut();
      await waitFor(() => { expect(toasted('Variable list saved')).toBe(true); });
      await waitFor(() => { expect(saveButton().disabled).toBe(false); });
      expect(server.puts.length).toBe(1);
      expect(storedKeys()).toEqual(['persisted-1-0', ancientOptionId]);
      expect(screen.getByRole('button', { name: 'Hide tags for medieval' }).getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByRole('button', { name: 'Ancient: required' }).getAttribute('data-polarity')).toBe('require');

      await expectServerIdsUsed(server);
      expect(sentShape(server.puts[1])[0]?.[2]).toBe(ancientTagId);
    });

    test('a list left before a refused rename and saved options settle reopens on the server ids', async () => {
      const server = mockListServer({ rename: true });
      const { client, storedKeys } = renderListManager();
      await addMedievalAndSave(true);
      await waitFor(() => { expect(server.renames).toBe(1); });

      fireEvent.click(screen.getByRole('tab', { name: 'Templates' }));
      server.releaseRename();
      await waitFor(() => { expect(server.puts.length).toBe(1); });
      await waitFor(() => { expect(client.isMutating()).toBe(0); });
      expect(errorToasted()).toBe(true);
      expect(storedKeys()).toEqual(['persisted-1-0', ancientOptionId]);

      fireEvent.click(screen.getByRole('tab', { name: 'Variable lists' }));
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Variable list name' }).value).toBe('Period');
      await expectServerIdsUsed(server);
    });
  });

  test('successful tag removal prunes retained list drafts even when dimension rename fails', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(promptKeys.library(), library);
    const storeHolder: { current: PromptDraftStore | null } = { current: null };
    function StoreProbe() {
      const store = usePromptDraftStore();
      useEffect(() => { storeHolder.current = store; }, [store]);
      return null;
    }
    let current = library;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/prompts/dimensions/019e42fd-1111-7000-8000-000000000020') && init?.method === 'PATCH') {
        return Response.json({ error: 'Rename refused' }, { status: 500 });
      }
      if (url.endsWith('/prompts/dimensions/019e42fd-1111-7000-8000-000000000020/tags') && init?.method === 'PUT') {
        const dimension = current.dimensions[0];
        if (!dimension) throw new Error('Missing fixture dimension');
        const saved = { ...dimension, tags: [] };
        current = { ...current, dimensions: [saved] };
        return Response.json(saved);
      }
      return Response.json(current);
    }) as unknown as typeof fetch;
    render(<><StoreProbe /><PromptManager onBack={mock()} /></>, { wrapper: wrapper(client) });
    const store = storeHolder.current;
    const list = library.variableLists[0];
    const option = list?.options[0];
    if (!store || !list || !option) throw new Error('Missing draft store or list fixture');
    const removedTagId = '019e42fd-1111-7000-8000-000000000021';
    store.setList(list.id, {
      name: 'Unsaved list title',
      options: [{ key: option.id, value: option.value, tagIds: [removedTagId], excludeTagIds: [], weight: 1, weightInput: '1', expanded: false }],
    });

    fireEvent.click(await screen.findByRole('tab', { name: 'Dimensions' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Dimension name' }), { target: { value: 'Renamed epoch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag Ancient' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save dimension' }));

    await waitFor(() => { expect(store.getList(list.id)?.options[0]?.tagIds).toEqual([]); });
    expect(useAtelierStore.getState().toasts.some((toast) => toast.text === 'Dimension saved')).toBe(false);
    await waitFor(() => { expect(useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true); });
  });

  test('adopts a created template so the next save patches its ID', async () => {
    renderManager(emptyLibrary);
    const created = { ...template, id: 'created-template', name: 'Fresh study', body: 'First draft' };
    let current: PromptLibraryResponse = emptyLibrary;
    const methods: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/prompts/templates') && init?.method === 'POST') {
        methods.push('POST');
        current = { ...current, templates: [created] };
        return Response.json(created);
      }
      if (url.endsWith('/prompts/templates/created-template') && init?.method === 'PATCH') {
        methods.push('PATCH');
        return Response.json({ ...created, body: 'Second draft' });
      }
      return Response.json(current);
    }) as unknown as typeof fetch;

    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
    const name = screen.getByRole<HTMLInputElement>('textbox', { name: 'Template name' });
    fireEvent.change(name, { target: { value: 'Fresh study' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    fireEvent.change(await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Body' }), { target: { value: 'First draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => { expect(screen.getByRole('form', { name: 'Edit template Fresh study' })).toBeTruthy(); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Body' }), { target: { value: 'Second draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => { expect(methods).toEqual(['POST', 'PATCH']); });
  });

  test('reopened library observes a pending create and adopts its ID when it settles', async () => {
    const { rerender, onBack } = renderManager(emptyLibrary);
    const created = { ...template, id: 'created-after-reopen', name: 'Late study', body: 'First draft' };
    let current: PromptLibraryResponse = emptyLibrary;
    let resolveCreate: ((response: Response) => void) | undefined;
    const methods: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/prompts/templates') && init?.method === 'POST') {
        methods.push('POST');
        return new Promise<Response>((resolve) => { resolveCreate = resolve; });
      }
      if (url.endsWith('/prompts/templates/created-after-reopen') && init?.method === 'PATCH') {
        methods.push('PATCH');
        current = { ...current, templates: [{ ...created, body: 'Second draft' }] };
        return Response.json(current.templates[0]);
      }
      return Response.json(current);
    }) as unknown as typeof fetch;

    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
    const name = screen.getByRole<HTMLInputElement>('textbox', { name: 'Template name' });
    fireEvent.change(name, { target: { value: 'Late study' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Body' }), { target: { value: 'First draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => { expect(methods).toEqual(['POST']); });

    rerender(<></>);
    rerender(<PromptManager onBack={onBack} />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save template' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    expect(methods).toEqual(['POST']);
    if (!resolveCreate) throw new Error('Create request did not start');
    current = { ...current, templates: [created] };
    resolveCreate(Response.json(created));
    await waitFor(() => { expect(screen.getByRole('form', { name: 'Edit template Late study' })).toBeTruthy(); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Body' }), { target: { value: 'Second draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => { expect(methods).toEqual(['POST', 'PATCH']); });
  });

  test('a new template with a cleared name resumes its unsaved body', async () => {
    renderManager();
    fireEvent.click(await screen.findByRole('button', { name: '+ New' }));
    const rail = within(screen.getByRole('tabpanel', { name: 'Templates' })).getByRole('complementary', { name: 'Templates' });
    const inlineName = await within(rail).findByRole<HTMLInputElement>('textbox', { name: 'Template name' });
    fireEvent.change(inlineName, { target: { value: 'First name' } });
    fireEvent.keyDown(inlineName, { key: 'Enter' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Body' }), { target: { value: 'Keep this body' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Template name' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Editorial portrait' }));
    fireEvent.click(screen.getByRole('button', { name: '+ New' }));
    expect(screen.getByRole('form', { name: 'Create template' })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Template name' }).value).toBe('');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Body' }).value).toBe('Keep this body');
  });

  test('confirmed removed tags are pruned from retained list requirements and exclusions', () => {
    const store = new PromptDraftStore();
    store.setList('list', {
      name: 'Draft list',
      options: [{ key: 'option', value: 'ancient', tagIds: ['deleted', 'kept'], excludeTagIds: ['deleted'], weight: 1, weightInput: '1', expanded: true }],
    });
    store.pruneListTagIds(new Set(['deleted']));
    expect(store.getList('list')?.options[0]?.tagIds).toEqual(['kept']);
    expect(store.getList('list')?.options[0]?.excludeTagIds).toEqual([]);
  });

  test('empty templates show an editor action that starts inline creation in the rail', async () => {
    renderManager(emptyLibrary);

    const panel = await screen.findByRole('tabpanel', { name: 'Templates' });
    const rail = within(panel).getByRole('complementary', { name: 'Templates' });
    const editor = rail.nextElementSibling;
    expect(editor).toBeInstanceOf(HTMLElement);
    if (!(editor instanceof HTMLElement)) throw new Error('Missing editor column');
    expect(within(editor).getByRole('heading', { name: 'No templates yet' })).toBeTruthy();
    expect(within(editor).getByText(/A template is a reusable prompt with slots/)).toBeTruthy();
    fireEvent.click(within(editor).getByRole('button', { name: 'New template' }));

    const input = within(rail).getByRole('textbox', { name: 'Template name' });
    expect(document.activeElement).toBe(input);
    expect(within(rail).queryByRole('button', { name: '+ New' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'No templates yet' })).toBeNull();
  });

  test('one template suppresses the editor empty state', async () => {
    renderManager();

    expect(await screen.findByRole('form', { name: 'Edit template Editorial portrait' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'No templates yet' })).toBeNull();
  });

  test('back to feed button is present and invokes onBack', async () => {
    const { onBack } = renderManager();
    fireEvent.click(await screen.findByRole('button', { name: 'Back to feed' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test('renders three tabs; templates tab lists templates', async () => {
    renderManager();

    expect(await screen.findByRole('tab', { name: 'Templates' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Variable lists' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Dimensions' })).toBeTruthy();
    expect(screen.getAllByText('Editorial portrait').length).toBeGreaterThan(0);
  });

  test('loading state keeps the shared managed-view header and omits import UI', async () => {
    renderManagerLoading();

    expect(await screen.findByRole('heading', { name: 'Prompt Library' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to feed' })).toBeTruthy();
    expect(screen.getByText('Loading prompt library…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Import from text' })).toBeNull();
  });

  test('does not render the removed import affordance or leftover import copy', async () => {
    renderManager(emptyLibrary);

    expect(await screen.findByRole('heading', { name: 'Prompt Library' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Import from text' })).toBeNull();
    expect(screen.queryByText(/Import from text/i)).toBeNull();
    expect(screen.queryByLabelText('Obsidian prompt markdown')).toBeNull();
  });

  test('delete template opens ConfirmDialog and calls the mutation on confirm', async () => {
    renderManager();
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/prompts/templates/') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return Response.json(library);
    }) as unknown as typeof fetch;

    fireEvent.click(await screen.findByRole('button', { name: 'Delete template Editorial portrait' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete template' }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/prompts/templates/019e42fd-1111-7000-8000-000000000001',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  test('ListEditor toggling a tag chip marks the set dirty and Save calls replaceOptions', async () => {
    renderManager();
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/prompts/lists/019e42fd-1111-7000-8000-000000000010/options') && init?.method === 'PUT') {
        return Response.json({
          ...library.variableLists[0],
          options: [{ ...library.variableLists[0]?.options[0], tagIds: ['019e42fd-1111-7000-8000-000000000021'] }],
        });
      }
      return Response.json(library);
    }) as unknown as typeof fetch;

    fireEvent.click(await screen.findByRole('tab', { name: 'Variable lists' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Edit list era(,|$)/ }));
    const editor = screen.getByRole('form', { name: 'Edit variable list era' });
    fireEvent.click(within(editor).getByRole('button', { name: 'Show tags for ancient' }));
    // Tag chips are tri-state (off -> require -> exclude), so the accessible name
    // carries the state; one click moves "not set" to "required".
    fireEvent.click(within(editor).getByRole('button', { name: 'Ancient: not set' }));
    expect(within(editor).getByRole('button', { name: 'Ancient: required' })).toBeTruthy();

    expect(within(editor).getByRole('button', { name: 'Save list' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(within(editor).getByRole('button', { name: 'Save list' }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/prompts/lists/019e42fd-1111-7000-8000-000000000010/options',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            // excludeTagIds is always sent: the route preserves omitted metadata, so
            // an absent key could never clear an exclusion the operator just removed.
            // The existing option keeps its id so the PUT preserves its identity.
            options: [{
              id: '019e42fd-1111-7000-8000-000000000011',
              value: 'ancient',
              tagIds: ['019e42fd-1111-7000-8000-000000000021'],
              excludeTagIds: [],
              sortOrder: 0,
              weight: 1,
            }],
          }),
        }),
      );
    });
  });

  test('ListEditor renaming the title marks the form dirty and Save calls patchList', async () => {
    renderManager();
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/prompts/lists/019e42fd-1111-7000-8000-000000000010') && init?.method === 'PATCH') {
        return Response.json({ ...library.variableLists[0], name: 'eras' });
      }
      return Response.json(library);
    }) as unknown as typeof fetch;

    fireEvent.click(await screen.findByRole('tab', { name: 'Variable lists' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Edit list era(,|$)/ }));
    const editor = screen.getByRole('form', { name: 'Edit variable list era' });

    expect(within(editor).getByRole('button', { name: 'Save list' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Variable list name' }), { target: { value: 'eras' } });
    expect(within(editor).getByRole('button', { name: 'Save list' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(within(editor).getByRole('button', { name: 'Save list' }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/prompts/lists/019e42fd-1111-7000-8000-000000000010',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ name: 'eras' }),
        }),
      );
    });
  });

  test('ListEditor blank title keeps Save disabled and never calls patchList', async () => {
    renderManager();
    fireEvent.click(await screen.findByRole('tab', { name: 'Variable lists' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Edit list era(,|$)/ }));
    const editor = screen.getByRole('form', { name: 'Edit variable list era' });

    fireEvent.change(within(editor).getByRole('textbox', { name: 'Variable list name' }), { target: { value: '   ' } });
    expect(within(editor).getByRole('button', { name: 'Save list' }).hasAttribute('disabled')).toBe(true);
  });

  test('help is an on-demand dialog toggled by the header info button', async () => {
    renderManager();
    const toggle = await screen.findByRole('button', { name: 'How the prompt library works' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog', { name: 'How the prompt library works' })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const dialog = screen.getByRole('dialog', { name: 'How the prompt library works' });
    expect(toggle.getAttribute('aria-controls')).toBe(dialog.getAttribute('id'));
    expect(dialog.textContent).toMatch(/Templates/);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog', { name: 'How the prompt library works' })).toBeNull();
  });

  test('the ⓘ toggle can close the open help panel via pointerdown then click', async () => {
    renderManager();
    const toggle = await screen.findByRole('button', { name: 'How the prompt library works' });
    fireEvent.click(toggle);
    expect(screen.getByRole('dialog', { name: 'How the prompt library works' })).toBeTruthy();
    fireEvent.pointerDown(toggle);
    fireEvent.click(toggle);
    expect(screen.queryByRole('dialog', { name: 'How the prompt library works' })).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  test('a stale persisted help pref does not auto-open the modal on mount', async () => {
    window.localStorage.setItem('atelier.promptHelpExpanded', '1');
    renderManager();
    await screen.findByRole('button', { name: 'How the prompt library works' });
    expect(screen.queryByRole('dialog', { name: 'How the prompt library works' })).toBeNull();
  });

  test('tabs render inside the managed-view header, not as a standalone band', () => {
    renderManager();
    const section = document.querySelector('section[aria-labelledby]');
    if (!section) throw new Error('managed section not found');
    const headerEl = section.querySelector('header');
    if (!headerEl) throw new Error('managed-view header not found');
    const tablist = within(headerEl).getByRole('tablist', { name: 'Prompt library sections' });
    expect(within(tablist).getAllByRole('tab')).toHaveLength(4);
    expect(within(headerEl).getByRole('button', { name: 'How the prompt library works' })).toBeTruthy();
  });

  test('tabs are wired to tabpanels and use horizontal roving focus', async () => {
    renderManager();
    const tablist = screen.getByRole('tablist', { name: 'Prompt library sections' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((tabButton) => tabButton.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);

    const templatesTab = screen.getByRole('tab', { name: 'Templates' });
    const templatesPanelId = templatesTab.getAttribute('aria-controls');
    expect(templatesTab.getAttribute('id')).toBe('tab-templates');
    expect(templatesPanelId).toBe('tabpanel-templates');
    const templatesPanel = screen.getByRole('tabpanel', { name: 'Templates' });
    expect(templatesPanel.getAttribute('id')).toBe(templatesPanelId);
    expect(templatesPanel.querySelector('aside')?.parentElement === templatesPanel).toBe(true);

    templatesTab.focus();
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    const variableTab = screen.getByRole('tab', { name: 'Variable lists' });
    await waitFor(() => { expect(document.activeElement?.id).toBe('tab-lists'); });
    expect(variableTab.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'Templates' }).getAttribute('tabindex')).toBe('-1');
  });

  test('empty tabs show teaching copy instead of bland placeholders', async () => {
    renderManager(emptyLibrary);
    // The editor column owns the empty state (heading + syntax teaching); the
    // rail no longer repeats it.
    expect(await screen.findByRole('heading', { name: 'No templates yet' })).toBeTruthy();
    expect(screen.getByText(/pull from a Variable list/)).toBeTruthy();
    expect(screen.queryAllByText(/No templates yet/)).toHaveLength(1);

    fireEvent.click(screen.getByRole('tab', { name: 'Variable lists' }));
    expect(await screen.findByRole('heading', { name: 'No variable lists yet' })).toBeTruthy();
    expect(screen.queryAllByText(/No variable lists yet/)).toHaveLength(1);

    fireEvent.click(screen.getByRole('tab', { name: 'Dimensions' }));
    expect(await screen.findByText(/No dimensions yet\./)).toBeTruthy();
  });

  const twoOptionLibrary: PromptLibraryResponse = {
    templates: [template],
    variableLists: [{
      id: '019e42fd-1111-7000-8000-000000000010',
      name: 'era',
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      options: [
        { id: 'opt-a', listId: '019e42fd-1111-7000-8000-000000000010', value: 'alpha', tagIds: [], sortOrder: 0, weight: 1 },
        { id: 'opt-b', listId: '019e42fd-1111-7000-8000-000000000010', value: 'bravo', tagIds: [], sortOrder: 1, weight: 1 },
      ],
    }],
    dimensions: library.dimensions,
  };

  async function openEraEditor(seed: PromptLibraryResponse = library) {
    const r = renderManager(seed);
    fireEvent.click(await screen.findByRole('tab', { name: 'Variable lists' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Edit list era(,|$)/ }));
    return { ...r, editor: screen.getByRole('form', { name: 'Edit variable list era' }) };
  }

  test('list editor: single head zone, entry strip kept, no Name band', async () => {
    const { editor } = await openEraEditor();
    assertZones(editor, { head: 1, body: 1, entry: 1, foot: 0 });
    expect(editor.querySelector('[data-zone="entry"]')?.textContent).toMatch(/Options ·/);
    expect(within(editor).queryByText('Name')).toBeNull();
    expect(within(editor).getByRole('textbox', { name: 'Variable list name' })).toBeTruthy();
    expect(within(editor).getByRole('button', { name: /Draft List/ })).toBeTruthy();
  });

  test('Add control is pinned in the ENTRY zone, before the scroll BODY', async () => {
    const { editor } = await openEraEditor();
    const entry = editor.querySelector('[data-zone="entry"]');
    const body = editor.querySelector('[data-zone="body"]');
    expect(entry).toBeTruthy();
    expect(body).toBeTruthy();
    const add = within(editor).getByRole('button', { name: '+ Add option' });
    expect(entry?.contains(add)).toBe(true);
    expect(body?.contains(add)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(entry!.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('+ Add option prepends an empty row at the top and focuses it', async () => {
    const { editor } = await openEraEditor(twoOptionLibrary);
    const before = within(editor).getAllByRole('textbox', { name: /^Option \d/ });
    expect(before.length).toBe(2);
    fireEvent.click(within(editor).getByRole('button', { name: '+ Add option' }));
    const after = within(editor).getAllByRole('textbox', { name: /^Option \d/ });
    expect(after.length).toBe(3);
    const [first, second] = after as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    expect(first).toBe(document.activeElement as HTMLInputElement);
    expect(first.value).toBe('');
    expect(second.value).toBe('alpha');
  });

  test('Enter in an option input adds a row and does NOT submit (no save)', async () => {
    const { editor } = await openEraEditor(twoOptionLibrary);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const inputs = within(editor).getAllByRole('textbox', { name: /^Option \d/ });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const input = inputs[1]! as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(within(editor).getAllByRole('textbox', { name: /^Option \d/ }).length).toBe(3);
    const putCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[1] === 'object' && (c[1] as RequestInit).method === 'PUT',
    );
    expect(putCalls.length).toBe(0);
  });

  test('Alt+ArrowDown on the first row reorders and enables Save', async () => {
    const { editor } = await openEraEditor(twoOptionLibrary);
    const inputs = within(editor).getAllByRole('textbox', { name: /^Option \d/ });
    const [firstInput] = inputs as [HTMLInputElement, HTMLInputElement];
    expect(firstInput.value).toBe('alpha');
    fireEvent.keyDown(firstInput, { key: 'ArrowDown', altKey: true });
    const after = within(editor).getAllByRole('textbox', { name: /^Option \d/ });
    const [afterFirst, afterSecond] = after as [HTMLInputElement, HTMLInputElement];
    expect(afterFirst.value).toBe('bravo');
    expect(afterSecond.value).toBe('alpha');
    expect(within(editor).getByRole('button', { name: 'Save list' }).hasAttribute('disabled')).toBe(false);
  });

  test('removing the last option shows the centred empty hint, Add still present', async () => {
    const { editor } = await openEraEditor();
    fireEvent.click(within(editor).getByRole('button', { name: /^Remove option/ }));
    expect(within(editor).getByText('Add options to make this list usable in templates.')).toBeTruthy();
    expect(within(editor).getByRole('button', { name: '+ Add option' })).toBeTruthy();
  });

  async function openDimensionEditor() {
    const r = renderManager();
    fireEvent.click(await screen.findByRole('tab', { name: 'Dimensions' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Edit dimension Epoch(,|$)/ }));
    return { ...r, editor: screen.getByRole('form', { name: /^Edit dimension Epoch(,|$)/ }) };
  }

  test('DimensionEditor pins Add tag in ENTRY before the scroll BODY', async () => {
    const { editor } = await openDimensionEditor();
    const entry = editor.querySelector('[data-zone="entry"]');
    const body = editor.querySelector('[data-zone="body"]');
    expect(entry).toBeTruthy();
    expect(body).toBeTruthy();
    const add = within(editor).getByRole('button', { name: '+ Add tag' });
    expect(entry?.contains(add)).toBe(true);
    expect(body?.contains(add)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(entry!.compareDocumentPosition(body as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('DimensionEditor + Add tag prepends an empty row and focuses it', async () => {
    const { editor } = await openDimensionEditor();
    const before = within(editor).getAllByRole('textbox', { name: /^Tag \d/ });
    fireEvent.click(within(editor).getByRole('button', { name: '+ Add tag' }));
    const after = within(editor).getAllByRole('textbox', { name: /^Tag \d/ });
    expect(after.length).toBe(before.length + 1);
    const [first] = after as [HTMLInputElement, ...HTMLInputElement[]];
    expect(first).toBe(document.activeElement as HTMLInputElement);
    expect(first.value).toBe('');
  });

  test('Dimensions tab: AI button opens the review panel when bundles are proposed', async () => {
    renderManager();
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/dimensions/infer')) {
        return sseDoneResponse({
          proposalId: 'p',
          proposal: { bundles: [{
            key: 'create:F', kind: 'create', title: 'New dimension: F', dimensionName: 'F',
            detail: 'tags 1 option', impact: '', destructive: false, defaultChecked: true,
            dependsOn: [], optionCount: 1, listCount: 1,
          }] },
          baseSnapshotHash: 'h',
          warnings: [],
          coverage: [],
          rejected: [],
          conflicts: [],
        });
      }
      if (url.includes('library-diagnosis')) {
        // Healthy diagnosis — all templates satisfiable — so the AI button proceeds.
        return Response.json({ templates: [{ templateName: 'Editorial portrait', satisfiable: true }], librarySnapshotHash: 'h', templatesDigest: 'd' });
      }
      return Response.json(library);
    }) as unknown as typeof fetch;
    fireEvent.click(await screen.findByRole('tab', { name: 'Dimensions' }));
    const aiBtn = await screen.findByRole('button', { name: /Propose Dimensions/ });
    fireEvent.click(aiBtn);
    await waitFor(() => { expect(screen.getByText(/Apply 1 of 1/)).toBeTruthy(); });
  });

  test('Dimensions tab: AI button on empty proposal returns to idle (no silent click-into-void)', async () => {
    renderManager();
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/dimensions/infer')) {
        return sseDoneResponse({
          proposalId: '',
          proposal: { bundles: [] },
          baseSnapshotHash: 'h',
          warnings: [],
          coverage: [],
          rejected: [],
          conflicts: [],
        });
      }
      if (url.includes('library-diagnosis')) {
        return Response.json({ templates: [{ templateName: 'Editorial portrait', satisfiable: true }], librarySnapshotHash: 'h', templatesDigest: 'd' });
      }
      return Response.json(library);
    }) as unknown as typeof fetch;
    fireEvent.click(await screen.findByRole('tab', { name: 'Dimensions' }));
    const aiBtn = await screen.findByRole('button', { name: /Propose Dimensions/ });
    fireEvent.click(aiBtn);
    // No panel renders for an empty proposal; the AI button stays enabled +
    // returns to idle label.
    await waitFor(() => { expect((aiBtn as HTMLButtonElement).disabled).toBe(false); });
    expect(screen.queryByText(/Apply \d+ of \d+/)).toBeNull();
  });

  test('Dimensions tab: AI button renders streaming progress labels', async () => {
    renderManager();
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const controller = (): ReadableStreamDefaultController<Uint8Array> => {
      if (!streamController) throw new Error('stream controller not bound');
      return streamController;
    };
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/dimensions/infer')) {
        return sseStreamResponse((controller) => {
          streamController = controller;
        });
      }
      if (url.includes('library-diagnosis')) {
        return Response.json({ templates: [{ templateName: 'Editorial portrait', satisfiable: true }], librarySnapshotHash: 'h', templatesDigest: 'd' });
      }
      return Response.json(library);
    }) as unknown as typeof fetch;
    fireEvent.click(await screen.findByRole('tab', { name: 'Dimensions' }));
    fireEvent.click(await screen.findByRole('button', { name: /Propose Dimensions/ }));

    await waitFor(() => { expect(streamController).toBeTruthy(); });
    controller().enqueue(encoder.encode(
      'event: infer-phase\n' +
      'data: {"phase":"taxonomy"}\n\n',
    ));
    expect(await screen.findByRole('button', { name: 'Analyzing taxonomy...' })).toBeTruthy();

    controller().enqueue(encoder.encode(
      'event: infer-phase\n' +
      'data: {"phase":"chunks"}\n\n' +
      'event: infer-progress\n' +
      'data: {"done":1,"total":3,"wave":1}\n\n',
    ));
    expect(await screen.findByRole('button', { name: '1/3 chunks' })).toBeTruthy();

    controller().enqueue(encoder.encode(
      'event: infer-phase\n' +
      'data: {"phase":"retry-gaps"}\n\n' +
      'event: infer-progress\n' +
      'data: {"done":1,"total":4,"wave":2}\n\n',
    ));
    expect(await screen.findByRole('button', { name: 'Retrying 3 of 4...' })).toBeTruthy();

    controller().enqueue(encoder.encode(
      'event: infer-phase\n' +
      'data: {"phase":"finalize"}\n\n',
    ));
    expect(await screen.findByRole('button', { name: 'Finalizing...' })).toBeTruthy();

    controller().enqueue(encoder.encode(
      'event: done\n' +
      'data: {"proposalId":"","proposal":{"bundles":[]},"baseSnapshotHash":"h","warnings":[],"coverage":[],"rejected":[]}\n\n',
    ));
    controller().close();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Propose Dimensions/ })).toBeTruthy();
    });
  });

  test('template editor: one head zone with inline title + meter; verbose syntax moved out', async () => {
    renderManager();
    fireEvent.click(await screen.findByRole('button', { name: 'Editorial portrait' }));
    const form = screen.getByRole('form', { name: 'Edit template Editorial portrait' });
    assertZones(form, { head: 1, body: 1, entry: 0, foot: 1 });
    const head = form.querySelector('[data-zone="head"]');
    if (!head) throw new Error('head zone missing');
    expect(head.textContent).toMatch(new RegExp(`/\\s*${MAX_PROMPT_CHARS}`));
    expect(within(form).getByRole('textbox', { name: 'Template name' })).toBeTruthy();
    expect(within(form).queryByText('Name')).toBeNull();
    expect(within(form).queryByText(new RegExp(`resolved prompt must fit ${MAX_PROMPT_CHARS} chars`, 'i'))).toBeNull();
  });

  test('TemplateEditor: body is the scroll BODY, token panel is a fixed FOOT sibling', async () => {
    renderManager();
    fireEvent.click(await screen.findByRole('button', { name: 'Editorial portrait' }));
    const editor = screen.getByRole('form', { name: 'Edit template Editorial portrait' });
    const body = editor.querySelector('[data-zone="body"]');
    const foot = editor.querySelector('[data-zone="foot"]');
    expect(body).toBeTruthy();
    expect(foot).toBeTruthy();
    const textarea = within(editor).getByLabelText('Body');
    const meterRegion = within(editor).getByText(/Referenced lists/);
    expect(body?.contains(textarea)).toBe(true);
    expect(foot?.contains(textarea)).toBe(false);
    expect(foot?.contains(meterRegion)).toBe(true);
  });

  test('bare + Add option (no typing) does NOT dirty the form — Save stays disabled', async () => {
    const { editor } = await openEraEditor(twoOptionLibrary);
    expect(within(editor).getByRole('button', { name: 'Save list' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(editor).getByRole('button', { name: '+ Add option' }));
    expect(within(editor).getAllByRole('textbox', { name: /^Option \d/ }).length).toBe(3);
    expect(within(editor).getByRole('button', { name: 'Save list' }).hasAttribute('disabled')).toBe(true);
  });

  test('typing into the freshly added option DOES dirty the form', async () => {
    const { editor } = await openEraEditor(twoOptionLibrary);
    fireEvent.click(within(editor).getByRole('button', { name: '+ Add option' }));
    const [first] = within(editor).getAllByRole('textbox', { name: /^Option \d/ }) as [HTMLInputElement, ...HTMLInputElement[]];
    fireEvent.change(first, { target: { value: 'charlie' } });
    expect(within(editor).getByRole('button', { name: 'Save list' }).hasAttribute('disabled')).toBe(false);
  });

  test('bare + Add tag (no typing) does NOT dirty the dimension form', async () => {
    const { editor } = await openDimensionEditor();
    expect(within(editor).getByRole('button', { name: 'Save dimension' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(editor).getByRole('button', { name: '+ Add tag' }));
    expect(within(editor).getByRole('button', { name: 'Save dimension' }).hasAttribute('disabled')).toBe(true);
  });

  test('dimension editor: one head zone; name persists via Save, not blur', async () => {
    const { editor } = await openDimensionEditor();
    assertZones(editor, { head: 1, body: 1, entry: 1, foot: 0 });
    const title = within(editor).getByRole('textbox', { name: 'Dimension name' });
    fireEvent.change(title, { target: { value: 'Epoch v2' } });
    fireEvent.blur(title);
    // Blur does NOT commit — the name persists only via "Save dimension"
    // (the shared InlineFieldChrome name-save contract).
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const patchedOnBlur = fetchMock.mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('/api/prompts/dimensions/')
        && typeof c[1] === 'object' && (c[1] as RequestInit).method === 'PATCH',
    );
    expect(patchedOnBlur).toBe(false);
    fireEvent.click(within(editor).getByRole('button', { name: 'Save dimension' }));
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/prompts/dimensions/019e42fd-1111-7000-8000-000000000020',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Epoch v2' }) }),
      );
    });
  });

  test('dimension editor: an empty name is never committed (Save stays disabled)', async () => {
    const { editor } = await openDimensionEditor();
    const title: HTMLInputElement = within(editor).getByRole('textbox', { name: 'Dimension name' });
    fireEvent.change(title, { target: { value: '' } });
    fireEvent.blur(title);
    // No commit-on-blur and no revert: the field keeps the edited value.
    expect(title.value).toBe('');
    // An empty/whitespace name does not dirty the form, so Save can't commit it.
    expect(within(editor).getByRole('button', { name: 'Save dimension' }).hasAttribute('disabled')).toBe(true);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const patched = fetchMock.mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('/api/prompts/dimensions/')
        && typeof c[1] === 'object' && (c[1] as RequestInit).method === 'PATCH',
    );
    expect(patched).toBe(false);
  });

  test('dimension editor: Escape blurs the title without committing or reverting', async () => {
    const { editor } = await openDimensionEditor();
    const title: HTMLInputElement = within(editor).getByRole('textbox', { name: 'Dimension name' });
    title.focus();
    fireEvent.change(title, { target: { value: 'Epoch v2' } });
    fireEvent.keyDown(title, { key: 'Escape' });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    const patched = fetchMock.mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('/api/prompts/dimensions/')
        && typeof c[1] === 'object' && (c[1] as RequestInit).method === 'PATCH',
    );
    expect(patched).toBe(false);
    // Escape blurs but does not revert local edits (name persists until Save).
    expect(title.value).toBe('Epoch v2');
  });

  test('Template editor: unknown-list warning stays visible while Referenced lists is collapsed', async () => {
    const baseTpl = library.templates[0];
    if (!baseTpl) throw new Error('seed template missing');
    const seed: PromptLibraryResponse = {
      ...library,
      templates: [{ ...baseTpl, body: 'a {{var::ghost}} b' }],
    };
    renderManager(seed);
    fireEvent.click(await screen.findByRole('button', { name: baseTpl.name }));
    const form = screen.getByRole('form', { name: `Edit template ${baseTpl.name}` });
    // disclosure collapsed by default → no tokenPanel chips visible
    expect(within(form).getByRole('button', { name: /Referenced lists ·/ }).getAttribute('aria-expanded')).toBe('false');
    // but the unknown-list warning is shown regardless
    expect(within(form).getByText(/Unknown list:\s*ghost/i)).toBeTruthy();
  });
});
