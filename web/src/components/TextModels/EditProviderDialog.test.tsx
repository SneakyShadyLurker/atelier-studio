import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { AdminProvider, ConnectionReport } from '@atelier/shared';
import { textModelKeys } from '../../api/textModels';
import { textAdminKeys } from '../../api/textProviders';
import { useAtelierStore } from '../../store/atelier';
import EditProviderDialog from './EditProviderDialog';
import { GLM, KIMI, PROVIDERS, adminProvider } from './fixtures';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const PASS: ConnectionReport = {
  ok: true,
  checks: [{ id: 'list', status: 'pass', message: 'The server answered and listed 12 models.' }],
  listedCount: 12,
};

const [CLIPROXY, OLLAMA, OPENAI] = PROVIDERS as [AdminProvider, AdminProvider, AdminProvider];
const KEYED = { ...OPENAI, warnings: [] };

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function setup(provider: AdminProvider, options: { test?: () => Response } = {}) {
  const calls: Call[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined });
    if (url.endsWith('/test')) return (options.test ?? (() => Response.json(PASS)))();
    if (method === 'DELETE') return Response.json({ ok: true });
    if (method === 'PATCH') return Response.json(provider);
    return Response.json({ providers: [] });
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(textAdminKeys.providers(), { providers: PROVIDERS });
  client.setQueryData(textModelKeys.all(), { models: [], tasks: [], defaults: { byTask: {} }, writers: {} });
  const onClose = mock(() => undefined);
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const imageLabel = (id: string) => (id === 'gpt-image-2.5-sunburst' ? 'GPT Image 2.5 Sunburst' : id);
  render(<EditProviderDialog provider={provider} imageLabel={imageLabel} onClose={onClose} />, { wrapper: Wrapper });
  return { calls, onClose, client };
}

const field = (name: string) => screen.getByLabelText<HTMLInputElement>(name);
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
const fill = (name: string, value: string) => { fireEvent.change(field(name), { target: { value } }); };
const writes = (calls: readonly Call[], method: string) => calls.filter((call) => call.method === method);

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ toasts: [] });
});

describe('Edit provider', () => {
  test('opens with the saved values and saves only what changed', async () => {
    const { calls, onClose, client } = setup(OLLAMA);
    expect(screen.getByRole('dialog', { name: 'Edit Ollama on this Mac' })).toBeTruthy();
    expect(field('Name').value).toBe('Ollama on this Mac');
    expect(field('Base URL').value).toBe('http://localhost:11434/v1');
    expect(screen.queryByRole('group', { name: 'Preset' })).toBeNull();

    fill('Name', 'Ollama');
    fill('Base URL', 'http://192.168.1.20:11434/v1/');
    fireEvent.click(button('Save'));
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(writes(calls, 'PATCH')).toEqual([
      { method: 'PATCH', url: expect.stringContaining('/api/text-providers/p-ollama') as string, body: { name: 'Ollama', baseUrl: 'http://192.168.1.20:11434/v1' } },
    ]);
    await waitFor(() => { expect(client.getQueryState(textModelKeys.all())?.isInvalidated).toBe(true); });
    expect(client.getQueryState(textAdminKeys.providers())?.isInvalidated).toBe(true);
  });

  test('an invalid address blocks Save with the shared message', () => {
    const { calls } = setup(OLLAMA);
    fill('Base URL', 'http://localhost:11434/v1?x=1');
    fireEvent.click(button('Save'));
    expect(screen.getByText('Remove the part after "?" from the address. Atelier adds its own request paths.')).toBeTruthy();
    expect(writes(calls, 'PATCH')).toHaveLength(0);
  });

  test('advanced fields are editable', async () => {
    const { calls, onClose } = setup(OLLAMA);
    const tokenField = screen.getByRole('group', { name: 'Output limit field' });
    fireEvent.click(within(tokenField).getByRole('radio', { name: 'max_tokens' }));
    fireEvent.click(field('Check the model list'));
    fireEvent.click(button('Save'));
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(writes(calls, 'PATCH')[0]?.body).toEqual({ tokenField: 'max_tokens', listModels: false });
  });

  test('an env-auth provider reads its key from the environment and has no key field', () => {
    setup(CLIPROXY);
    expect(screen.getByText('CLIPROXY_TOKEN')).toBeTruthy();
    expect(screen.getByText(/Read from/).textContent).toBe('Read from CLIPROXY_TOKEN');
    expect(screen.queryByLabelText('API key')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace key' })).toBeNull();
  });

  test('a stored key can be replaced', async () => {
    const { calls, onClose } = setup(KEYED);
    expect(screen.queryByLabelText('API key')).toBeNull();
    fireEvent.click(button('Replace key'));
    const key = field('API key');
    expect(key.type).toBe('password');
    expect(key.getAttribute('autocomplete')).toBe('new-password');
    fill('API key', 'sk-new-key');
    fireEvent.click(button('Save'));
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(writes(calls, 'PATCH')[0]?.body).toEqual({ apiKey: 'sk-new-key' });
  });

  test('a stored key can be removed, and the removal undone before saving', async () => {
    const { calls, onClose } = setup(KEYED);
    fireEvent.click(button('Remove key'));
    expect(screen.getByText('The key is removed when you save.')).toBeTruthy();
    fireEvent.click(button('Keep key'));
    expect(screen.queryByText('The key is removed when you save.')).toBeNull();
    fireEvent.click(button('Remove key'));
    fireEvent.click(button('Save'));
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(writes(calls, 'PATCH')[0]?.body).toEqual({ apiKey: null });
  });

  test('without BYOK_ENCRYPTION_KEY a keyless provider cannot add a key', () => {
    setup(adminProvider({ id: 'p-x', name: 'Box', warnings: ['byok-not-configured'] }));
    expect(field('API key').disabled).toBe(true);
    expect(screen.getByText('This server has no BYOK_ENCRYPTION_KEY, so keys cannot be stored. Providers without a key still work.')).toBeTruthy();
  });

  test('Test connection checks the saved provider', async () => {
    const { calls } = setup(OLLAMA);
    fireEvent.click(button('Test connection'));
    const report = await screen.findByRole('status');
    expect(report.textContent).toContain('Connection works.');
    expect(report.textContent).toContain('The server answered and listed 12 models.');
    const posts = writes(calls, 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toEndWith('/api/text-providers/p-ollama/test');
    expect(posts[0]?.body).toBeUndefined();
  });

  test('unsaved connection changes are flagged before testing the saved settings', () => {
    setup(OLLAMA);
    expect(screen.queryByText('Test connection checks the saved settings. Save first to test your changes.')).toBeNull();
    fill('Base URL', 'http://localhost:11435/v1');
    expect(screen.getByText('Test connection checks the saved settings. Save first to test your changes.')).toBeTruthy();
  });

  test('a saved test that is already running answers 429 with a plain explanation', async () => {
    setup(OLLAMA, { test: () => Response.json({ error: 'busy' }, { status: 429 }) });
    fireEvent.click(button('Test connection'));
    expect((await screen.findByRole('alert')).textContent).toBe('Another test is running. Try again in a moment.');
  });

  test('Delete provider confirms with the model count and usage', async () => {
    const { calls, onClose } = setup(CLIPROXY);
    expect(CLIPROXY.models).toEqual([KIMI, GLM]);
    fireEvent.click(button('Delete provider…'));
    const confirm = await screen.findByRole('dialog', { name: 'Delete CLIProxyAPI?' });
    expect(confirm.textContent).toContain(
      'Its 2 models go with it. Between them they are the default model, assigned to AI fill, the prompt writer for GPT Image 2.5 Sunburst, and picked by 3 people. Those will fall back to the next model in line.',
    );
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete provider' }));
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(writes(calls, 'DELETE')[0]?.url).toEndWith('/api/text-providers/p-cli');
    expect(useAtelierStore.getState().toasts.map((toast) => toast.text)).toContain('Deleted CLIProxyAPI');
  });

  test('deleting a provider without models says nothing else changes', async () => {
    const { calls } = setup(KEYED);
    fireEvent.click(button('Delete provider…'));
    const confirm = await screen.findByRole('dialog', { name: 'Delete OpenAI?' });
    expect(confirm.textContent).toContain('It has no models. Nothing else changes.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await act(() => Bun.sleep(300));
    expect(screen.queryByRole('dialog', { name: 'Delete OpenAI?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Edit OpenAI' })).toBeTruthy();
    expect(writes(calls, 'DELETE')).toHaveLength(0);
  });
});
