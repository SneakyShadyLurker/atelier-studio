import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { promptKeys } from '../../api/prompts';
import { textBackendKeys } from '../../api/textBackends';
import { useAtelierStore, type PromptManagerTab } from '../../store/atelier';
import PromptManager from './index';
import SettingsPanel from './SettingsPanel';

const emptyLibrary = { templates: [], variableLists: [], dimensions: [] };

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderPanel(
  overrides: Record<string, unknown> = {},
  unavailable: readonly string[] = [],
  efforts: Record<string, unknown> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/prompts/settings/text-backends')) {
      return Response.json({ overrides, efforts, unavailable });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  return render(<SettingsPanel />, { wrapper: wrapper(client) });
}

function renderManagerOnSettingsTab() {
  const onBack = mock(() => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(promptKeys.library(), emptyLibrary);
  client.setQueryData(textBackendKeys.all(), { overrides: {}, efforts: {}, unavailable: [] });
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/prompts/settings/text-backends')) return Response.json({ overrides: {}, efforts: {}, unavailable: [] });
    return Response.json(emptyLibrary);
  }) as unknown as typeof fetch;
  useAtelierStore.setState({ promptManagerTab: 'settings' as PromptManagerTab });
  return render(<PromptManager onBack={onBack} />, { wrapper: wrapper(client) });
}

afterEach(() => {
  cleanup();
  mock.restore();
  window.localStorage.clear();
  useAtelierStore.setState({ promptManagerTab: 'templates', toasts: [] });
});

describe('SettingsPanel', () => {
  test('omits GPT from every workload because GPT image text routing is automatic', async () => {
    for (const label of ['Ai-fill', 'Brainstorm', 'Enhance', 'Krea condense', 'Storytelling planner']) {
      const panel = renderPanel();
      fireEvent.click(await screen.findByRole('button', { name: `Text backend for ${label}, currently Auto (default)` }));
      expect(screen.queryByRole('option', { name: /^GPT-6.1 Sol/ })).toBeNull();
      panel.unmount();
    }
  });

  test('renders a row per workload with the auto default', async () => {
    renderPanel();

    for (const label of ['Ai-fill', 'Brainstorm', 'Enhance', 'Krea condense', 'Storytelling planner']) {
      expect(await screen.findByText(label)).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { name: /Text backend for/ })).toHaveLength(5);
    expect(screen.getAllByRole('button', { name: /Text backend for .*currently Auto \(default\)$/ })).toHaveLength(5);
  });

  test('reflects fetched overrides and treats legacy GPT preferences as Auto', async () => {
    renderPanel({ 'ai-fill': 'deepseek-abliterated', condense: 'kimi', brainstorm: 'gpt' });

    expect(await screen.findByRole('button', { name: 'Text backend for Ai-fill, currently DeepSeek V4.1 Flash Abliterated' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Text backend for Krea condense, currently Kimi K3' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Text backend for Brainstorm, currently Auto (default)' })).toBeTruthy();
  });

  test('selecting a backend fires the mutation with the workload and backend', async () => {
    renderPanel();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

    fireEvent.click(await screen.findByRole('button', { name: 'Text backend for Brainstorm, currently Auto (default)' }));
    fireEvent.click(screen.getByRole('option', { name: /^Kimi K3/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/prompts/settings/text-backends/brainstorm',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ backend: 'kimi' }),
        }),
      );
    });
  });

  test("selecting 'Auto (default)' sends a null backend to clear the override", async () => {
    renderPanel({ 'ai-fill': 'mimo' });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

    fireEvent.click(await screen.findByRole('button', { name: 'Text backend for Ai-fill, currently MiMo V2.6 Pro' }));
    fireEvent.click(screen.getByRole('option', { name: /Auto \(default\)/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/prompts/settings/text-backends/ai-fill',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ backend: null }),
        }),
      );
    });
  });

  test('available options carry no hint', async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Text backend for Enhance, currently Auto (default)' }));
    expect(screen.getByRole('option', { name: /^Auto \(default\)$/ })).toBeTruthy();
    for (const label of ['Kimi K3', 'MiMo V2\\.6 Pro', 'Grok 4\\.7', 'Gemini 4 Argon', 'DeepSeek V4\\.1 Flash Abliterated', 'GLM 5\\.3 Abliterated']) {
      expect(screen.getByRole('option', { name: new RegExp(`^${label}$`) })).toBeTruthy();
    }
    expect(screen.queryByRole('option', { name: /^GPT-6.1 Sol/ })).toBeNull();
  });

  test('every workload row offers every selectable backend', async () => {
    for (const label of ['Ai-fill', 'Brainstorm', 'Enhance', 'Krea condense', 'Storytelling planner']) {
      const view = renderPanel();
      fireEvent.click(await screen.findByRole('button', { name: `Text backend for ${label}, currently Auto (default)` }));
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Auto (default)',
        'Kimi K3',
        'MiMo V2.6 Pro',
        'Grok 4.7',
        'Gemini 4 Argon',
        'DeepSeek V4.1 Flash Abliterated',
        'GLM 5.3 Abliterated',
      ]);
      view.unmount();
    }
  });

  test('selecting Grok fires the mutation with the grok key', async () => {
    renderPanel();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

    fireEvent.click(await screen.findByRole('button', { name: 'Text backend for Enhance, currently Auto (default)' }));
    fireEvent.click(screen.getByRole('option', { name: /^Grok 4\.7/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/prompts/settings/text-backends/enhance',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ backend: 'grok' }),
        }),
      );
    });
  });

  test('selecting Gemini 4 Argon fires the mutation with the gemini-argon key', async () => {
    renderPanel();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

    fireEvent.click(await screen.findByRole('button', { name: 'Text backend for Ai-fill, currently Auto (default)' }));
    fireEvent.click(screen.getByRole('option', { name: /^Gemini 4 Argon/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/prompts/settings/text-backends/ai-fill',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ backend: 'gemini-argon' }),
        }),
      );
    });
  });

  test('selecting GLM 5.3 Abliterated fires the mutation with the glm-abliterated key', async () => {
    renderPanel();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

    fireEvent.click(await screen.findByRole('button', { name: 'Text backend for Ai-fill, currently Auto (default)' }));
    fireEvent.click(screen.getByRole('option', { name: /^GLM 5\.3 Abliterated/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/prompts/settings/text-backends/ai-fill',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ backend: 'glm-abliterated' }),
        }),
      );
    });
  });

  test('selecting DeepSeek V4.1 Flash Abliterated fires the mutation with the deepseek-abliterated key', async () => {
    renderPanel();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

    fireEvent.click(await screen.findByRole('button', { name: 'Text backend for Krea condense, currently Auto (default)' }));
    fireEvent.click(screen.getByRole('option', { name: /^DeepSeek V4\.1 Flash Abliterated/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/prompts/settings/text-backends/condense',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ backend: 'deepseek-abliterated' }),
        }),
      );
    });
  });

  test('an unavailable backend is a disabled option that does not mutate', async () => {
    renderPanel({}, ['glm-abliterated']);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

    fireEvent.click(await screen.findByRole('button', { name: 'Text backend for Ai-fill, currently Auto (default)' }));
    const option = screen.getByRole('option', { name: /^GLM 5\.3 Abliterated unavailable$/ });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('option', { name: /^Kimi K3$/ }).getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(option);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(false);
  });

  test('a failed background refetch keeps the rows on screen', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    globalThis.fetch = mock(() => Response.json({ overrides: { enhance: 'grok' }, efforts: {}, unavailable: [] })) as unknown as typeof fetch;
    render(<SettingsPanel />, { wrapper: wrapper(client) });
    expect(await screen.findByRole('button', { name: 'Text backend for Enhance, currently Grok 4.7' })).toBeTruthy();

    globalThis.fetch = mock(() => Response.json({ error: 'upstream down' }, { status: 502 })) as unknown as typeof fetch;
    await client.refetchQueries({ queryKey: textBackendKeys.all() });
    await waitFor(() => { expect(client.getQueryState(textBackendKeys.all())?.status).toBe('error'); });

    expect(screen.getByRole('button', { name: 'Text backend for Enhance, currently Grok 4.7' })).toBeTruthy();
    expect(screen.queryByText('Couldn’t load the text backend settings.')).toBeNull();
  });

  test('a backend key this bundle does not know shows as Auto instead of breaking the panel', async () => {
    renderPanel({ enhance: 'future-backend' }, [], { enhance: 'high' });

    expect(await screen.findByRole('button', { name: 'Text backend for Enhance, currently Auto (default)' })).toBeTruthy();
    const effort = screen.getByRole('button', { name: 'Reasoning effort for Enhance, currently Default effort' });
    expect(effort.hasAttribute('disabled')).toBe(true);
  });

  test('an unavailable saved pin says so and that Auto is in use', async () => {
    renderPanel({ brainstorm: 'glm-abliterated' }, ['glm-abliterated']);

    expect(await screen.findByRole('button', {
      name: 'Text backend for Brainstorm, currently GLM 5.3 Abliterated unavailable · using Auto',
    })).toBeTruthy();
  });
});

describe('SettingsPanel reasoning effort', () => {
  test('stays at the default and disabled until a routable model is pinned', async () => {
    renderPanel({ brainstorm: 'deepseek-abliterated' }, ['deepseek-abliterated'], { brainstorm: 'high' });

    const auto = await screen.findByRole('button', { name: 'Reasoning effort for Ai-fill, currently Default effort' });
    expect(auto.hasAttribute('disabled')).toBe(true);
    // An unavailable pin routes as Auto, so its stored effort is not in use either.
    const unavailable = screen.getByRole('button', { name: 'Reasoning effort for Brainstorm, currently Default effort' });
    expect(unavailable.hasAttribute('disabled')).toBe(true);
  });

  test('offers only the efforts the pinned backend accepts and shows the stored one', async () => {
    renderPanel({ enhance: 'glm-abliterated', condense: 'kimi' }, [], { enhance: 'max' });

    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for Enhance, currently Max effort' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Default', 'Low', 'High', 'Max',
    ]);
  });

  test('each chat backend offers exactly the efforts its catalog lists', async () => {
    const expected = {
      kimi: ['Default', 'Low', 'High', 'Max'],
      mimo: ['Default', 'None', 'High'],
      grok: ['Default', 'Low', 'Medium', 'High', 'Extra high'],
      'gemini-argon': ['Default', 'Low', 'Medium', 'High'],
      'deepseek-abliterated': ['Default', 'None', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'],
    } as const;
    for (const [backend, options] of Object.entries(expected)) {
      const view = renderPanel({ condense: backend });
      fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for Krea condense, currently Default effort' }));
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([...options]);
      view.unmount();
    }
  });

  test('selecting an effort saves it with the pinned backend; Default sends null', async () => {
    renderPanel({ storytelling: 'deepseek-abliterated' }, [], { storytelling: 'low' });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof mock>;

    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for Storytelling planner, currently Low effort' }));
    fireEvent.click(screen.getByRole('option', { name: 'Max' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/prompts/settings/text-backends/storytelling',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ backend: 'deepseek-abliterated', effort: 'max' }) }),
      );
    });

    fireEvent.click(await screen.findByRole('button', { name: /^Reasoning effort for Storytelling planner/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Default' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/prompts/settings/text-backends/storytelling',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ backend: 'deepseek-abliterated', effort: null }) }),
      );
    });
  });
});

describe('SettingsPanel save ordering', () => {
  test('locks a row until its save settles so a later choice cannot be overwritten', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    let releasePut: (() => void) | undefined;
    const settings = { overrides: { enhance: 'kimi' }, efforts: {}, unavailable: [] };
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return Promise.resolve(Response.json(settings));
      return new Promise<Response>((resolve) => {
        releasePut = () => { resolve(Response.json({ ...settings, efforts: { enhance: 'max' } })); };
      });
    }) as unknown as typeof fetch;
    render(<SettingsPanel />, { wrapper: wrapper(client) });

    fireEvent.click(await screen.findByRole('button', { name: 'Reasoning effort for Enhance, currently Default effort' }));
    fireEvent.click(screen.getByRole('option', { name: 'Max' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Text backend for Enhance/ }).hasAttribute('disabled')).toBe(true);
    });
    expect(screen.getByRole('button', { name: /^Reasoning effort for Enhance/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /^Text backend for Ai-fill/ }).hasAttribute('disabled')).toBe(false);

    releasePut?.();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Text backend for Enhance/ }).hasAttribute('disabled')).toBe(false);
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
    if (url.includes('/prompts/settings/text-backends')) return Response.json({ overrides: {}, efforts: {}, unavailable: [] });
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

function putCalls(fetchMock: ReturnType<typeof mock>) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
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
    const settings = { models: STEPS_MODELS, min: 1, max: 100 };
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/prompts/settings/text-backends')) return Response.json({ overrides: {}, efforts: {}, unavailable: [] });
      if (init?.method === 'PUT' && url.endsWith('/krea-2-gonzalomo')) {
        return new Promise<Response>((resolve) => {
          failKrea = () => { resolve(Response.json({ error: 'boom' }, { status: 500 })); };
        });
      }
      return Response.json(settings);
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
    expect(await screen.findByText('Text backends')).toBeTruthy();
    await waitFor(() => {
      expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.some(([url]) => String(url).includes('/settings/model-steps'))).toBe(true);
    });
    expect(screen.queryByText('Model steps')).toBeNull();
  });
});
