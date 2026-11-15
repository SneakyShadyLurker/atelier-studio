import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { AdminProvider, Model, PublicTextModel, TextModelsResponse, TextRoutingResponse } from '@atelier/shared';
import { textAdminKeys } from '../../api/textProviders';
import { textModelKeys } from '../../api/textModels';
import {
  useDeleteModel,
  useSetRoutingDefault,
  useTextProviders,
  useUpdateModel,
} from '../../hooks/useTextProviders';
import { useTextModelsEntry } from '../../hooks/useTextModelsAccess';
import { goToTextModels } from '../../lib/textModelsNav';
import { APP_VIEW_TEXT_MODELS, APP_VIEW_UNSORTED, useAtelierStore, type TextModelsTab } from '../../store/atelier';
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

const LISTED: readonly PublicTextModel[] = [
  { id: KIMI.id, displayName: 'Kimi K3', providerName: 'CLIProxyAPI', vision: true, reasoningLevels: ['low', 'high', 'max'], status: 'available' },
];

function textModels(models: readonly PublicTextModel[]): TextModelsResponse {
  return { models, tasks: [], defaults: { byTask: {} }, writers: {}, lockedWriters: [] };
}

type Answer<T> = T | 'pending' | 'error' | 404;

function answer<T>(value: Answer<T>, json: (body: T) => Response): Response | Promise<Response> {
  if (value === 'pending') return new Promise<Response>(() => undefined);
  if (value === 404) return Response.json({ error: 'not found' }, { status: 404 });
  // 400 is not retryable, so a failed read settles without backoff.
  if (value === 'error') return Response.json({ error: 'bad request' }, { status: 400 });
  return json(value);
}

/** Routes fetch by path; records every call. */
function installFetch(options: {
  providers?: Answer<readonly AdminProvider[]>;
  routing?: Answer<TextRoutingResponse>;
  /** The `models` of `GET /api/text-models`; zero listed by default. */
  models?: Answer<readonly PublicTextModel[]>;
} = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url, body });
    if (url.endsWith('/api/text-providers') && method === 'GET') {
      return answer(options.providers ?? PROVIDERS, (providers) => Response.json({ providers }));
    }
    if (url.includes('/api/text-routing')) return answer(options.routing ?? ROUTING, (routing) => Response.json(routing));
    if (url.includes('/api/text-models')) return answer(options.models ?? [], (models) => Response.json(textModels(models)));
    if (method === 'POST' && url.endsWith('/test')) return Response.json({ checks: [], proposed: {}, advertised: {}, wireNotes: [] });
    if (method === 'DELETE') return Response.json({ ok: true });
    if (method === 'PATCH') return Response.json({});
    return Response.json({});
  }) as unknown as typeof fetch;
  return calls;
}

/**
 * `tab`: the tab chosen this session; the inventory tests open Providers.
 * null leaves the choice to the view's default.
 */
function renderView(options: Parameters<typeof installFetch>[0] & { tab?: TextModelsTab | null } = {}) {
  const { tab = 'providers', ...fetchOptions } = options;
  useAtelierStore.setState({ textModelsTab: tab });
  const calls = installFetch(fetchOptions);
  const client = newClient();
  const onBack = mock(() => undefined);
  const view = render(<TextModels onBack={onBack} />, { wrapper: wrapper(client) });
  return { ...view, calls, client, onBack };
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ toasts: [], view: APP_VIEW_UNSORTED, textModelsTab: null });
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

  test('the sidebar shows the labelled Text models row only when enabled', () => {
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
    renderView({ providers: [], tab: null });

    expect(await screen.findByRole('heading', { name: 'No text model yet' })).toBeTruthy();
    expect(document.querySelector('[data-etching="empty-text-models"]')).not.toBeNull();
    expect(screen.getByText(/Connect a provider such as Ollama, LM Studio, OpenAI, Anthropic or OpenRouter/)).toBeTruthy();
    const guide = screen.getByRole('link', { name: 'Read the guide' });
    expect(guide.getAttribute('href')).toContain('docs/connect-a-text-model.md');
    expect(guide.getAttribute('rel')).toContain('noopener');
    // The empty state's own action is the only Add provider.
    expect(screen.getAllByRole('button', { name: 'Add provider' })).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Features' })).toBeNull();
  });

  test('Add provider opens the dialog slot (Task 15 plugs the form in)', async () => {
    renderView({ providers: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }));
    expect(await screen.findByRole('dialog', { name: 'Add a provider' })).toBeTruthy();
  });

  test('with providers, Add provider is the first row of the Providers tab, not a header action', async () => {
    const { container } = renderView();
    const panel = await screen.findByRole('tabpanel', { name: 'Providers' });
    const add = within(panel).getByRole('button', { name: 'Add provider' });
    expect(screen.getAllByRole('button', { name: 'Add provider' })).toHaveLength(1);
    expect(container.querySelector('[data-zone="head"]')?.contains(add)).toBe(false);
    const cli = within(panel).getByRole('region', { name: 'CLIProxyAPI' });
    expect(add.compareDocumentPosition(cli) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(add);
    expect(await screen.findByRole('dialog', { name: 'Add a provider' })).toBeTruthy();
  });

  test('uses the managed-view header and fixed zones', async () => {
    const { container, onBack } = renderView();
    await screen.findByRole('region', { name: 'CLIProxyAPI' });
    const heading = screen.getByRole('heading', { level: 2, name: 'Text models' });
    expect(container.querySelector('[data-zone="head"]')?.contains(heading)).toBe(true);
    const body = container.querySelector('[data-zone="body"]');
    expect(body?.textContent).toContain('Kimi K3');
    fireEvent.click(screen.getByRole('button', { name: 'Back to Unsorted' }));
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
    expect(within(kimi).getByText('available').parentElement?.getAttribute('data-tip')).toBe('Listed by provider. Test to confirm capabilities.');
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
        'The default model, assigned to AI fill, the prompt writer for GPT Image 2.6 Sunburst, and picked by 3 people',
      );
    });
    expect(tag.textContent).toContain(': The default model');
    expect(within(screen.getByRole('listitem', { name: 'GLM 5.3' })).queryByText(/^(Default|In use)/)).toBeNull();
  });

  test('routing sits in Shared setup, the inventory in Providers', async () => {
    const { container } = renderView({ tab: 'shared', models: LISTED });
    const shared = await screen.findByRole('tabpanel', { name: 'Shared setup' });
    const routing = await within(shared).findByRole('region', { name: 'Features' });
    expect(within(routing).getByText('What each feature writes with for everyone. People can pick their own model under Your picks.')).toBeTruthy();
    expect(within(shared).getByRole('region', { name: 'Image models' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'CLIProxyAPI' })).toBeNull();
    expect(container.querySelector('[data-zone="body"]')?.contains(routing)).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Providers' }));
    const providers = await screen.findByRole('tabpanel', { name: 'Providers' });
    expect(await within(providers).findByRole('region', { name: 'CLIProxyAPI' })).toBeTruthy();
    await waitFor(() => { expect(screen.queryByRole('region', { name: 'Features' })).toBeNull(); });
    expect(container.querySelector('[data-zone="body"]')?.contains(providers)).toBe(true);
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
      'It is the default model, assigned to AI fill, the prompt writer for GPT Image 2.6 Sunburst, and picked by 3 people. Those will fall back to the next model in line.',
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

  test.each([null, 1_790_000_000_000])('test tags follow verifiedAt precedence (%s)', async (verifiedAt) => {
    const provider = PROVIDERS[0];
    if (!provider) throw new Error('fixture missing');
    const model = {
      ...KIMI, enabled: false, verifiedAt,
      lastTest: { checks: [{ id: 'plain' as const, status: 'fail' as const, message: 'The model did not reply.' }], proposed: {}, advertised: {}, wireNotes: [] },
    };
    const { calls } = renderView({ providers: [{ ...provider, models: [model] }] });
    const row = await screen.findByRole('listitem', { name: 'Kimi K3' });
    const nameLine = within(row).getByText('Kimi K3').parentElement;
    expect(nameLine?.children[1]?.textContent).toBe('Off');
    expect(nameLine?.children[2]?.textContent).toStartWith('Default');
    expect(within(row).queryByText('Untested')).toBeNull();
    const failed = within(row).queryByRole('button', { name: 'Test failed: test again' });
    if (verifiedAt !== null) {
      expect(failed).toBeNull();
      return;
    }
    if (!failed) throw new Error('missing failed test tag');
    expect(nameLine?.children[3]).toBe(failed);
    expect(failed.getAttribute('data-tone')).toBe('danger');
    expect(failed.getAttribute('data-tip')).toBe('Run the capability test again');
    fireEvent.click(failed);
    expect(await screen.findByRole('dialog', { name: 'Edit model' })).toBeTruthy();
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/api/text-providers/p-cli/models/m-kimi/test'))).toBe(true);
    });
  });

  test('a disabled provider retains model state and live model controls', async () => {
    const provider = PROVIDERS[0];
    if (!provider) throw new Error('fixture missing');
    const { calls } = renderView({ providers: [{ ...provider, enabled: false }] });
    const section = await screen.findByRole('region', { name: 'CLIProxyAPI' });
    expect(section.getAttribute('data-enabled')).toBe('false');
    const row = within(section).getByRole('listitem', { name: 'Kimi K3' });
    expect(row.getAttribute('data-enabled')).toBe('true');
    expect(within(row).queryByText('Off')).toBeNull();
    expect(within(row).getByText('available').parentElement?.getAttribute('data-status')).toBe('available');
    expect(within(section).getByText('offline').parentElement?.getAttribute('data-status')).toBe('offline');
    const toggle = within(row).getByRole('switch', { name: 'Use Kimi K3' });
    expect(toggle.hasAttribute('disabled')).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => { expect(calls.some((call) => call.method === 'PATCH' && call.url.endsWith('/models/m-kimi'))).toBe(true); });
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
    await act(() => result.current.mutateAsync({ scope: 'ai-fill', body: { modelId: GLM.id } }));
    await expectBothInvalidated(client);
  });
});

describe('Text models tabs', () => {
  test('an admin sees Shared setup, Your picks and Providers in order, each controlling a labelled panel', async () => {
    renderView({ tab: null, models: LISTED });
    const tablist = await screen.findByRole('tablist', { name: 'Text models sections' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Shared setup', 'Your picks', 'Providers']);
    // The strip sits in the header's action slot, as in the Prompt Library.
    expect(document.querySelector('[data-zone="head"]')?.contains(tablist)).toBe(true);
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    expect(screen.getByRole('tabpanel', { name: 'Shared setup' })).toBeTruthy();
  });

  test('arrow keys rove the tabs; only the selected tab is in the tab order', async () => {
    renderView({ tab: null, models: LISTED });
    const tablist = await screen.findByRole('tablist');
    const [shared, picks, providers] = within(tablist).getAllByRole('tab');
    if (!shared || !picks || !providers) throw new Error('missing tabs');
    expect(shared.getAttribute('aria-selected')).toBe('true');
    expect([shared.tabIndex, picks.tabIndex, providers.tabIndex]).toEqual([0, -1, -1]);
    shared.focus();
    // Focus moves once the target is reachable (runWhenReachable).
    fireEvent.keyDown(shared, { key: 'ArrowRight' });
    await waitFor(() => { expect(document.activeElement === picks).toBe(true); });
    expect([shared.tabIndex, picks.tabIndex, providers.tabIndex]).toEqual([-1, 0, -1]);
    fireEvent.keyDown(picks, { key: 'ArrowRight' });
    await waitFor(() => { expect(document.activeElement === providers).toBe(true); });
    fireEvent.keyDown(providers, { key: 'ArrowLeft' });
    await waitFor(() => { expect(document.activeElement === picks).toBe(true); });
    // Roving moves focus only; selection follows a press.
    expect(shared.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(picks);
    expect(picks.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('tabpanel', { name: 'Your picks' })).toBeTruthy();
  });

  test('with no choice this session an admin lands on Providers while there is no provider, else Shared setup', async () => {
    renderView({ tab: null, providers: [] });
    const tab = await screen.findByRole('tab', { name: 'Providers' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    cleanup();

    renderView({ tab: null, models: LISTED });
    expect((await screen.findByRole('tab', { name: 'Shared setup' })).getAttribute('aria-selected')).toBe('true');
    expect(useAtelierStore.getState().textModelsTab).toBeNull();
  });

  test('the chosen tab survives leaving and re-entering the view', async () => {
    const { unmount } = renderView({ tab: null, models: LISTED });
    fireEvent.click(await screen.findByRole('tab', { name: 'Your picks' }));
    expect(useAtelierStore.getState().textModelsTab).toBe('picks');
    unmount();

    render(<TextModels onBack={() => undefined} />, { wrapper: wrapper(newClient()) });
    expect((await screen.findByRole('tab', { name: 'Your picks' })).getAttribute('aria-selected')).toBe('true');
  });

  test('"Set up text models" opens the view on the Providers tab with focus on the heading', async () => {
    useAtelierStore.setState({ textModelsTab: 'shared' });
    goToTextModels();
    expect(useAtelierStore.getState().view).toEqual(APP_VIEW_TEXT_MODELS);
    expect(useAtelierStore.getState().textModelsTab).toBe('providers');
    installFetch({ models: LISTED });
    render(<TextModels onBack={() => undefined} />, { wrapper: wrapper(newClient()) });
    expect((await screen.findByRole('tab', { name: 'Providers' })).getAttribute('aria-selected')).toBe('true');
    const heading = screen.getByRole('heading', { level: 2, name: 'Text models' });
    await waitFor(() => { expect(document.activeElement === heading).toBe(true); });
  });

  test('a non-admin sees Your picks alone, with no tablist and no admin reads', async () => {
    const { calls } = renderView({ tab: null, providers: 404, models: LISTED });
    expect(await screen.findByRole('region', { name: 'Your picks' })).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add provider' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Text models' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back to Unsorted' })).toBeTruthy();
    expect(calls.some((call) => call.url.includes('/api/text-routing'))).toBe(false);
  });

  test('a pending admin probe shows the loading state', async () => {
    renderView({ tab: null, providers: 'pending', models: LISTED });
    expect(await screen.findByText('Loading text models…')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Your picks' })).toBeNull();
  });

  test('a failed admin probe (not a 404) shows the error state with Retry', async () => {
    renderView({ tab: null, providers: 'error', models: LISTED });
    expect(await screen.findByText('Couldn’t load the text models.')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    installFetch({ models: LISTED });
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('tablist', { name: 'Text models sections' })).toBeTruthy();
  });

  test('zero listed models: a non-admin reads the ask-your-admin empty state', async () => {
    renderView({ tab: null, providers: 404, models: [] });
    expect(await screen.findByRole('heading', { name: 'No text model yet' })).toBeTruthy();
    expect(screen.getByText('Ask your admin to connect a text model.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Go to Providers' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Text model for / })).toBeNull();
  });

  for (const tab of ['shared', 'picks'] as const) {
    test(`zero listed models: an admin on ${tab === 'shared' ? 'Shared setup' : 'Your picks'} is pointed to Providers`, async () => {
      renderView({ tab, models: [] });
      const panel = await screen.findByRole('tabpanel', { name: tab === 'shared' ? 'Shared setup' : 'Your picks' });
      expect(await within(panel).findByRole('heading', { name: 'No text model yet' })).toBeTruthy();
      expect(within(panel).getByText('Add a provider and its models under Providers.')).toBeTruthy();
      expect(screen.queryByRole('region', { name: 'Features' })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Your picks' })).toBeNull();
      expect(screen.getByRole('tablist')).toBeTruthy();
      fireEvent.click(within(panel).getByRole('button', { name: 'Go to Providers' }));
      expect(screen.getByRole('tab', { name: 'Providers' }).getAttribute('aria-selected')).toBe('true');
      const providers = await screen.findByRole('tabpanel', { name: 'Providers' });
      expect(await within(providers).findByRole('region', { name: 'CLIProxyAPI' })).toBeTruthy();
    });
  }

  test('a failed routing read stays inside Shared setup; Providers stays usable', async () => {
    renderView({ tab: 'shared', routing: 'error', models: LISTED });
    const shared = await screen.findByRole('tabpanel', { name: 'Shared setup' });
    expect(await within(shared).findByText('Couldn’t load the routing settings.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Providers' }));
    const providers = await screen.findByRole('tabpanel', { name: 'Providers' });
    const kimi = await within(providers).findByRole('listitem', { name: 'Kimi K3' });
    expect(within(kimi).getByRole('switch', { name: 'Use Kimi K3' }).hasAttribute('disabled')).toBe(false);
    expect(within(providers).getByRole('button', { name: 'Add provider' })).toBeTruthy();
  });

  test('a failed providers refetch keeps the tabs and Your picks', async () => {
    const { client } = renderView({ tab: 'picks', models: LISTED });
    expect(await screen.findByRole('region', { name: 'Your picks' })).toBeTruthy();
    installFetch({ providers: 'error', models: LISTED });
    await client.refetchQueries({ queryKey: textAdminKeys.providers() });
    await waitFor(() => { expect(client.getQueryState(textAdminKeys.providers())?.status).toBe('error'); });
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Your picks' })).toBeTruthy();
    expect(screen.queryByText('Couldn’t load the text models.')).toBeNull();
  });
});

describe('Text models sidebar entry', () => {
  function entry(options: Parameters<typeof installFetch>[0], client = newClient()) {
    installFetch(options);
    return { ...renderHook(() => useTextModelsEntry(), { wrapper: wrapper(client) }), client };
  }

  test('an admin always sees it, even with zero listed models', async () => {
    const { result } = entry({ models: [] });
    await waitFor(() => { expect(result.current).toBe(true); });
  });

  test('a non-admin sees it once a model is listed', async () => {
    const { result } = entry({ providers: 404, models: LISTED });
    await waitFor(() => { expect(result.current).toBe(true); });
  });

  test('a non-admin with zero listed models does not', async () => {
    const { result, client } = entry({ providers: 404, models: [] });
    await waitFor(() => { expect(client.getQueryState(textModelKeys.all())?.status).toBe('success'); });
    await waitFor(() => { expect(client.getQueryState(textAdminKeys.providers())?.status).toBe('error'); });
    expect(result.current).toBe(false);
  });

  test('a non-admin does not while the read is pending or has never succeeded', async () => {
    const pending = entry({ providers: 404, models: 'pending' });
    await waitFor(() => { expect(pending.client.getQueryState(textAdminKeys.providers())?.status).toBe('error'); });
    expect(pending.result.current).toBe(false);
    pending.unmount();

    const failed = entry({ providers: 404, models: 'error' });
    await waitFor(() => { expect(failed.client.getQueryState(textModelKeys.all())?.status).toBe('error'); });
    expect(failed.result.current).toBe(false);
  });

  test('a failed refetch keeps the last successful answer', async () => {
    const { result, client } = entry({ providers: 404, models: LISTED });
    await waitFor(() => { expect(result.current).toBe(true); });
    installFetch({ providers: 404, models: 'error' });
    await client.refetchQueries({ queryKey: textModelKeys.all() });
    await waitFor(() => { expect(client.getQueryState(textModelKeys.all())?.status).toBe('error'); });
    expect(result.current).toBe(true);
  });
});
