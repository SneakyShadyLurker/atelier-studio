import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { AdminProvider, TextModelsResponse, TextRoutingResponse } from '@atelier/shared';
import { TEXT_TASK_DESCRIPTIONS, TEXT_TASK_GROUPS, TEXT_TASK_LABELS, TEXT_TASKS } from '@atelier/shared';
import { textAdminKeys } from '../../api/textProviders';
import { textModelKeys } from '../../api/textModels';
import { useAtelierStore } from '../../store/atelier';
import { PROVIDERS, ROUTING } from './fixtures';
import SharedSetup from './SharedSetup';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

interface RoutingBody {
  readonly modelId: string | null;
  readonly mode?: 'lock' | 'prefer';
  readonly effort?: string | null;
}

const FEATURES_NOTE = 'What each feature writes with for everyone. People can pick their own model under Your picks.';
const EMPTY_LISTING: TextModelsResponse = { models: [], tasks: [], defaults: { byTask: {} }, writers: {}, lockedWriters: [] };

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

/** The server answers each routing PUT with `next(url, body, current)`. */
function renderPanel(
  initial: TextRoutingResponse = ROUTING,
  next: (url: string, body: RoutingBody, current: TextRoutingResponse) => TextRoutingResponse = () => initial,
  providers: readonly AdminProvider[] = PROVIDERS,
  listing: TextModelsResponse = EMPTY_LISTING,
) {
  const calls: Call[] = [];
  let current = initial;
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as RoutingBody : undefined;
    calls.push({ method, url, body });
    if (url.includes('/api/text-routing')) {
      if (method === 'PUT' && body) current = next(url, body, current);
      return Response.json(current);
    }
    if (url.includes('/api/text-providers')) return Response.json({ providers: PROVIDERS });
    return Response.json(listing);
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(textAdminKeys.routing(), initial);
  client.setQueryData(textModelKeys.all(), listing);
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<SharedSetup providers={providers} />, { wrapper: Wrapper });
  return { calls, client };
}

const puts = (calls: readonly Call[]) => calls.filter((call) => call.method === 'PUT');
const featureChips = () => screen.getAllByRole('button', { name: /^Model for / });

/** Every (model id) assigned task on Kimi, the rest on the default; the server echoes the PUT. */
function echoTask(url: string, body: RoutingBody, current: TextRoutingResponse): TextRoutingResponse {
  const scope = url.split('/').at(-1) as 'default' | 'enhance' | 'ai-fill';
  if (scope === 'default') {
    const { default: _old, ...rest } = current.defaults;
    const efforts = { ...current.efforts };
    if (body.effort === null || body.modelId === null) delete efforts.default;
    else if (body.effort !== undefined) efforts.default = body.effort as 'high';
    return { ...current, defaults: body.modelId === null ? rest : { ...rest, default: body.modelId }, efforts };
  }
  const byTask = Object.fromEntries(Object.entries(current.defaults.byTask).filter(([key]) => key !== scope));
  const effortByTask = Object.fromEntries(Object.entries(current.efforts.byTask).filter(([key]) => key !== scope));
  const effort = body.effort === undefined ? current.efforts.byTask[scope] : body.effort ?? undefined;
  return {
    ...current,
    defaults: { ...current.defaults, byTask: body.modelId === null ? byTask : { ...byTask, [scope]: body.modelId } },
    efforts: { ...current.efforts, byTask: body.modelId === null || effort === undefined ? effortByTask : { ...effortByTask, [scope]: effort } },
  };
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ toasts: [] });
});

describe('SharedSetup', () => {
  test('loading routing keeps its existing note until data arrives', () => {
    globalThis.fetch = mock(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedSetup providers={PROVIDERS} /></QueryClientProvider>);
    expect(screen.getByText('Loading routing…')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Features' })).toBeTruthy();
    expect(screen.queryByText(FEATURES_NOTE)).toBeNull();
    expect(screen.queryByText('Turn on a model to choose a default.')).toBeNull();
  });

  test.each([
    { state: 'ordinary default', id: 'm-kimi', note: 'Every feature uses it unless one is assigned below.' },
    { state: 'unknown status', id: 'm-scout', note: 'Every feature uses it unless one is assigned below.' },
    { state: 'offline default', id: 'm-glm', note: 'GLM 5.3 is offline right now.' },
    { state: 'removed default', id: 'removed', note: 'This default model is no longer listed. Choose another.' },
  ])('$state reports current facts without a write', ({ id, note }) => {
    const { calls } = renderPanel({ ...ROUTING, defaults: { ...ROUTING.defaults, default: id } });
    expect(screen.getByText(note)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Features' })).toBeTruthy();
    expect(screen.getByText(FEATURES_NOTE)).toBeTruthy();
    // The count line is gone; the chips themselves show one assignment and ten inherited rows.
    expect(screen.queryByText(/assigned, \d+ use the default/)).toBeNull();
    expect(featureChips().filter((chip) => chip.getAttribute('aria-label')?.includes('currently Default model'))).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Model for AI fill, currently Kimi K3' })).toBeTruthy();
    expect(puts(calls)).toEqual([]);
  });

  test('an off default is named while another model remains enabled', () => {
    const providers = PROVIDERS.map((provider) => ({ ...provider, models: provider.models.map((model) => model.id === 'm-kimi' ? { ...model, enabled: false, status: 'offline' as const } : model) }));
    const { calls } = renderPanel(ROUTING, undefined, providers);
    expect(screen.getByText('Kimi K3 is off. Turn it on or choose another default.')).toBeTruthy();
    expect(puts(calls)).toEqual([]);
  });

  test('no enabled model takes precedence, while provider enabledness does not change the note', () => {
    const off = PROVIDERS.map((provider) => ({ ...provider, models: provider.models.map((model) => ({ ...model, enabled: false })) }));
    const { calls } = renderPanel(ROUTING, undefined, off);
    expect(screen.getByText('Turn on a model to choose a default.')).toBeTruthy();
    cleanup();
    const disabledProviders = PROVIDERS.map((provider) => ({ ...provider, enabled: false }));
    const second = renderPanel(ROUTING, undefined, disabledProviders);
    expect(screen.getByText('Every feature uses it unless one is assigned below.')).toBeTruthy();
    expect([...puts(calls), ...puts(second.calls)]).toEqual([]);
  });

  test.each([0, 1, TEXT_TASKS.length - 1, TEXT_TASKS.length])('without a default, %i feature assignments leave factual notes', (assigned) => {
    const byTask = Object.fromEntries(TEXT_TASKS.slice(0, assigned).map((task) => [task, 'm-kimi']));
    const unassigned = TEXT_TASKS.length - assigned;
    const { calls } = renderPanel({ ...ROUTING, defaults: { byTask } });
    // Replaces the old "N assigned, M unassigned." line: the chips carry the counts.
    expect(screen.queryByText(`${assigned} assigned, ${unassigned} unassigned.`)).toBeNull();
    expect(featureChips().filter((chip) => chip.getAttribute('aria-label')?.endsWith('currently Kimi K3'))).toHaveLength(assigned);
    expect(featureChips().filter((chip) => chip.getAttribute('aria-label')?.endsWith('currently Default model'))).toHaveLength(unassigned);
    expect(screen.getByText(unassigned === 0 ? 'All features have assignments.' : `No default yet. Choose one for the ${unassigned} unassigned ${unassigned === 1 ? 'feature' : 'features'}.`)).toBeTruthy();
    expect(puts(calls)).toEqual([]);
  });

  test('default model lists "No default" first, then enabled models by provider', async () => {
    renderPanel();
    const select = await screen.findByRole('button', { name: 'Default model, currently Kimi K3' });
    fireEvent.click(select);
    expect(screen.getByRole('listbox').textContent).toBe(
      'No defaultCLIProxyAPIKimi K3GLM 5.3offlineOllama on this MacLlama 4 Scout',
    );
  });

  test('changing the default writes through PUT and shows the saved state', async () => {
    const { calls, client } = renderPanel(ROUTING, (_url, body) => ({
      ...ROUTING,
      defaults: { ...ROUTING.defaults, ...(body.modelId === null ? {} : { default: body.modelId }) },
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Default model, currently Kimi K3' }));
    fireEvent.click(screen.getByRole('option', { name: 'Llama 4 Scout' }));

    await screen.findByRole('button', { name: 'Default model, currently Llama 4 Scout' });
    expect(puts(calls)).toEqual([
      { method: 'PUT', url: '/api/text-routing/defaults/default', body: { modelId: 'm-scout' } },
    ]);
    // The personal listing is invalidated; its mounted observer re-reads it at once.
    const putAt = calls.findIndex((call) => call.method === 'PUT');
    await waitFor(() => {
      expect(calls.slice(putAt + 1).some((call) => call.method === 'GET' && call.url === '/api/text-models')).toBe(true);
    });
    expect(client.getQueryState(textModelKeys.all())?.status).toBe('success');
  });

  test('feature rows list all eleven features, "Default model (…)" first', async () => {
    renderPanel();
    await screen.findByRole('region', { name: 'Features' });
    for (const task of TEXT_TASKS) {
      const label = TEXT_TASK_LABELS[task];
      const expected = task === 'ai-fill' ? 'Kimi K3' : 'Default model (Kimi K3)';
      expect(screen.getByRole('button', { name: `Model for ${label}, currently ${expected}` })).toBeTruthy();
    }
    expect(featureChips()).toHaveLength(11);

    fireEvent.click(screen.getByRole('button', { name: 'Model for Enhance, currently Default model (Kimi K3)' }));
    expect(screen.getAllByRole('option')[0]?.textContent).toBe('Default model (Kimi K3)');
  });

  test('feature rows sit under Composer, Stories and Prompt Library, in order, each with its description', async () => {
    renderPanel();
    const features = await screen.findByRole('region', { name: 'Features' });
    const groups = within(features).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-labelledby') && document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent))
      .toEqual(['Composer', 'Stories', 'Prompt Library']);
    groups.forEach((group, index) => {
      const chips = within(group).getAllByRole('button', { name: /^Model for / });
      expect(chips.map((chip) => chip.getAttribute('aria-label')?.replace(/^Model for (.+), currently .*$/, '$1')))
        .toEqual((TEXT_TASK_GROUPS[index]?.tasks ?? []).map((task) => TEXT_TASK_LABELS[task]));
    });
    for (const task of TEXT_TASKS) expect(within(features).getByText(TEXT_TASK_DESCRIPTIONS[task])).toBeTruthy();
    // The Default model row comes first, outside the groups.
    expect(within(features).getAllByRole('button')[0]?.getAttribute('aria-label')).toBe('Default model, currently Kimi K3');
  });

  test('an unassigned feature shows the default model it falls back to, quietly behind a decorative ↳', async () => {
    renderPanel();
    const enhance = await screen.findByRole('button', { name: 'Model for Enhance, currently Default model (Kimi K3)' });
    expect(enhance.textContent).toContain('Kimi K3');
    expect(enhance.querySelector('[aria-hidden="true"]')?.textContent).toBe('↳ ');
  });

  test('with no default model, an unassigned feature reads "No model"', async () => {
    renderPanel({ ...ROUTING, defaults: { byTask: {} } });
    const motion = await screen.findByRole('button', { name: 'Model for Motion writer, currently Default model' });
    expect(motion.textContent).toBe('No model');
    fireEvent.click(motion);
    expect(screen.getAllByRole('option')[0]?.textContent).toBe('Default model');
    expect(screen.getByRole('button', { name: 'Default model, currently No default' }).textContent).toBe('No default');
  });

  test('assigning and clearing a feature', async () => {
    const { calls } = renderPanel(ROUTING, echoTask);
    fireEvent.click(await screen.findByRole('button', { name: 'Model for Enhance, currently Default model (Kimi K3)' }));
    fireEvent.click(screen.getByRole('option', { name: 'Llama 4 Scout' }));
    await screen.findByRole('button', { name: 'Model for Enhance, currently Llama 4 Scout' });
    // The first menu leaves on a timer; let it unmount before opening the next.
    await act(() => Bun.sleep(300));

    fireEvent.click(screen.getByRole('button', { name: 'Model for AI fill, currently Kimi K3' }));
    fireEvent.click(screen.getByRole('option', { name: 'Default model (Kimi K3)' }));
    await screen.findByRole('button', { name: 'Model for AI fill, currently Default model (Kimi K3)' });

    expect(puts(calls).map((call) => [call.url, call.body])).toEqual([
      ['/api/text-routing/defaults/enhance', { modelId: 'm-scout' }],
      ['/api/text-routing/defaults/ai-fill', { modelId: null }],
    ]);
  });

  test('an offline model stays assignable with its hint', async () => {
    const { calls } = renderPanel(ROUTING, echoTask);
    fireEvent.click(await screen.findByRole('button', { name: 'Model for Enhance, currently Default model (Kimi K3)' }));
    const glm = screen.getByRole('option', { name: /^GLM 5\.3/ });
    expect(glm.textContent).toBe('GLM 5.3offline');
    expect(glm.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(glm);
    await screen.findByRole('button', { name: 'Model for Enhance, currently GLM 5.3' });
    expect(puts(calls).map((call) => call.body)).toEqual([{ modelId: 'm-glm' }]);
  });

  test('prompt writers: one row per registered image model, "No writer" by default, no mode until chosen', async () => {
    renderPanel();
    const images = await screen.findByRole('region', { name: 'Image models' });
    expect(within(images).getByText('Give an image model its own prompt writer. It writes every prompt made for that image model.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prompt writer for GPT Image 2.6 Sunburst, currently No writer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prompt writer for Krea 2, currently No writer' })).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(within(images).queryByRole('button', { name: /^Reasoning effort for / })).toBeNull();
  });

  test('choosing a writer saves it as prefer, then lock and clear write through', async () => {
    const { calls } = renderPanel(ROUTING, (url, body) => {
      const imageModelId = decodeURIComponent(url.split('/').at(-1) ?? '');
      const writers = { ...ROUTING.writers };
      return body.modelId === null
        ? { ...ROUTING, writers }
        : { ...ROUTING, writers: { ...writers, [imageModelId]: { modelId: body.modelId, mode: body.mode ?? 'prefer' } } };
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Prompt writer for Krea 2, currently No writer' }));
    fireEvent.click(screen.getByRole('option', { name: 'Kimi K3' }));
    await screen.findByRole('button', { name: 'Prompt writer for Krea 2, currently Kimi K3' });

    const group = screen.getByRole('radiogroup', { name: 'When Krea 2 uses Kimi K3' });
    const prefer = within(group).getByRole('radio', { name: 'Unless someone picked their own' });
    const lock = within(group).getByRole('radio', { name: 'Always' });
    expect((prefer as HTMLInputElement).checked).toBe(true);
    expect((lock as HTMLInputElement).checked).toBe(false);

    fireEvent.click(lock);
    await waitFor(() => { expect((lock as HTMLInputElement).checked).toBe(true); });

    fireEvent.click(screen.getByRole('button', { name: 'Prompt writer for Krea 2, currently Kimi K3' }));
    fireEvent.click(screen.getByRole('option', { name: 'No writer' }));
    await screen.findByRole('button', { name: 'Prompt writer for Krea 2, currently No writer' });
    expect(screen.queryByRole('radiogroup')).toBeNull();

    expect(puts(calls).map((call) => [call.url, call.body])).toEqual([
      ['/api/text-routing/writers/krea-2', { modelId: 'm-kimi' }],
      ['/api/text-routing/writers/krea-2', { modelId: 'm-kimi', mode: 'lock' }],
      ['/api/text-routing/writers/krea-2', { modelId: null }],
    ]);
  });

  test('switching a locked writer to another model keeps the lock', async () => {
    const locked: TextRoutingResponse = { ...ROUTING, writers: { 'krea-2': { modelId: 'm-kimi', mode: 'lock' } } };
    const { calls } = renderPanel(locked);
    fireEvent.click(await screen.findByRole('button', { name: 'Prompt writer for Krea 2, currently Kimi K3' }));
    fireEvent.click(screen.getByRole('option', { name: 'Llama 4 Scout' }));
    await waitFor(() => { expect(puts(calls)).toHaveLength(1); });
    expect(puts(calls)[0]?.body).toEqual({ modelId: 'm-scout', mode: 'lock' });
  });

  test('a failed write toasts the server message and keeps the saved state', async () => {
    globalThis.fetch = mock(() => Response.json({ error: 'That model is turned off.' }, { status: 400 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(textAdminKeys.routing(), ROUTING);
    client.setQueryData(textModelKeys.all(), EMPTY_LISTING);
    render(
      <QueryClientProvider client={client}><SharedSetup providers={PROVIDERS} /></QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Default model, currently Kimi K3' }));
    fireEvent.click(screen.getByRole('option', { name: /^GLM 5\.3/ }));
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts.some((toast) => toast.text.includes('That model is turned off.'))).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'Default model, currently Kimi K3' })).toBeTruthy();
  });
});

describe('SharedSetup effort', () => {
  test('an effort chip appears only on rows with an assignment', async () => {
    renderPanel({ ...ROUTING, writers: { 'krea-2': { modelId: 'm-kimi', mode: 'prefer' } } });
    await screen.findByRole('region', { name: 'Features' });
    expect(screen.getAllByRole('button', { name: /^Reasoning effort for / }).map((chip) => chip.getAttribute('aria-label'))).toEqual([
      'Reasoning effort for Default model, currently Default effort',
      'Reasoning effort for AI fill, currently Default effort',
      'Reasoning effort for Krea 2, currently Default effort',
    ]);
  });

  test('a stored effort shows as "<Level> effort"; one the model no longer offers shows as Default effort', async () => {
    renderPanel({ ...ROUTING, efforts: { default: 'max', byTask: { 'ai-fill': 'medium' } } });
    expect(await screen.findByRole('button', { name: 'Reasoning effort for Default model, currently Max effort' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reasoning effort for AI fill, currently Default effort' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort for AI fill, currently Default effort' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Default effort', 'Low', 'High', 'Max']);
  });

  test('a model without reasoning levels shows "Effort fixed by the model"', async () => {
    renderPanel({ ...ROUTING, defaults: { ...ROUTING.defaults, byTask: { enhance: 'm-scout' } } });
    await screen.findByRole('button', { name: 'Model for Enhance, currently Llama 4 Scout' });
    expect(screen.getAllByText('Effort fixed by the model')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Reasoning effort for Enhance/ })).toBeNull();
  });

  test('saving the default effort sends the current model with the effort, null for Default effort', async () => {
    const { calls } = renderPanel(ROUTING, echoTask);
    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for Default model, currently Default effort' }));
    fireEvent.click(screen.getByRole('option', { name: 'High' }));
    await screen.findByRole('button', { name: 'Reasoning effort for Default model, currently High effort' });
    await act(() => Bun.sleep(300));
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort for Default model, currently High effort' }));
    fireEvent.click(screen.getByRole('option', { name: 'Default effort' }));
    await screen.findByRole('button', { name: 'Reasoning effort for Default model, currently Default effort' });
    expect(puts(calls).map((call) => [call.url, call.body])).toEqual([
      ['/api/text-routing/defaults/default', { modelId: 'm-kimi', effort: 'high' }],
      ['/api/text-routing/defaults/default', { modelId: 'm-kimi', effort: null }],
    ]);
  });

  test('saving a feature effort sends its model; a later model change omits the effort', async () => {
    const { calls } = renderPanel(ROUTING, echoTask);
    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for AI fill, currently Default effort' }));
    fireEvent.click(screen.getByRole('option', { name: 'Max' }));
    await screen.findByRole('button', { name: 'Reasoning effort for AI fill, currently Max effort' });
    await act(() => Bun.sleep(300));
    fireEvent.click(screen.getByRole('button', { name: 'Model for AI fill, currently Kimi K3' }));
    fireEvent.click(screen.getByRole('option', { name: /^GLM 5\.3/ }));
    await screen.findByRole('button', { name: 'Model for AI fill, currently GLM 5.3' });
    expect(puts(calls).map((call) => [call.url, call.body])).toEqual([
      ['/api/text-routing/defaults/ai-fill', { modelId: 'm-kimi', effort: 'max' }],
      ['/api/text-routing/defaults/ai-fill', { modelId: 'm-glm' }],
    ]);
  });

  test('an effort change on a locked writer sends the lock with it', async () => {
    const locked: TextRoutingResponse = { ...ROUTING, writers: { 'krea-2': { modelId: 'm-kimi', mode: 'lock' } } };
    const { calls } = renderPanel(locked);
    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for Krea 2, currently Default effort' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for Krea 2, currently Default effort' }));
    fireEvent.click(screen.getByRole('option', { name: 'Default effort' }));
    await waitFor(() => { expect(puts(calls)).toHaveLength(2); });
    expect(puts(calls).map((call) => [call.url, call.body])).toEqual([
      ['/api/text-routing/writers/krea-2', { modelId: 'm-kimi', mode: 'lock', effort: 'low' }],
      ['/api/text-routing/writers/krea-2', { modelId: 'm-kimi', mode: 'lock', effort: null }],
    ]);
  });

  test('a writer effort the model no longer offers shows as Default effort', async () => {
    renderPanel({ ...ROUTING, writers: { 'krea-2': { modelId: 'm-glm', mode: 'prefer', effort: 'max' } } });
    expect(await screen.findByRole('button', { name: 'Reasoning effort for Krea 2, currently Default effort' })).toBeTruthy();
  });

  test('every control in both panels is disabled while a routing save is pending', async () => {
    let release: (() => void) | undefined;
    const writers: TextRoutingResponse['writers'] = { 'krea-2': { modelId: 'm-kimi', mode: 'prefer' } };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(textAdminKeys.routing(), { ...ROUTING, writers });
    client.setQueryData(textModelKeys.all(), EMPTY_LISTING);
    let routing: TextRoutingResponse = { ...ROUTING, writers };
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return Promise.resolve(Response.json(urlOf(input).includes('/text-routing') ? routing : EMPTY_LISTING));
      return new Promise<Response>((resolve) => {
        release = () => {
          routing = { ...routing, efforts: { byTask: { 'ai-fill': 'low' } } };
          resolve(Response.json(routing));
        };
      });
    }) as unknown as typeof fetch;
    render(<QueryClientProvider client={client}><SharedSetup providers={PROVIDERS} /></QueryClientProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort for AI fill, currently Default effort' }));
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Default model, currently Kimi K3' }).hasAttribute('disabled')).toBe(true);
    });
    const controls = [
      ...screen.getAllByRole('button', { name: /^(Default model,|Model for |Prompt writer for |Reasoning effort for )/ }),
      ...screen.getAllByRole('radio'),
    ];
    expect(controls.length).toBe(1 + 11 + 2 + 3 + 2);
    for (const control of controls) expect(control.hasAttribute('disabled')).toBe(true);

    release?.();
    await screen.findByRole('button', { name: 'Reasoning effort for AI fill, currently Low effort' });
    for (const control of screen.getAllByRole('button', { name: /^(Default model,|Model for |Prompt writer for |Reasoning effort for )/ })) {
      expect(control.hasAttribute('disabled')).toBe(false);
    }
  });
});

describe('SharedSetup own pick', () => {
  const listing: TextModelsResponse = {
    models: [{ id: 'm-scout', displayName: 'Llama 4 Scout', providerName: 'Ollama on this Mac', vision: true, reasoningLevels: [], status: 'unknown' }],
    tasks: [
      { task: 'enhance', pick: 'm-scout', effectiveModelId: 'm-scout', pickState: 'active' },
      // A pick the listing does not name is not stated.
      { task: 'motion', pick: 'gone', effectiveModelId: 'm-kimi' },
      { task: 'brainstorm', effectiveModelId: 'm-kimi' },
    ],
    defaults: { default: 'm-kimi', byTask: {} },
    writers: {},
    lockedWriters: [],
  };

  test('a listed personal pick is stated on its feature row only', async () => {
    renderPanel(ROUTING, undefined, PROVIDERS, listing);
    await screen.findByRole('region', { name: 'Features' });
    expect(screen.getAllByText(/^Your own pick here is /)).toHaveLength(1);
    expect(screen.getByText('Your own pick here is Llama 4 Scout.', { exact: false })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Use the shared model' })).toHaveLength(1);
  });

  test('"Use the shared model" clears the personal pick and is inert while that save is pending', async () => {
    let release: (() => void) | undefined;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(textAdminKeys.routing(), ROUTING);
    client.setQueryData(textModelKeys.all(), listing);
    const cleared: TextModelsResponse = { ...listing, tasks: [{ task: 'enhance', effectiveModelId: 'm-kimi' }] };
    let current = listing;
    const calls: Call[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      calls.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined });
      if (url.includes('/text-routing')) return Promise.resolve(Response.json(ROUTING));
      if (init?.method !== 'PUT') return Promise.resolve(Response.json(current));
      return new Promise<Response>((resolve) => { release = () => { current = cleared; resolve(Response.json(cleared)); }; });
    }) as unknown as typeof fetch;
    render(<QueryClientProvider client={client}><SharedSetup providers={PROVIDERS} /></QueryClientProvider>);

    const action = screen.getByRole('button', { name: 'Use the shared model' });
    fireEvent.click(action);
    await waitFor(() => { expect(puts(calls)).toHaveLength(1); });
    expect(puts(calls)[0]).toEqual({ method: 'PUT', url: '/api/text-models/tasks/enhance', body: { modelId: null } });
    // Optimistic: the pick clears at once; a held button would stay inert.
    await waitFor(() => { expect(screen.queryByText(/^Your own pick here is /)).toBeNull(); });
    // Routing controls are not locked by a personal save.
    expect(screen.getByRole('button', { name: 'Default model, currently Kimi K3' }).hasAttribute('disabled')).toBe(false);

    release?.();
    await waitFor(() => { expect(client.getQueryData<TextModelsResponse>(textModelKeys.all())?.tasks).toEqual(cleared.tasks); });
  });

  test('the action is aria-disabled and ignores presses while its feature has a pending personal save', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(textAdminKeys.routing(), ROUTING);
    client.setQueryData(textModelKeys.all(), listing);
    const calls: Call[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      calls.push({ method: init?.method ?? 'GET', url, body: undefined });
      if (url.includes('/text-routing')) return Promise.resolve(Response.json(ROUTING));
      if (init?.method !== 'PUT') return Promise.resolve(Response.json(listing));
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    render(<QueryClientProvider client={client}><SharedSetup providers={PROVIDERS} /></QueryClientProvider>);
    // A pending personal save on Enhance, started elsewhere (Your picks), keeping the pick listed.
    const pendingSave = client.getMutationCache().build(client, {
      mutationKey: ['text-models', 'set'],
      mutationFn: () => new Promise<never>(() => undefined),
    });
    await act(async () => {
      void pendingSave.execute({ task: 'enhance', modelId: 'm-scout' });
      await Promise.resolve();
    });
    const action = await screen.findByRole('button', { name: 'Use the shared model' });
    await waitFor(() => { expect(action.getAttribute('aria-disabled')).toBe('true'); });
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.hasAttribute('disabled')).toBe(false);
    fireEvent.click(action);
    await act(() => Bun.sleep(20));
    expect(puts(calls)).toEqual([]);
  });
});

describe('SharedSetup across a tab change', () => {
  afterEach(() => { cleanup(); });

  // Review finding: the panel unmounts when the admin leaves the tab. A save
  // still in flight must keep the controls locked after it mounts again,
  // because an effort save sends the row's model id from the routing cache,
  // which is stale until the model save lands.
  test('a save still pending when the panel mounts again keeps every control disabled', async () => {
    let release: (() => void) | undefined;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(textAdminKeys.routing(), ROUTING);
    client.setQueryData(textModelKeys.all(), EMPTY_LISTING);
    let routing: TextRoutingResponse = ROUTING;
    const putBodies: RoutingBody[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return Promise.resolve(Response.json(urlOf(input).includes('/text-routing') ? routing : EMPTY_LISTING));
      if (typeof init.body === 'string') putBodies.push(JSON.parse(init.body) as RoutingBody);
      return new Promise<Response>((resolve) => {
        release = () => {
          routing = { ...routing, efforts: { default: 'high', byTask: {} } };
          resolve(Response.json(routing));
        };
      });
    }) as unknown as typeof fetch;
    const tree = <QueryClientProvider client={client}><SharedSetup providers={PROVIDERS} /></QueryClientProvider>;
    const first = render(tree);

    fireEvent.click(screen.getByRole('button', { name: 'Reasoning effort for Default model, currently Default effort' }));
    fireEvent.click(screen.getByRole('option', { name: 'High' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Default model, currently Kimi K3' }).hasAttribute('disabled')).toBe(true);
    });

    // Leave the tab and come back while the request is still out.
    first.unmount();
    render(tree);
    const controls = screen.getAllByRole('button', { name: /^(Default model,|Model for |Prompt writer for |Reasoning effort for )/ });
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control.hasAttribute('disabled')).toBe(true);
    expect(putBodies).toHaveLength(1);

    await act(async () => { release?.(); await Bun.sleep(0); });
    await screen.findByRole('button', { name: 'Reasoning effort for Default model, currently High effort' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Default model, currently Kimi K3' }).hasAttribute('disabled')).toBe(false);
    });
  });
});
