import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { AdminProvider, Model, TextRoutingResponse } from '@atelier/shared';
import { textAdminKeys } from '../../api/textProviders';
import { textModelKeys } from '../../api/textModels';
import {
  useDeleteModel,
  useSetRoutingDefault,
  useTextProviders,
  useUpdateModel,
} from '../../hooks/useTextProviders';
import { APP_VIEW_TEXT_MODELS, APP_VIEW_UNSORTED, useAtelierStore } from '../../store/atelier';
import Sidebar from '../Sidebar';
import { GLM, KIMI, PROVIDERS, ROUTING } from './fixtures';
import TextModels from './index';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapper(client: QueryClient) {
  return function TestWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** Routes fetch by path; records every call. */
function installFetch(options: {
  providers?: readonly AdminProvider[] | 404;
  routing?: TextRoutingResponse;
} = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url, body });
    if (url.endsWith('/api/text-providers') && method === 'GET') {
      if (options.providers === 404) return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json({ providers: options.providers ?? PROVIDERS });
    }
    if (url.includes('/api/text-routing')) return Response.json(options.routing ?? ROUTING);
    if (url.includes('/api/text-models')) return Response.json({ models: [], tasks: [], defaults: { byTask: {} }, writers: {} });
    if (method === 'POST' && url.endsWith('/test')) return Response.json({ checks: [], proposed: {}, advertised: {}, wireNotes: [] });
    if (method === 'DELETE') return Response.json({ ok: true });
    if (method === 'PATCH') return Response.json({});
    return Response.json({});
  }) as unknown as typeof fetch;
  return calls;
}

function renderView(options: Parameters<typeof installFetch>[0] = {}) {
  const calls = installFetch(options);
  const client = newClient();
  const onBack = mock(() => undefined);
  const view = render(<TextModels onBack={onBack} />, { wrapper: wrapper(client) });
  return { ...view, calls, client, onBack };
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ toasts: [], view: APP_VIEW_UNSORTED });
});

describe('Text models gating', () => {
  test('a 404 from the admin route reads as gated, not as an error', async () => {
    installFetch({ providers: 404 });
    const { result } = renderHook(() => useTextProviders(), { wrapper: wrapper(newClient()) });
    await waitFor(() => { expect(result.current.gated).toBe(true); });
    expect(result.current.enabled).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  test('an admin is enabled', async () => {
    installFetch();
    const { result } = renderHook(() => useTextProviders(), { wrapper: wrapper(newClient()) });
    await waitFor(() => { expect(result.current.enabled).toBe(true); });
  });

  test('the sidebar shows the labelled Text models row only to admins', () => {
    const models: readonly Model[] = [];
    const onSelectView = mock();
    const props = {
      history: { items: [], nextCursor: null },
      models,
      activeBatchId: null,
      historyQ: '',
      archivedCount: 0,
      onSelect: mock(),
      onSelectView,
      onClear: mock(),
    };
    installFetch();
    const { rerender } = render(<Sidebar {...props} />, { wrapper: wrapper(newClient()) });
    expect(screen.queryByRole('button', { name: 'Text models' })).toBeNull();

    rerender(<Sidebar {...props} promptsEnabled textModelsEnabled />);
    const button = screen.getByRole('button', { name: 'Text models' });
    // A labelled rail row directly after Prompt Library, not a footer icon.
    expect(button.textContent).toBe('Text models');
    expect(button.closest('footer')).toBeNull();
    expect(button.previousElementSibling).toBe(screen.getByRole('button', { name: 'Prompt Library' }));
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-current')).toBeNull();
    const footer = screen.getByRole('button', { name: 'API keys' }).closest('footer');
    if (!footer) throw new Error('expected the sidebar footer');
    expect(within(footer).queryByRole('button', { name: 'Text models' })).toBeNull();
    fireEvent.click(button);
    expect(onSelectView).toHaveBeenCalledWith(APP_VIEW_TEXT_MODELS);
  });

  test('the Text models row marks itself current in the Text models view', () => {
    useAtelierStore.setState({ view: APP_VIEW_TEXT_MODELS });
    installFetch();
    render(
      <Sidebar
        history={{ items: [], nextCursor: null }}
        models={[]}
        activeBatchId={null}
        historyQ=""
        archivedCount={0}
        onSelect={mock()}
        onSelectView={mock()}
        onClear={mock()}
        textModelsEnabled
      />,
      { wrapper: wrapper(newClient()) },
    );
    const button = screen.getByRole('button', { name: 'Text models' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-current')).toBe('page');
  });
});

describe('Text models view', () => {
  test('first run: serif empty state with one action and the guide link', async () => {
    renderView({ providers: [] });

    expect(await screen.findByRole('heading', { name: 'No text model yet' })).toBeTruthy();
    expect(screen.getByText(/Connect a provider such as Ollama, LM Studio, OpenAI, Anthropic or OpenRouter/)).toBeTruthy();
    const guide = screen.getByRole('link', { name: 'Read the guide' });
    expect(guide.getAttribute('href')).toContain('docs/connect-a-text-model.md');
    expect(guide.getAttribute('rel')).toContain('noopener');
    // Header action plus the empty state's single action.
    expect(screen.getAllByRole('button', { name: 'Add provider' })).toHaveLength(2);
    expect(screen.queryByRole('region', { name: 'Routing' })).toBeNull();
  });

  test('Add provider opens the dialog slot (Task 15 plugs the form in)', async () => {
    renderView({ providers: [] });
    const [headerAction] = await screen.findAllByRole('button', { name: 'Add provider' });
    if (!headerAction) throw new Error('missing Add provider');
    fireEvent.click(headerAction);
    expect(await screen.findByRole('dialog', { name: 'Add a provider' })).toBeTruthy();
  });

  test('uses the managed-view header and fixed zones', async () => {
    const { container, onBack } = renderView();
    await screen.findByRole('region', { name: 'CLIProxyAPI' });
    expect(screen.getByText('TEXT MODELS')).toBeTruthy();
    expect(container.querySelector('[data-zone="head"]')?.textContent).toContain('TEXT MODELS');
    const body = container.querySelector('[data-zone="body"]');
    expect(body?.textContent).toContain('Kimi K3');
    fireEvent.click(screen.getByRole('button', { name: 'Back to feed' }));
    expect(onBack).toHaveBeenCalled();
  });

  test('provider sections show protocol, base URL, auth summary and warnings in plain words', async () => {
    renderView();
    const cli = await screen.findByRole('region', { name: 'CLIProxyAPI' });
    expect(within(cli).getByText('OpenAI-compatible')).toBeTruthy();
    expect(within(cli).getByText('http://127.0.0.1:8317/v1')).toBeTruthy();
    expect(cli.textContent).toContain('key from CLIPROXY_TOKEN');

    const ollama = screen.getByRole('region', { name: 'Ollama on this Mac' });
    expect(within(ollama).getByText('no key')).toBeTruthy();

    const openai = screen.getByRole('region', { name: 'OpenAI' });
    expect(openai.textContent).toContain('key ••••ab12');
    expect(openai.textContent).toContain('BYOK_ENCRYPTION_KEY');
    expect(within(openai).getByText('No models yet.')).toBeTruthy();
  });

  test('model rows: name, upstream id, capability icons, status dot and word', async () => {
    renderView();
    const kimi = await screen.findByRole('listitem', { name: 'Kimi K3' });
    expect(within(kimi).getByText('kimi-latest')).toBeTruthy();
    for (const label of ['Image input', 'JSON output', 'Reasoning: Low, High, Max']) {
      const mark = within(kimi).getByLabelText(label);
      expect(mark.getAttribute('data-tip')).toBe(label);
    }
    expect(within(kimi).getByText('available')).toBeTruthy();
    expect(within(kimi).queryByRole('button', { name: /Check again/ })).toBeNull();

    const glm = screen.getByRole('listitem', { name: 'GLM 5.3' });
    expect(within(glm).queryByLabelText('Image input')).toBeNull();
    expect(within(glm).getByText('offline')).toBeTruthy();

    const scout = screen.getByRole('listitem', { name: 'Llama 4 Scout' });
    expect(within(scout).getByText('unknown')).toBeTruthy();
    expect(within(scout).queryByLabelText('JSON output')).toBeNull();
  });

  test('"Check again" is one provider action, shown while a model is not available', async () => {
    const { calls } = renderView();
    const cli = await screen.findByRole('region', { name: 'CLIProxyAPI' });
    const glm = within(cli).getByRole('listitem', { name: 'GLM 5.3' });
    expect(within(glm).queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(within(cli).getAllByRole('button', { name: 'Check again' })).toHaveLength(1);
    fireEvent.click(within(cli).getByRole('button', { name: 'Check again' }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/api/text-providers/p-cli/refresh'))).toBe(true);
    });
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  test('a provider whose models are all available offers no re-check', async () => {
    const [cli] = PROVIDERS;
    if (!cli) throw new Error('fixture missing');
    renderView({ providers: [{ ...cli, models: [KIMI] }] });
    const section = await screen.findByRole('region', { name: 'CLIProxyAPI' });
    expect(within(section).queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(section.textContent).toContain('1 of 1 on');
  });

  test('a model routing depends on carries a tag naming its role', async () => {
    renderView();
    const kimi = await screen.findByRole('listitem', { name: 'Kimi K3' });
    const tag = within(kimi).getByText('Default');
    // The image model's label arrives with the routing query.
    await waitFor(() => {
      expect(tag.getAttribute('data-tip')).toBe(
        'The default model, assigned to AI fill, the prompt writer for GPT Image 2.5 Sunburst, and picked by 3 people',
      );
    });
    expect(tag.textContent).toContain(': The default model');
    expect(within(screen.getByRole('listitem', { name: 'GLM 5.3' })).queryByText(/^(Default|In use)/)).toBeNull();
  });

  test('provider inventory comes before routing', async () => {
    const { container } = renderView();
    const routing = await screen.findByRole('region', { name: 'Routing' });
    const cli = screen.getByRole('region', { name: 'CLIProxyAPI' });
    expect(cli.compareDocumentPosition(routing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('[data-zone="body"]')?.contains(routing)).toBe(true);
  });

  test('a provider with every model offline says so', async () => {
    const [cli] = PROVIDERS;
    if (!cli) throw new Error('fixture missing');
    renderView({ providers: [{ ...cli, models: [GLM] }] });
    const section = await screen.findByRole('region', { name: 'CLIProxyAPI' });
    expect(section.textContent).toContain('Nothing listed at http://127.0.0.1:8317/v1. Check that the server is running.');
  });

  test('the enable switch turns a model off', async () => {
    const { calls } = renderView();
    const kimi = await screen.findByRole('listitem', { name: 'Kimi K3' });
    const toggle = within(kimi).getByRole('switch', { name: 'Use Kimi K3' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PATCH' && call.url.endsWith('/api/text-providers/p-cli/models/m-kimi'))).toBe(true);
    });
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ enabled: false });
  });

  test('More menu: Edit opens the model, Test opens it and starts the test, Remove confirms with usage', async () => {
    const { calls } = renderView();
    const kimi = await screen.findByRole('listitem', { name: 'Kimi K3' });

    fireEvent.click(within(kimi).getByRole('button', { name: 'More actions for Kimi K3' }));
    const menu = await screen.findByRole('menu', { name: 'Kimi K3 actions' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Edit', 'Test', 'Remove']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Edit' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit model' });
    expect(within(edit).getByLabelText<HTMLInputElement>('Display name').value).toBe('Kimi K3');
    fireEvent.click(within(edit).getByRole('button', { name: 'Cancel' }));
    // The exit transition unmounts on a timer, which waitFor can miss.
    await act(() => Bun.sleep(300));
    expect(screen.queryByRole('dialog', { name: 'Edit model' })).toBeNull();
    expect(calls.some((call) => call.url.endsWith('/test'))).toBe(false);

    fireEvent.click(within(kimi).getByRole('button', { name: 'More actions for Kimi K3' }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Test' }));
    expect(await screen.findByRole('dialog', { name: 'Edit model' })).toBeTruthy();
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/api/text-providers/p-cli/models/m-kimi/test'))).toBe(true);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(() => Bun.sleep(300));

    fireEvent.click(within(kimi).getByRole('button', { name: 'More actions for Kimi K3' }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Remove' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Kimi K3?' });
    expect(confirm.textContent).toContain(
      'It is the default model, assigned to AI fill, the prompt writer for GPT Image 2.5 Sunburst, and picked by 3 people. Those will fall back to the next model in line.',
    );
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove model' }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/api/text-providers/p-cli/models/m-kimi'))).toBe(true);
    });
  });

  test('Add models opens the picker for that provider', async () => {
    renderView();
    const ollama = await screen.findByRole('region', { name: 'Ollama on this Mac' });
    fireEvent.click(within(ollama).getByRole('button', { name: 'Add models' }));
    expect(await screen.findByRole('dialog', { name: 'Add models from Ollama on this Mac' })).toBeTruthy();
  });

  test('an untested model says so quietly and offers the test', async () => {
    const { calls } = renderView();
    const glm = await screen.findByRole('listitem', { name: 'GLM 5.3' });
    const untested = within(glm).getByRole('button', { name: 'Untested: test to confirm capabilities' });
    expect(untested.getAttribute('data-tip')).toBe('Test to confirm capabilities');
    expect(within(screen.getByRole('listitem', { name: 'Kimi K3' })).queryByText('Untested')).toBeNull();
    fireEvent.click(untested);
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/api/text-providers/p-cli/models/m-glm/test'))).toBe(true);
    });
  });

  test('removing an unused model says nothing depends on it', async () => {
    renderView();
    const glm = await screen.findByRole('listitem', { name: 'GLM 5.3' });
    fireEvent.click(within(glm).getByRole('button', { name: 'More actions for GLM 5.3' }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Remove' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove GLM 5.3?' });
    expect(confirm.textContent).toContain('Nothing uses it right now.');
  });
});

describe('admin writes refresh the admin view and the user picker', () => {
  function setup() {
    installFetch();
    const client = newClient();
    client.setQueryData(textAdminKeys.providers(), { providers: PROVIDERS });
    client.setQueryData(textAdminKeys.routing(), ROUTING);
    client.setQueryData(textModelKeys.all(), { models: [], tasks: [], defaults: { byTask: {} }, writers: {} });
    return client;
  }

  async function expectBothInvalidated(client: QueryClient) {
    await waitFor(() => {
      expect(client.getQueryState(textModelKeys.all())?.isInvalidated).toBe(true);
    });
    expect(client.getQueryState(textAdminKeys.providers())?.isInvalidated).toBe(true);
    expect(client.getQueryState(textAdminKeys.routing())?.isInvalidated).toBe(true);
  }

  test('rename', async () => {
    const client = setup();
    const { result } = renderHook(() => useUpdateModel(), { wrapper: wrapper(client) });
    await act(() => result.current.mutateAsync({ providerId: 'p-cli', modelId: KIMI.id, patch: { displayName: 'Kimi' } }));
    await expectBothInvalidated(client);
  });

  test('disable', async () => {
    const client = setup();
    const { result } = renderHook(() => useUpdateModel(), { wrapper: wrapper(client) });
    await act(() => result.current.mutateAsync({ providerId: 'p-cli', modelId: KIMI.id, patch: { enabled: false } }));
    await expectBothInvalidated(client);
  });

  test('delete', async () => {
    const client = setup();
    const { result } = renderHook(() => useDeleteModel(), { wrapper: wrapper(client) });
    await act(() => result.current.mutateAsync({ providerId: 'p-cli', modelId: KIMI.id }));
    await expectBothInvalidated(client);
  });

  test('reroute', async () => {
    const client = setup();
    const { result } = renderHook(() => useSetRoutingDefault(), { wrapper: wrapper(client) });
    await act(() => result.current.mutateAsync({ scope: 'ai-fill', modelId: GLM.id }));
    await expectBothInvalidated(client);
  });
});
