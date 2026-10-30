import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { PublicTextModel, TaskRow, TextModelsResponse } from '@atelier/shared';
import { TEXT_TASK_LABELS, TEXT_TASKS } from '@atelier/shared';
import { promptKeys } from '../../api/prompts';
import { textModelKeys } from '../../api/textModels';
import { useAtelierStore, type PromptManagerTab } from '../../store/atelier';
import PromptManager from './index';
import SettingsPanel from './SettingsPanel';

const emptyLibrary = { templates: [], variableLists: [], dimensions: [] };

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
    writers: {},
  };
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderPanel(response: TextModelsResponse = settings(), putStatus = 200) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    if (urlOf(input).includes('/text-models')) {
      if (init?.method === 'PUT' && putStatus !== 200) return Response.json({ error: 'That model is offline.' }, { status: putStatus });
      return Response.json(response);
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  return render(<SettingsPanel />, { wrapper: wrapper(client) });
}

function renderManagerOnSettingsTab() {
  const onBack = mock(() => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(promptKeys.library(), emptyLibrary);
  client.setQueryData(textModelKeys.all(), settings());
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    if (urlOf(input).includes('/text-models')) return Response.json(settings());
    return Response.json(emptyLibrary);
  }) as unknown as typeof fetch;
  useAtelierStore.setState({ promptManagerTab: 'settings' as PromptManagerTab });
  return render(<PromptManager onBack={onBack} />, { wrapper: wrapper(client) });
}

function putCalls(fetchMock: ReturnType<typeof mock>) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
}

afterEach(() => {
  cleanup();
  mock.restore();
  window.localStorage.clear();
  useAtelierStore.setState({ promptManagerTab: 'templates', toasts: [] });
});

describe('SettingsPanel text models', () => {
  test('introduces the section and renders a row for every task on its default', async () => {
    renderPanel();

    expect(await screen.findByText('Text models')).toBeTruthy();
    expect(screen.getByText('Pick which model writes for each feature. Default uses what your admin set.')).toBeTruthy();
    for (const task of TEXT_TASKS) {
      expect(screen.getByRole('button', { name: `Text model for ${TEXT_TASK_LABELS[task]}, currently Default · Kimi K3` })).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { name: /^Text model for / })).toHaveLength(TEXT_TASKS.length);
  });

  test('lists the default first, then models grouped by provider, offline ones disabled', async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: /^Text model for AI fill/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Use default · Kimi K3',
      'Kimi K3',
      'Grok 4.7',
      'GLM 5.3offline',
      'Llama 4 Scout',
    ]);
    // Provider headers sit above their models, the default above both.
    expect(screen.getByRole('listbox').textContent).toBe(
      'Use default · Kimi K3CLIProxyAPIKimi K3Grok 4.7GLM 5.3offlineOllama on this MacLlama 4 Scout',
    );
    // 'unknown' status still routes, so only 'offline' is disabled.
    expect(screen.getByRole('option', { name: /^GLM 5\.3/ }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('option', { name: /^Llama 4 Scout/ }).getAttribute('aria-disabled')).toBeNull();
  });

  test('names the default the task would fall back to', async () => {
    renderPanel({ ...settings({ brainstorm: { effectiveModelId: 'grok' } }), defaults: { default: 'kimi', byTask: { brainstorm: 'grok' } } });

    fireEvent.click(await screen.findByRole('button', { name: 'Text model for Brainstorm, currently Default · Grok 4.7' }));
    expect(screen.getByRole('option', { name: 'Use default · Grok 4.7' })).toBeTruthy();
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

  test('selecting the default clears the pick', async () => {
    renderPanel(settings({ 'ai-fill': { pick: 'grok', effectiveModelId: 'grok', pickState: 'active' } }));
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

    fireEvent.click(await screen.findByRole('button', { name: 'Text model for AI fill, currently Grok 4.7' }));
    fireEvent.click(screen.getByRole('option', { name: 'Use default · Kimi K3' }));

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

  test('an offline pick says the task is using the default', async () => {
    renderPanel(settings({ storytelling: { pick: 'glm', effectiveModelId: 'kimi', pickState: 'offline' } }));

    expect(await screen.findByText('GLM 5.3 is offline right now; Story planner is using the default.')).toBeTruthy();
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
      expect(screen.getByRole('button', { name: 'Text model for Enhance, currently Default · Kimi K3' })).toBeTruthy();
    });
  });

  test('a failed background refetch keeps the rows on screen', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const current = settings({ enhance: { pick: 'grok', effectiveModelId: 'grok', pickState: 'active' } });
    globalThis.fetch = mock((input: RequestInfo | URL) => Response.json(urlOf(input).includes('/text-models') ? current : {})) as unknown as typeof fetch;
    render(<SettingsPanel />, { wrapper: wrapper(client) });
    expect(await screen.findByRole('button', { name: 'Text model for Enhance, currently Grok 4.7' })).toBeTruthy();

    globalThis.fetch = mock(() => Response.json({ error: 'upstream down' }, { status: 502 })) as unknown as typeof fetch;
    await client.refetchQueries({ queryKey: textModelKeys.all() });
    await waitFor(() => { expect(client.getQueryState(textModelKeys.all())?.status).toBe('error'); });

    expect(screen.getByRole('button', { name: 'Text model for Enhance, currently Grok 4.7' })).toBeTruthy();
    expect(screen.queryByText('Couldn’t load the text model settings.')).toBeNull();
  });

  test('a failed first load offers a retry', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    // 400 is not retryable, so the first load fails without backoff.
    globalThis.fetch = mock((input: RequestInfo | URL) => (urlOf(input).includes('/text-models')
      ? Response.json({ error: 'bad request' }, { status: 400 })
      : Response.json({}))) as unknown as typeof fetch;
    render(<SettingsPanel />, { wrapper: wrapper(client) });

    expect(await screen.findByText('Couldn’t load the text model settings.')).toBeTruthy();
    globalThis.fetch = mock((input: RequestInfo | URL) => Response.json(urlOf(input).includes('/text-models') ? settings() : {})) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('button', { name: /^Text model for Enhance/ })).toBeTruthy();
  });
});

describe('SettingsPanel reasoning effort', () => {
  test('stays at the default and disabled without an active pick', async () => {
    renderPanel(settings({ brainstorm: { pick: 'glm', effort: 'high', effectiveModelId: 'kimi', pickState: 'offline' } }));

    const unpicked = await screen.findByRole('button', { name: 'Reasoning effort for AI fill, currently Default effort' });
    expect(unpicked.hasAttribute('disabled')).toBe(true);
    // An offline pick is skipped, so its stored effort is not in use either.
    const offline = screen.getByRole('button', { name: 'Reasoning effort for Brainstorm, currently Default effort' });
    expect(offline.hasAttribute('disabled')).toBe(true);
  });

  test('offers only the levels the picked model accepts and shows the stored one', async () => {
    renderPanel(settings({ enhance: { pick: 'kimi', effort: 'max', effectiveModelId: 'kimi', pickState: 'active' } }));

    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for Enhance, currently Max effort' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Default', 'Low', 'High', 'Max']);
  });

  test('each model offers its own levels', async () => {
    renderPanel(settings({ condense: { pick: 'grok', effectiveModelId: 'grok', pickState: 'active' } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for Krea condense, currently Default effort' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high']);
  });

  test('a fixed-effort model shows text instead of an effort control', async () => {
    renderPanel(settings({ 'list-draft': { pick: 'scout', effectiveModelId: 'scout', pickState: 'active' } }));

    expect(await screen.findByText('Effort fixed by the model')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Reasoning effort for List drafts/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Reasoning effort for / })).toHaveLength(TEXT_TASKS.length - 1);
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
    fireEvent.click(screen.getByRole('option', { name: 'Default' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/text-models/tasks/storytelling',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ modelId: 'grok', effort: null }) }),
      );
    });
  });
});

describe('SettingsPanel save ordering', () => {
  test('locks a row until its save settles so a later choice cannot be overwritten', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    let releasePut: (() => void) | undefined;
    const current = settings({ enhance: { pick: 'kimi', effectiveModelId: 'kimi', pickState: 'active' } });
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      if (!urlOf(input).includes('/text-models')) return Promise.resolve(Response.json({}));
      if (init?.method !== 'PUT') return Promise.resolve(Response.json(current));
      return new Promise<Response>((resolve) => {
        releasePut = () => { resolve(Response.json(current)); };
      });
    }) as unknown as typeof fetch;
    render(<SettingsPanel />, { wrapper: wrapper(client) });

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

describe('PromptManager settings tab', () => {
  test('exposes a fourth tab and switching to it renders the panel', async () => {
    renderManagerOnSettingsTab();

    const tab = await screen.findByRole('tab', { name: 'Settings' });
    expect(tab.getAttribute('aria-controls')).toBe('tabpanel-settings');
    const panel = screen.getByRole('tabpanel', { name: 'Settings' });
    expect(panel.getAttribute('id')).toBe('tabpanel-settings');
    expect(panel.querySelector('[data-zone="head"]')).toBeTruthy();
    expect(panel.querySelector('[data-zone="body"]')).toBeTruthy();
    // The create affordances of the other tabs never appear here.
    expect(screen.queryByRole('button', { name: '+ New' })).toBeNull();
  });
});

const STEPS_MODELS = [
  { modelId: 'krea-2-gonzalomo', name: 'Krea 2 GonzaLomo', defaultSteps: 8, steps: null },
  { modelId: 'moss-image-sft', name: 'MOSS Image', defaultSteps: 50, steps: 30 },
];

function renderSteps(models: readonly unknown[] = STEPS_MODELS, putStatus = 200) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let current = { models, min: 1, max: 100 };
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/text-models')) return Response.json(settings());
    if (url.includes('/settings/model-steps')) {
      if (init?.method === 'PUT') {
        if (putStatus !== 200) return Response.json({ error: 'boom' }, { status: putStatus });
        const modelId = decodeURIComponent(url.split('/').pop() ?? '');
        const { steps } = JSON.parse(init.body as string) as { steps: number | null };
        current = {
          ...current,
          models: (current.models as typeof STEPS_MODELS).map((m) => (m.modelId === modelId
            ? { ...m, steps: steps === m.defaultSteps ? null : steps }
            : m)),
        };
      }
      return Response.json(current);
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  render(<SettingsPanel />, { wrapper: wrapper(client) });
  return globalThis.fetch as unknown as ReturnType<typeof mock>;
}

function inputValue(element: HTMLElement): string {
  if (!(element instanceof HTMLInputElement)) throw new Error('expected an input');
  return element.value;
}

describe('SettingsPanel model steps', () => {
  test('renders each model with its default note and current value', async () => {
    renderSteps();
    expect(await screen.findByText('Model steps')).toBeTruthy();
    expect(screen.getByText('Default 8 steps')).toBeTruthy();
    expect(screen.getByText('Default 50 steps')).toBeTruthy();
    const krea = screen.getByRole('spinbutton', { name: /^Sampling steps for Krea 2 GonzaLomo/ });
    const moss = screen.getByRole('spinbutton', { name: /^Sampling steps for MOSS Image/ });
    expect(inputValue(krea)).toBe('8');
    expect(inputValue(moss)).toBe('30');
    expect(screen.getByRole('button', { name: 'Reset Krea 2 GonzaLomo to 8 steps' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Reset MOSS Image to 50 steps' }).hasAttribute('disabled')).toBe(false);
  });

  test('commits an edit on Enter and on blur', async () => {
    const fetchMock = renderSteps();
    const krea = await screen.findByRole('spinbutton', { name: /^Sampling steps for Krea 2 GonzaLomo/ });
    fireEvent.change(krea, { target: { value: '12' } });
    fireEvent.keyDown(krea, { key: 'Enter' });
    fireEvent.blur(krea);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/settings/model-steps/krea-2-gonzalomo',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ steps: 12 }) }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reset Krea 2 GonzaLomo to 8 steps' }).hasAttribute('disabled')).toBe(false);
    });
  });

  test('invalid or out-of-range input reverts without a request', async () => {
    const fetchMock = renderSteps();
    const krea = await screen.findByRole('spinbutton', { name: /^Sampling steps for Krea 2 GonzaLomo/ });
    for (const value of ['0', '101', '', '7.5']) {
      fireEvent.change(krea, { target: { value } });
      fireEvent.blur(krea);
      expect(inputValue(krea)).toBe('8');
    }
    expect(putCalls(fetchMock)).toHaveLength(0);
  });

  test('Reset sends null', async () => {
    const fetchMock = renderSteps();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset MOSS Image to 50 steps' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/settings/model-steps/moss-image-sft',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ steps: null }) }),
      );
    });
    await waitFor(() => {
      expect(inputValue(screen.getByRole('spinbutton', { name: /^Sampling steps for MOSS Image/ }))).toBe('50');
    });
  });

  test('Reset over a pending edit discards it instead of saving it', async () => {
    const fetchMock = renderSteps();
    const moss = await screen.findByRole('spinbutton', { name: /^Sampling steps for MOSS Image/ });
    moss.focus();
    fireEvent.change(moss, { target: { value: '40' } });
    const reset = screen.getByRole('button', { name: 'Reset MOSS Image to 50 steps' });
    // Prevented mousedown keeps focus in the input, so its blur cannot commit 40 first.
    expect(fireEvent.mouseDown(reset)).toBe(false);
    fireEvent.click(reset);
    await waitFor(() => {
      expect(inputValue(screen.getByRole('spinbutton', { name: /^Sampling steps for MOSS Image/ }))).toBe('50');
    });
    expect(putCalls(fetchMock).map(([, init]) => (init as RequestInit).body)).toEqual([JSON.stringify({ steps: null })]);
  });

  test('a failure still toasts when another row saved meanwhile', async () => {
    renderSteps();
    let failKrea: (() => void) | undefined;
    const steps = { models: STEPS_MODELS, min: 1, max: 100 };
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/text-models')) return Response.json(settings());
      if (init?.method === 'PUT' && url.endsWith('/krea-2-gonzalomo')) {
        return new Promise<Response>((resolve) => {
          failKrea = () => { resolve(Response.json({ error: 'boom' }, { status: 500 })); };
        });
      }
      return Response.json(steps);
    }) as unknown as typeof fetch;
    const krea = await screen.findByRole('spinbutton', { name: /^Sampling steps for Krea 2 GonzaLomo/ });
    fireEvent.change(krea, { target: { value: '20' } });
    fireEvent.blur(krea);
    await waitFor(() => { expect(failKrea).toBeDefined(); });
    const moss = screen.getByRole('spinbutton', { name: /^Sampling steps for MOSS Image/ });
    fireEvent.change(moss, { target: { value: '35' } });
    fireEvent.blur(moss);
    failKrea?.();
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true);
    });
  });

  test('a failed save rolls back and shows an error toast', async () => {
    renderSteps(STEPS_MODELS, 500);
    const krea = await screen.findByRole('spinbutton', { name: /^Sampling steps for Krea 2 GonzaLomo/ });
    fireEvent.change(krea, { target: { value: '20' } });
    fireEvent.blur(krea);
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true);
    });
    await waitFor(() => {
      expect(inputValue(screen.getByRole('spinbutton', { name: /^Sampling steps for Krea 2 GonzaLomo/ }))).toBe('8');
    });
  });

  test('is hidden when the user has no models', async () => {
    renderSteps([]);
    expect(await screen.findByText('Text models')).toBeTruthy();
    await waitFor(() => {
      expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.some(([url]) => String(url).includes('/settings/model-steps'))).toBe(true);
    });
    expect(screen.queryByText('Model steps')).toBeNull();
  });
});
