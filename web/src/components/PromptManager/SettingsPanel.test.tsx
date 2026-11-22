import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type {
  ModelResolutionPutRequest,
  ModelResolutionSetting,
  PublicTextModel,
  TaskRow,
  TextModelsResponse,
} from '@atelier/shared';
import { TEXT_TASKS } from '@atelier/shared';
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
    writers: {}, lockedWriters: [],
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

function renderManagerOnSettingsTab() {
  const onBack = mock(() => undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(promptKeys.library(), emptyLibrary);
  client.setQueryData(textModelKeys.all(), settings());
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    if (urlOf(input).includes('/text-models')) return Response.json(settings());
    // Model steps renders the panel's zones now that no text-model section does.
    if (urlOf(input).includes('/settings/model-steps')) return Response.json({ models: STEPS_MODELS, min: 1, max: 100 });
    return Response.json(emptyLibrary);
  }) as unknown as typeof fetch;
  useAtelierStore.setState({ promptManagerTab: 'settings' as PromptManagerTab });
  return render(<PromptManager onBack={onBack} />, { wrapper: wrapper(client) });
}

// The client of the last renderSteps/renderResolution, so a test can wait
// for its reads to settle before asserting that a section stayed hidden.
let renderedClient: QueryClient | undefined;

async function settled(): Promise<void> {
  await waitFor(() => { expect(renderedClient?.isFetching()).toBe(0); });
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

describe('PromptManager settings tab', () => {
  test('exposes a fourth tab and switching to it renders the panel', async () => {
    renderManagerOnSettingsTab();

    const tab = await screen.findByRole('tab', { name: 'Settings' });
    expect(tab.getAttribute('aria-controls')).toBe('tabpanel-settings');
    const panel = screen.getByRole('tabpanel', { name: 'Settings' });
    expect(panel.getAttribute('id')).toBe('tabpanel-settings');
    await waitFor(() => { expect(panel.querySelector('[data-zone="head"]')).toBeTruthy(); });
    expect(panel.querySelector('[data-zone="body"]')).toBeTruthy();
    // The create affordances of the other tabs never appear here.
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
  });

  test('holds no text-model section; text-model picks live in the Text models view', async () => {
    renderManagerOnSettingsTab();
    const panel = await screen.findByRole('tabpanel', { name: 'Settings' });
    expect(await screen.findByText('Model steps')).toBeTruthy();
    expect(panel.querySelector('[data-zone="body"]')).toBeTruthy();
    expect(screen.queryByText('Your text models')).toBeNull();
    expect(screen.queryByText('Your picks')).toBeNull();
    expect(screen.queryByRole('region', { name: /text model/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Text model for / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reasoning effort for / })).toBeNull();
  });
});

const STEPS_MODELS = [
  { modelId: 'krea-2-gonzalomo', name: 'Krea 2 GonzaLomo', defaultSteps: 8, steps: null },
  { modelId: 'moss-base', name: 'MOSS Base', defaultSteps: 50, steps: 30 },
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
  renderedClient = client;
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
    const moss = screen.getByRole('spinbutton', { name: /^Sampling steps for MOSS Base/ });
    expect(inputValue(krea)).toBe('8');
    expect(inputValue(moss)).toBe('30');
    expect(screen.getByRole('button', { name: 'Reset Krea 2 GonzaLomo to 8 steps' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Reset MOSS Base to 50 steps' }).hasAttribute('disabled')).toBe(false);
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
    fireEvent.click(await screen.findByRole('button', { name: 'Reset MOSS Base to 50 steps' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/settings/model-steps/moss-base',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ steps: null }) }),
      );
    });
    await waitFor(() => {
      expect(inputValue(screen.getByRole('spinbutton', { name: /^Sampling steps for MOSS Base/ }))).toBe('50');
    });
  });

  test('Reset over a pending edit discards it instead of saving it', async () => {
    const fetchMock = renderSteps();
    const moss = await screen.findByRole('spinbutton', { name: /^Sampling steps for MOSS Base/ });
    moss.focus();
    fireEvent.change(moss, { target: { value: '40' } });
    const reset = screen.getByRole('button', { name: 'Reset MOSS Base to 50 steps' });
    // Prevented mousedown keeps focus in the input, so its blur cannot commit 40 first.
    expect(fireEvent.mouseDown(reset)).toBe(false);
    fireEvent.click(reset);
    await waitFor(() => {
      expect(inputValue(screen.getByRole('spinbutton', { name: /^Sampling steps for MOSS Base/ }))).toBe('50');
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
    const moss = screen.getByRole('spinbutton', { name: /^Sampling steps for MOSS Base/ });
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
    await waitFor(() => {
      expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.some(([url]) => String(url).includes('/settings/model-steps'))).toBe(true);
    });
    await settled();
    expect(screen.queryByText('Model steps')).toBeNull();
  });
});

const H3_RESOLUTION: ModelResolutionSetting = {
  modelId: 'minimax-h3-image', name: 'MiniMax H3 Image', defaultTextToImage: '16mp', textToImage: null, defaultReference: '4mp', reference: null,
  outputLongEdge: 2048, downscale: true,
};
const RESOLUTION_MODELS: readonly ModelResolutionSetting[] = [H3_RESOLUTION];
const TEXT_ONLY_RESOLUTION_MODELS: readonly ModelResolutionSetting[] = [
  { modelId: 'text-only', name: 'Text Only', defaultTextToImage: '8mp', textToImage: '4mp', defaultReference: null, reference: null, outputLongEdge: null, downscale: false },
];

function renderResolution(models: readonly ModelResolutionSetting[] = RESOLUTION_MODELS, putStatus = 200) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let current = { options: ['4mp', '8mp', '16mp'], models };
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.includes('/text-models')) return Response.json(settings());
    if (url.includes('/settings/model-resolution')) {
      if (init?.method === 'PUT') {
        if (putStatus !== 200) return Response.json({ error: 'boom' }, { status: putStatus });
        const modelId = decodeURIComponent(url.split('/').pop() ?? '');
        const body = JSON.parse(init.body as string) as ModelResolutionPutRequest;
        current = {
          ...current,
          models: current.models.map((m) => (m.modelId === modelId
            ? {
                ...m,
                ...(body.textToImage !== undefined ? { textToImage: body.textToImage === m.defaultTextToImage ? null : body.textToImage } : {}),
                ...(body.reference !== undefined ? { reference: body.reference === m.defaultReference ? null : body.reference } : {}),
                ...(body.downscale !== undefined ? { downscale: body.downscale } : {}),
              }
            : m)),
        };
      }
      return Response.json(current);
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  renderedClient = client;
  render(<SettingsPanel />, { wrapper: wrapper(client) });
  return globalThis.fetch as unknown as ReturnType<typeof mock>;
}

function resolutionPuts(fetchMock: ReturnType<typeof mock>): unknown[] {
  return putCalls(fetchMock).map(([, init]) => JSON.parse((init as RequestInit).body as string) as unknown);
}

describe('SettingsPanel render resolution', () => {
  test('renders both mode controls with their defaults marked and Reset disabled', async () => {
    renderResolution();
    const heading = await screen.findByRole('heading', { name: 'Render resolution' });
    // No secondary line under the heading.
    expect(heading.nextElementSibling).toBeNull();
    expect(screen.getByText('MiniMax H3 Image')).toBeTruthy();
    expect(screen.getByText('Text to image')).toBeTruthy();
    expect(screen.getByText('With reference pictures')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Text to image resolution for MiniMax H3 Image, currently 16 MP (default)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'With reference pictures resolution for MiniMax H3 Image, currently 4 MP (default)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset MiniMax H3 Image to its default resolutions' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /^Text to image resolution for MiniMax H3 Image/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['4 MP', '8 MP', '16 MP (default)']);
  });

  test('choosing a text-to-image size saves only that mode', async () => {
    const fetchMock = renderResolution();
    fireEvent.click(await screen.findByRole('button', { name: /^Text to image resolution for MiniMax H3 Image/ }));
    fireEvent.click(screen.getByRole('option', { name: '8 MP' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/settings/model-resolution/minimax-h3-image',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ textToImage: '8mp' }) }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Text to image resolution for MiniMax H3 Image, currently 8 MP' })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Reset MiniMax H3 Image to its default resolutions' }).hasAttribute('disabled')).toBe(false);
  });

  test('choosing a reference size saves only that mode, and the default saves null', async () => {
    const fetchMock = renderResolution();
    fireEvent.click(await screen.findByRole('button', { name: /^With reference pictures resolution/ }));
    fireEvent.click(screen.getByRole('option', { name: '16 MP' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'With reference pictures resolution for MiniMax H3 Image, currently 16 MP' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /^With reference pictures resolution/ }));
    fireEvent.click(screen.getByRole('option', { name: '4 MP (default)' }));
    await waitFor(() => {
      expect(resolutionPuts(fetchMock)).toEqual([{ reference: '16mp' }, { reference: null }]);
    });
  });

  test('Reset clears both modes and turns downsizing back on', async () => {
    const fetchMock = renderResolution([{ ...H3_RESOLUTION, textToImage: '8mp', reference: '16mp', downscale: false }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset MiniMax H3 Image to its default resolutions' }));
    await waitFor(() => {
      expect(resolutionPuts(fetchMock)).toEqual([{ textToImage: null, reference: null, downscale: true }]);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Downsize MiniMax H3 Image to 2K' }).getAttribute('aria-checked')).toBe('true');
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reset MiniMax H3 Image to its default resolutions' }).hasAttribute('disabled')).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'Text to image resolution for MiniMax H3 Image, currently 16 MP (default)' })).toBeTruthy();
  });

  test('a failed save rolls back and shows an error toast', async () => {
    renderResolution(RESOLUTION_MODELS, 500);
    fireEvent.click(await screen.findByRole('button', { name: /^Text to image resolution for MiniMax H3 Image/ }));
    fireEvent.click(screen.getByRole('option', { name: '4 MP' }));
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Text to image resolution for MiniMax H3 Image, currently 16 MP (default)' })).toBeTruthy();
    });
  });

  test('a row without reference pictures hides that control and resets only text to image', async () => {
    const fetchMock = renderResolution(TEXT_ONLY_RESOLUTION_MODELS);
    expect(await screen.findByRole('button', { name: 'Text to image resolution for Text Only, currently 4 MP' })).toBeTruthy();
    expect(screen.queryByText('With reference pictures')).toBeNull();
    expect(screen.queryByRole('button', { name: /^With reference pictures resolution/ })).toBeNull();
    // It delivers at render size: no "Downsize to 2K" switch.
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText(/^Downsize to/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Text Only to its default resolutions' }));
    await waitFor(() => {
      expect(resolutionPuts(fetchMock)).toEqual([{ textToImage: null }]);
    });
  });

  test('the "Downsize to 2K" switch is on by default and turning it off saves only it', async () => {
    const fetchMock = renderResolution();
    const toggle = await screen.findByRole('switch', { name: 'Downsize MiniMax H3 Image to 2K' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Downsize to 2K')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(resolutionPuts(fetchMock)).toEqual([{ downscale: false }]);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Downsize MiniMax H3 Image to 2K' }).getAttribute('aria-checked')).toBe('false');
    });
    // Off is not the default, so Reset becomes available.
    expect(screen.getByRole('button', { name: 'Reset MiniMax H3 Image to its default resolutions' }).hasAttribute('disabled')).toBe(false);
  });

  test('a failed switch save rolls back and shows an error toast', async () => {
    renderResolution(RESOLUTION_MODELS, 500);
    fireEvent.click(await screen.findByRole('switch', { name: 'Downsize MiniMax H3 Image to 2K' }));
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Downsize MiniMax H3 Image to 2K' }).getAttribute('aria-checked')).toBe('true');
    });
  });

  test('another delivered long edge is labelled in pixels', async () => {
    renderResolution([{ ...H3_RESOLUTION, outputLongEdge: 1536 }]);
    expect(await screen.findByRole('switch', { name: 'Downsize MiniMax H3 Image to 1536 px' })).toBeTruthy();
    expect(screen.getByText('Downsize to 1536 px')).toBeTruthy();
  });

  test('is hidden when the endpoint lists no models', async () => {
    renderResolution([]);
    await waitFor(() => {
      expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.some(([url]) => String(url).includes('/settings/model-resolution'))).toBe(true);
    });
    await settled();
    expect(screen.queryByText('Render resolution')).toBeNull();
  });
});

function renderCondense(initial: { available: boolean; enabled: boolean }, putStatus = 200) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  let current = initial;
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.includes('/settings/prompt-condense')) {
      if (init?.method === 'PUT') {
        if (putStatus !== 200) return Response.json({ error: 'boom' }, { status: putStatus });
        current = { ...current, ...(JSON.parse(init.body as string) as { enabled: boolean }) };
      }
      return Response.json(current);
    }
    if (url.includes('/settings/')) return Response.json({ models: [], options: [], min: 1, max: 100 });
    return Response.json({});
  }) as unknown as typeof fetch;
  renderedClient = client;
  render(<SettingsPanel />, { wrapper: wrapper(client) });
  return globalThis.fetch as unknown as ReturnType<typeof mock>;
}

describe('SettingsPanel prompt condensing', () => {
  test('the switch is on by default and turning it off saves enabled false', async () => {
    const fetchMock = renderCondense({ available: true, enabled: true });
    const heading = await screen.findByRole('heading', { name: 'Prompt condensing' });
    expect(heading.nextElementSibling).toBeNull();
    const toggle = screen.getByRole('switch', { name: 'Condense long prompts' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/settings/prompt-condense',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: false }) }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Condense long prompts' }).getAttribute('aria-checked')).toBe('false');
    });
  });

  test('a failed save rolls back and shows an error toast', async () => {
    renderCondense({ available: true, enabled: true }, 500);
    fireEvent.click(await screen.findByRole('switch', { name: 'Condense long prompts' }));
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts.some((toast) => toast.tone === 'error')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Condense long prompts' }).getAttribute('aria-checked')).toBe('true');
    });
  });

  test('is hidden for a user without a Krea row', async () => {
    renderCondense({ available: false, enabled: true });
    await waitFor(() => {
      expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.some(([url]) => String(url).includes('/settings/prompt-condense'))).toBe(true);
    });
    await settled();
    expect(screen.queryByText('Prompt condensing')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
