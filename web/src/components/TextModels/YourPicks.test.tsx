import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { Model, PublicTextModel, TaskRow, TextModelsResponse } from '@atelier/shared';
import { TEXT_TASK_DESCRIPTIONS, TEXT_TASK_GROUPS, TEXT_TASK_LABELS, TEXT_TASKS } from '@atelier/shared';
import { modelKeys } from '../../api/models';
import { promptKeys } from '../../api/prompts';
import { textModelKeys } from '../../api/textModels';
import { useAtelierStore } from '../../store/atelier';
import YourPicks from './YourPicks';

// Provider order is first appearance; Llama sits between CLIProxy models on
// purpose so grouping cannot rely on the server's ordering.
const MODELS: readonly PublicTextModel[] = [
  { id: 'kimi', displayName: 'Kimi K3', providerName: 'CLIProxyAPI', vision: true, reasoningLevels: ['low', 'high', 'max'], status: 'available' },
  { id: 'scout', displayName: 'Llama 4 Scout', providerName: 'Ollama on this Mac', vision: true, reasoningLevels: [], status: 'unknown' },
  { id: 'grok', displayName: 'Grok 4.7', providerName: 'CLIProxyAPI', vision: false, reasoningLevels: ['low', 'medium', 'high', 'xhigh'], status: 'available' },
  { id: 'glm', displayName: 'GLM 5.3', providerName: 'CLIProxyAPI', vision: false, reasoningLevels: ['low', 'high'], status: 'offline' },
];

function settings(rows: Partial<Record<string, Omit<TaskRow, 'task'>>> = {}): TextModelsResponse {
  return {
    models: MODELS,
    tasks: TEXT_TASKS.map((task) => ({ task, effectiveModelId: 'kimi', ...rows[task] })),
    defaults: { default: 'kimi', byTask: {} },
    writers: {}, lockedWriters: [],
  };
}

const PICKS_NOTE = 'Pick a model for a feature to use it instead of the shared one. A feature you leave alone follows the shared setup, shown with ↳.';

/** A query client; by default the person has Prompt Library access (the library is loaded). */
function newClient(library = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (library) client.setQueryData(promptKeys.library(), { templates: [], variableLists: [], dimensions: [] });
  return client;
}

const NO_MODELS: TextModelsResponse = { ...settings(), models: [], tasks: [], defaults: { byTask: {} } };

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** `admin` is the view's classification; YourPicks itself never probes it. */
function renderPanel(response: TextModelsResponse = settings(), putStatus = 200, admin = false, onGoToProviders?: () => void) {
  const client = newClient();
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    if (urlOf(input).includes('/text-models')) {
      if (init?.method === 'PUT' && putStatus !== 200) return Response.json({ error: 'That model is offline.' }, { status: putStatus });
      return Response.json(response);
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  return { ...render(<YourPicks admin={admin} onGoToProviders={onGoToProviders} />, { wrapper: wrapper(client) }), client };
}

function putCalls(fetchMock: ReturnType<typeof mock>) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
}

afterEach(() => {
  cleanup();
  mock.restore();
  window.localStorage.clear();
  useAtelierStore.setState({ toasts: [] });
});

describe('YourPicks', () => {
  for (const admin of [true, false]) {
    test(`zero models: the ${admin ? 'admin' : 'non-admin'} empty state replaces the rows and clears on query refresh`, async () => {
      const { client } = renderPanel(NO_MODELS, 200, admin);
      const copy = admin ? 'Add a provider and its models under Providers.' : 'Ask your admin to connect a text model.';
      const other = admin ? 'Ask your admin to connect a text model.' : 'Add a provider and its models under Providers.';
      expect(await screen.findByRole('heading', { name: 'No text model yet' })).toBeTruthy();
      expect(document.querySelector('[data-etching="empty-text-models"]')).not.toBeNull();
      expect(screen.getByText(copy)).toBeTruthy();
      expect(screen.queryByText(other)).toBeNull();
      expect(screen.queryByRole('button', { name: /^Text model for / })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Reasoning effort for / })).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
      await act(async () => { client.setQueryData(textModelKeys.all(), settings()); await Promise.resolve(); });
      expect(await screen.findByText(PICKS_NOTE)).toBeTruthy();
      expect(screen.queryByText(copy)).toBeNull();
      expect(screen.getAllByRole('button', { name: /^Text model for / })).toHaveLength(TEXT_TASKS.length);
      for (const row of screen.getAllByRole('button', { name: /^Text model for / })) expect(row.hasAttribute('disabled')).toBe(false);
    });
  }

  test('the admin empty state goes to Providers; the non-admin one offers no action', async () => {
    const onGoToProviders = mock(() => undefined);
    renderPanel(NO_MODELS, 200, true, onGoToProviders);
    fireEvent.click(await screen.findByRole('button', { name: 'Go to Providers' }));
    expect(onGoToProviders).toHaveBeenCalledTimes(1);
    cleanup();

    renderPanel(NO_MODELS, 200, false, onGoToProviders);
    expect(await screen.findByText('Ask your admin to connect a text model.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Go to Providers' })).toBeNull();
  });

  test('a settled admin answer updates the empty state through the existing snapshot', async () => {
    const client = newClient();
    globalThis.fetch = mock(() => Response.json(NO_MODELS)) as unknown as typeof fetch;
    const { rerender } = render(<YourPicks admin={false} />, { wrapper: wrapper(client) });
    expect(await screen.findByText('Ask your admin to connect a text model.')).toBeTruthy();
    rerender(<YourPicks admin onGoToProviders={() => undefined} />);
    expect(await screen.findByText('Add a provider and its models under Providers.')).toBeTruthy();
    expect(screen.queryByText('Ask your admin to connect a text model.')).toBeNull();
  });

  test('introduces the section and renders a row for every task on its default', async () => {
    renderPanel();

    expect(await screen.findByRole('heading', { level: 3, name: 'Your picks' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Your picks' })).toBeTruthy();
    expect(screen.getByText(PICKS_NOTE)).toBeTruthy();
    for (const task of TEXT_TASKS) {
      expect(screen.getByRole('button', { name: `Text model for ${TEXT_TASK_LABELS[task]}, currently Shared setup (Kimi K3)` })).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { name: /^Text model for / })).toHaveLength(TEXT_TASKS.length);
  });

  test('zero models shows the empty state instead of rows and asks the admin to connect a model', async () => {
    renderPanel(NO_MODELS);
    expect(await screen.findByRole('heading', { name: 'No text model yet' })).toBeTruthy();
    expect(screen.getByText('Ask your admin to connect a text model.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Your picks' })).toBeNull();
    expect(screen.queryAllByRole('button', { name: /^Text model for / })).toHaveLength(0);
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('lists the default first, then models grouped by provider, offline ones disabled', async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /^Text model for AI fill/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Shared setup (Kimi K3)',
      'Kimi K3',
      'Grok 4.7',
      'GLM 5.3offline',
      'Llama 4 Scout',
    ]);
    // Provider headers sit above their models, the default above both.
    expect(screen.getByRole('listbox').textContent).toBe(
      'Shared setup (Kimi K3)CLIProxyAPIKimi K3Grok 4.7GLM 5.3offlineOllama on this MacLlama 4 Scout',
    );
    // 'unknown' status still routes, so only 'offline' is disabled.
    expect(screen.getByRole('option', { name: /^GLM 5\.3/ }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('option', { name: /^Llama 4 Scout/ }).getAttribute('aria-disabled')).toBeNull();
  });

  test('names the model the task inherits from the shared setup', async () => {
    renderPanel({ ...settings({ brainstorm: { effectiveModelId: 'grok' } }), defaults: { default: 'kimi', byTask: { brainstorm: 'grok' } } });

    fireEvent.click(await screen.findByRole('button', { name: 'Text model for Brainstorm, currently Shared setup (Grok 4.7)' }));
    expect(screen.getByRole('option', { name: 'Shared setup (Grok 4.7)' })).toBeTruthy();
  });

  test('the inherited label skips an offline task assignment, as the resolver does', async () => {
    renderPanel({
      ...settings({ enhance: { pick: 'grok', effectiveModelId: 'grok', pickState: 'active' } }),
      defaults: { default: 'kimi', byTask: { enhance: 'glm' } },
    });

    fireEvent.click(await screen.findByRole('button', { name: /^Text model for Enhance/ }));
    expect(screen.getByRole('option', { name: 'Shared setup (Kimi K3)' })).toBeTruthy();
  });

  test('selecting a model saves the pick for that task', async () => {
    renderPanel();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

    fireEvent.click(await screen.findByRole('button', { name: /^Text model for Brainstorm/ }));
    fireEvent.click(screen.getByRole('option', { name: /^Grok 4\.7/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/text-models/tasks/brainstorm',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ modelId: 'grok' }) }),
      );
    });
  });

  test('selecting the shared setup clears the pick', async () => {
    renderPanel(settings({ 'ai-fill': { pick: 'grok', effectiveModelId: 'grok', pickState: 'active' } }));
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

    fireEvent.click(await screen.findByRole('button', { name: 'Text model for AI fill, currently Grok 4.7' }));
    fireEvent.click(screen.getByRole('option', { name: 'Shared setup (Kimi K3)' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/text-models/tasks/ai-fill',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ modelId: null }) }),
      );
    });
  });

  test('an offline model is not selectable', async () => {
    renderPanel();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

    fireEvent.click(await screen.findByRole('button', { name: /^Text model for Enhance/ }));
    fireEvent.click(screen.getByRole('option', { name: /^GLM 5\.3/ }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(putCalls(fetchMock)).toHaveLength(0);
  });

  test('an offline pick says the task is using the shared setup', async () => {
    renderPanel(settings({ storytelling: { pick: 'glm', effectiveModelId: 'kimi', pickState: 'offline' } }));

    expect(await screen.findByText('GLM 5.3 is offline right now; Story planner is using the shared setup.')).toBeTruthy();
    expect(screen.getAllByText(/is offline right now/)).toHaveLength(1);
  });

  test('a failed save rolls back and shows an error toast', async () => {
    renderPanel(settings(), 400);

    fireEvent.click(await screen.findByRole('button', { name: /^Text model for Enhance/ }));
    fireEvent.click(screen.getByRole('option', { name: /^Grok 4\.7/ }));

    await waitFor(() => {
      expect(useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Text model for Enhance, currently Shared setup (Kimi K3)' })).toBeTruthy();
    });
  });

  test('a failed background refetch keeps the rows on screen', async () => {
    const client = newClient();
    const current = settings({ enhance: { pick: 'grok', effectiveModelId: 'grok', pickState: 'active' } });
    globalThis.fetch = mock((input: RequestInfo | URL) => Response.json(urlOf(input).includes('/text-models') ? current : {})) as unknown as typeof fetch;
    render(<YourPicks admin={false} />, { wrapper: wrapper(client) });
    expect(await screen.findByRole('button', { name: 'Text model for Enhance, currently Grok 4.7' })).toBeTruthy();

    globalThis.fetch = mock(() => Response.json({ error: 'upstream down' }, { status: 502 })) as unknown as typeof fetch;
    await client.refetchQueries({ queryKey: textModelKeys.all() });
    await waitFor(() => { expect(client.getQueryState(textModelKeys.all())?.status).toBe('error'); });

    expect(screen.getByRole('button', { name: 'Text model for Enhance, currently Grok 4.7' })).toBeTruthy();
    expect(screen.queryByText('Couldn’t load the text model settings.')).toBeNull();
  });

  test('a failed first load offers a retry', async () => {
    const client = newClient();
    // 400 is not retryable, so the first load fails without backoff.
    globalThis.fetch = mock((input: RequestInfo | URL) => (urlOf(input).includes('/text-models')
      ? Response.json({ error: 'bad request' }, { status: 400 })
      : Response.json({}))) as unknown as typeof fetch;
    render(<YourPicks admin={false} />, { wrapper: wrapper(client) });

    expect(await screen.findByText('Couldn’t load the text model settings.')).toBeTruthy();
    globalThis.fetch = mock((input: RequestInfo | URL) => Response.json(urlOf(input).includes('/text-models') ? settings() : {})) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('button', { name: /^Text model for Enhance/ })).toBeTruthy();
  });
});

describe('YourPicks reasoning effort', () => {
  test('keeps inactive and offline effort slots mounted, hidden and inert without a tip', async () => {
    const { container } = renderPanel(settings({ brainstorm: { pick: 'glm', effort: 'high', effectiveModelId: 'kimi', pickState: 'offline' } }));
    await screen.findByRole('heading', { name: 'Your picks' });
    for (const label of ['AI fill', 'Brainstorm']) {
      const button = container.querySelector(`button[aria-label="Reasoning effort for ${label}, currently Default effort"]`);
      expect(button).toBeTruthy();
      expect(button?.hasAttribute('disabled')).toBe(true);
      expect(button?.hasAttribute('data-tip')).toBe(false);
      expect(button?.parentElement?.style.visibility).toBe('hidden');
      expect(button?.parentElement?.hasAttribute('inert')).toBe(true);
      expect(button?.parentElement?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(screen.queryByRole('button', { name: /^Reasoning effort for / })).toBeNull();
    expect(screen.getByText('GLM 5.3 is offline right now; Brainstorm is using the shared setup.')).toBeTruthy();
  });

  test('saving and clearing a usable pick reveals and hides the same mounted effort slot', async () => {
    const client = newClient();
    let current = settings();
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      if (!urlOf(input).includes('/text-models')) return Response.json({});
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as { modelId: string | null };
        current = body.modelId === null ? settings() : settings({ 'ai-fill': { pick: body.modelId, effectiveModelId: body.modelId, pickState: 'active' } });
      }
      return Response.json(current);
    }) as unknown as typeof fetch;
    const { container } = render(<YourPicks admin={false} />, { wrapper: wrapper(client) });
    const model = await screen.findByRole('button', { name: /^Text model for AI fill/ });
    const effort = container.querySelector<HTMLButtonElement>('button[aria-label="Reasoning effort for AI fill, currently Default effort"]');
    if (!effort) throw new Error('expected mounted effort control');
    const slot = effort.parentElement;
    fireEvent.click(model);
    await act(() => Bun.sleep(0));
    fireEvent.click(screen.getByRole('option', { name: 'Kimi K3' }));
    await act(() => Bun.sleep(300));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Reasoning effort for AI fill/ }) === effort).toBe(true);
      expect(model.hasAttribute('disabled')).toBe(false);
    });
    expect(slot?.hasAttribute('inert')).toBe(false);
    expect(slot?.hasAttribute('aria-hidden')).toBe(false);
    expect(slot?.style.visibility).toBe('');
    expect(screen.queryByRole('listbox') === null).toBe(true);
    fireEvent.click(model);
    fireEvent.click(screen.getByRole('option', { name: 'Shared setup (Kimi K3)' }));
    await waitFor(() => { expect(slot?.hasAttribute('inert')).toBe(true); });
    expect(slot?.style.visibility).toBe('hidden');
    expect(slot?.contains(effort)).toBe(true);
    expect(screen.queryByRole('button', { name: /^Reasoning effort for AI fill/ })).toBeNull();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;
    expect(putCalls(fetchMock).map(([, init]) => JSON.parse((init as RequestInit).body as string) as unknown)).toEqual([{ modelId: 'kimi' }, { modelId: null }]);
  });

  test('offers only the levels the picked model accepts and shows the stored one', async () => {
    renderPanel(settings({ enhance: { pick: 'kimi', effort: 'max', effectiveModelId: 'kimi', pickState: 'active' } }));

    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for Enhance, currently Max effort' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Default effort', 'Low', 'High', 'Max']);
  });

  test('an effort the picked model no longer offers shows as the default', async () => {
    renderPanel(settings({ enhance: { pick: 'kimi', effort: 'medium', effectiveModelId: 'kimi', pickState: 'active' } }));

    expect(await screen.findByRole('button', { name: 'Reasoning effort for Enhance, currently Default effort' })).toBeTruthy();
  });

  test('each model offers its own levels', async () => {
    renderPanel(settings({ condense: { pick: 'grok', effectiveModelId: 'grok', pickState: 'active' } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for Krea condense, currently Default effort' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Default effort', 'Low', 'Medium', 'High', 'Extra high']);
  });

  test('a fixed-effort model shows text instead of an effort control', async () => {
    renderPanel(settings({ 'list-draft': { pick: 'scout', effectiveModelId: 'scout', pickState: 'active' } }));

    expect(await screen.findByText('Effort fixed by the model')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Reasoning effort for List drafts/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reasoning effort for / })).toBeNull();
    expect(document.querySelectorAll('button[aria-label^="Reasoning effort for "]')).toHaveLength(TEXT_TASKS.length - 1);
  });

  test('selecting an effort saves it with the pick; Default sends null', async () => {
    renderPanel(settings({ storytelling: { pick: 'grok', effort: 'low', effectiveModelId: 'grok', pickState: 'active' } }));
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for Story planner, currently Low effort' }));
    fireEvent.click(screen.getByRole('option', { name: 'Extra high' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/text-models/tasks/storytelling',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ modelId: 'grok', effort: 'xhigh' }) }),
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: /^Reasoning effort for Story planner/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Default effort' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/text-models/tasks/storytelling',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ modelId: 'grok', effort: null }) }),
      );
    });
  });
});

describe('YourPicks save ordering', () => {
  test('locks a row until its save settles so a later choice cannot be overwritten', async () => {
    const client = newClient();
    let releasePut: (() => void) | undefined;
    const current = settings({ enhance: { pick: 'kimi', effectiveModelId: 'kimi', pickState: 'active' } });
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      if (!urlOf(input).includes('/text-models')) return Promise.resolve(Response.json({}));
      if (init?.method !== 'PUT') return Promise.resolve(Response.json(current));
      return new Promise<Response>((resolve) => {
        releasePut = () => { resolve(Response.json(current)); };
      });
    }) as unknown as typeof fetch;
    render(<YourPicks admin={false} />, { wrapper: wrapper(client) });

    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for Enhance, currently Default effort' }));
    fireEvent.click(screen.getByRole('option', { name: 'Max' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Text model for Enhance/ }).hasAttribute('disabled')).toBe(true);
    });
    expect(screen.getByRole('button', { name: /^Reasoning effort for Enhance/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /^Text model for AI fill/ }).hasAttribute('disabled')).toBe(false);

    releasePut?.();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Text model for Enhance/ }).hasAttribute('disabled')).toBe(false);
    });
  });
});

function imageModel(id: string, name: string): Model {
  return { id, name, backend: 'cloud', tag: 'test', latency: 'medium', supportedRatios: ['1:1'], pool: 'shared', concurrencyCapPerUser: 4, maxCountPerBatch: 4 };
}

const IMAGE_MODELS: readonly Model[] = [imageModel('krea-2', 'Krea 2'), imageModel('gpt-image-2.6-sunburst', 'GPT Image 2.6 Sunburst')];

type LibraryAccess = 'enabled' | 'gated' | 'pending';

/** Renders with a chosen Prompt Library access and the app's image-model list. */
function renderAccess(response: TextModelsResponse, library: LibraryAccess, imageModels: readonly Model[] = IMAGE_MODELS) {
  const client = newClient(library === 'enabled');
  client.setQueryData(modelKeys.list(), imageModels);
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url.includes('/text-models')) return Promise.resolve(Response.json(response));
    if (url.endsWith('/api/prompts')) {
      return library === 'gated' ? Promise.resolve(Response.json({ error: 'not found' }, { status: 404 })) : new Promise<Response>(() => undefined);
    }
    if (url.endsWith('/api/models')) return Promise.resolve(Response.json(imageModels));
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  return render(<YourPicks admin={false} />, { wrapper: wrapper(client) });
}

const groupNames = () => screen.getAllByRole('group').map((group) => document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent);

describe('YourPicks groups', () => {
  test('lists features under Composer, Stories and Prompt Library with a description each', async () => {
    renderAccess(settings(), 'enabled');
    await screen.findByRole('region', { name: 'Your picks' });
    expect(groupNames()).toEqual(['Composer', 'Stories', 'Prompt Library']);
    screen.getAllByRole('group').forEach((group, index) => {
      const labels = within(group).getAllByRole('button', { name: /^Text model for / })
        .map((chip) => chip.getAttribute('aria-label')?.replace(/^Text model for (.+), currently .*$/, '$1'));
      expect(labels).toEqual((TEXT_TASK_GROUPS[index]?.tasks ?? []).map((task) => TEXT_TASK_LABELS[task]));
    });
    for (const task of TEXT_TASKS) expect(screen.getByText(TEXT_TASK_DESCRIPTIONS[task])).toBeTruthy();
    expect(screen.getByText(PICKS_NOTE)).toBeTruthy();
  });

  for (const library of ['gated', 'pending'] as const) {
    test(`omits the Prompt Library group while access is ${library}`, async () => {
      renderAccess(settings(), library);
      await screen.findByRole('region', { name: 'Your picks' });
      await act(() => Bun.sleep(20));
      expect(groupNames()).toEqual(['Composer', 'Stories']);
      expect(screen.getAllByRole('button', { name: /^Text model for / })).toHaveLength(5);
      expect(screen.queryByRole('button', { name: /^Text model for AI fill/ })).toBeNull();
      expect(screen.queryByText(TEXT_TASK_DESCRIPTIONS['ai-fill'])).toBeNull();
    });
  }
});

describe('YourPicks vocabulary', () => {
  test('an unset row shows its inherited model quietly behind a decorative ↳', async () => {
    renderAccess(settings(), 'enabled');
    const chip = await screen.findByRole('button', { name: 'Text model for Enhance, currently Shared setup (Kimi K3)' });
    expect(chip.textContent).toBe('↳ Kimi K3');
    expect(chip.querySelector('[aria-hidden="true"]')?.textContent).toBe('↳ ');
  });

  test('a row with nothing to inherit reads "Shared setup"', async () => {
    renderAccess({ ...settings(), tasks: [{ task: 'enhance' }], defaults: { byTask: {} } }, 'enabled');
    const chip = await screen.findByRole('button', { name: 'Text model for Enhance, currently Shared setup' });
    expect(chip.textContent).toBe('Shared setup');
    fireEvent.click(chip);
    expect(screen.getAllByRole('option')[0]?.textContent).toBe('Shared setup');
  });

  test('a set row shows its model in full and its effort as "<Level> effort"', async () => {
    renderAccess(settings({ enhance: { pick: 'grok', effort: 'xhigh', effectiveModelId: 'grok', pickState: 'active' } }), 'enabled');
    const chip = await screen.findByRole('button', { name: 'Text model for Enhance, currently Grok 4.7' });
    expect(chip.textContent).toBe('Grok 4.7');
    expect(chip.querySelector('[aria-hidden="true"]:not(svg)')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reasoning effort for Enhance, currently Extra high effort' }).textContent).toBe('Extra high effort');
  });
});

describe('YourPicks writers note', () => {
  const withWriters = (writers: Record<string, string>, lockedWriters: readonly string[] = []): TextModelsResponse => ({ ...settings(), writers, lockedWriters });

  test('no writers, no note', async () => {
    renderAccess(settings(), 'enabled');
    await screen.findByRole('region', { name: 'Your picks' });
    expect(screen.queryByRole('note')).toBeNull();
  });

  test('a locked writer always writes, whichever model the person picks', async () => {
    renderAccess(withWriters({ 'krea-2': 'grok' }, ['krea-2']), 'enabled');
    const note = await screen.findByRole('note');
    expect(note.textContent).toBe('Krea 2 is always written by Grok 4.7, whichever model you pick.');
  });

  test('a preferred writer writes unless the person picks a model', async () => {
    renderAccess(withWriters({ 'krea-2': 'kimi' }), 'enabled');
    const note = await screen.findByRole('note');
    expect(note.textContent).toBe('Krea 2 is written by Kimi K3 unless you pick a model for the feature.');
  });

  test('mixed writers each get a sentence, and an image model the client does not know is skipped', async () => {
    renderAccess(withWriters({ 'krea-2': 'grok', 'gpt-image-2.6-sunburst': 'kimi', 'retired-image': 'kimi' }, ['krea-2']), 'enabled');
    const note = await screen.findByRole('note');
    expect([...note.querySelectorAll('p')].map((line) => line.textContent)).toEqual([
      'Krea 2 is always written by Grok 4.7, whichever model you pick.',
      'GPT Image 2.6 Sunburst is written by Kimi K3 unless you pick a model for the feature.',
    ]);
    expect(within(note).getByText('Grok 4.7').tagName).toBe('SPAN');
    expect(note.textContent).not.toContain('effort');
  });

  test('when no writer names a known image model, no note shows', async () => {
    renderAccess(withWriters({ 'retired-image': 'kimi' }), 'enabled');
    await screen.findByRole('region', { name: 'Your picks' });
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('YourPicks through a failed library refetch', () => {
  afterEach(() => { cleanup(); });

  // Review finding: access was already known, so a background refetch that
  // fails (cached data kept, no 404) must not hide the Prompt Library rows.
  test('keeps the Prompt Library group when a later read of the library fails', async () => {
    const client = newClient(true);
    client.setQueryData(modelKeys.list(), IMAGE_MODELS);
    const query = client.getQueryCache().find({ queryKey: promptKeys.library() });
    if (query === undefined) throw new Error('library query was not seeded');
    query.setState({ ...query.state, status: 'error', error: new Error('network down'), fetchStatus: 'idle' });
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes('/text-models')) return Promise.resolve(Response.json(settings()));
      if (url.endsWith('/api/prompts')) return Promise.reject(new Error('network down'));
      if (url.endsWith('/api/models')) return Promise.resolve(Response.json(IMAGE_MODELS));
      return Promise.resolve(Response.json({}));
    }) as unknown as typeof fetch;
    render(<YourPicks admin={false} />, { wrapper: wrapper(client) });

    await screen.findByRole('region', { name: 'Your picks' });
    await act(() => Bun.sleep(20));
    expect(groupNames()).toEqual(['Composer', 'Stories', 'Prompt Library']);
    expect(screen.getAllByRole('button', { name: /^Text model for / })).toHaveLength(TEXT_TASKS.length);
  });
});
