import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { AdminProvider, ConnectionReport } from '@atelier/shared';
import { useAtelierStore } from '../../store/atelier';
import AddProviderDialog from './AddProviderDialog';
import { adminProvider } from './fixtures';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

type Answer = () => Response;

const PASS: ConnectionReport = {
  ok: true,
  checks: [{ id: 'list', status: 'pass', message: 'The server answered and listed 2 models.' }],
  listedCount: 2,
};

const REFUSED: ConnectionReport = {
  ok: false,
  checks: [{ id: 'list', status: 'fail', message: 'Could not reach http://localhost:11434/v1: connection refused. Is the server running?' }],
};

const NO_LIST: ConnectionReport = {
  ok: false,
  checks: [{ id: 'list', status: 'fail', message: 'The server has no model list at this address (404/405).' }],
  listUnsupported: true,
};

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function setup(options: { test?: Answer; create?: Answer; byokMissing?: boolean } = {}) {
  const calls: Call[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined });
    if (url.endsWith('/api/text-providers/test')) return (options.test ?? (() => Response.json(PASS)))();
    if (url.endsWith('/api/text-providers') && method === 'POST') {
      return (options.create ?? (() => Response.json(adminProvider({ id: 'p-new', name: 'Ollama' }), { status: 201 })))();
    }
    return Response.json({ providers: [] });
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = mock(() => undefined);
  const onSaved = mock((_provider: AdminProvider) => undefined);
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<AddProviderDialog byokMissing={options.byokMissing ?? false} onClose={onClose} onSaved={onSaved} />, { wrapper: Wrapper });
  return { calls, onClose, onSaved, client };
}

const field = (name: string) => screen.getByLabelText<HTMLInputElement>(name);
const preset = (name: string) => within(screen.getByRole('group', { name: 'Preset' })).getByRole('radio', { name });
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
const posts = (calls: readonly Call[], suffix: string) => calls.filter((call) => call.method === 'POST' && call.url.endsWith(suffix));

function fill(name: string, value: string) {
  fireEvent.change(field(name), { target: { value } });
}

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ toasts: [] });
});

describe('Add provider: presets', () => {
  test('a preset fills the name, base URL, hint and advanced defaults', () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Add a provider' })).toBeTruthy();
    fireEvent.click(preset('Ollama'));
    expect(field('Name').value).toBe('Ollama');
    expect(field('Base URL').value).toBe('http://localhost:11434/v1');
    expect(screen.getByText('Runs on this machine. No key needed unless you set one.')).toBeTruthy();
    expect(screen.getByText('Optional for this preset.')).toBeTruthy();
    const tokenField = screen.getByRole('group', { name: 'Output limit field' });
    expect((within(tokenField).getByRole<HTMLInputElement>('radio', { name: 'max_tokens' })).checked).toBe(true);
    expect(field('Check the model list').checked).toBe(true);

    fireEvent.click(preset('Anthropic'));
    expect(field('Base URL').value).toBe('https://api.anthropic.com/v1');
    expect(field('Name').value).toBe('Anthropic');
    const protocol = screen.getByRole('group', { name: 'Protocol' });
    expect((within(protocol).getByRole<HTMLInputElement>('radio', { name: 'Anthropic' })).checked).toBe(true);
    // Anthropic has one fixed output-limit field.
    expect(screen.queryByRole('group', { name: 'Output limit field' })).toBeNull();
    expect(screen.queryByText('Optional for this preset.')).toBeNull();
  });

  test('a Custom preset leaves the address empty and keeps a name the admin typed', () => {
    setup();
    fireEvent.click(preset('OpenAI'));
    fill('Name', 'Work OpenAI');
    fireEvent.click(preset('Custom OpenAI-compatible'));
    expect(field('Base URL').value).toBe('');
    expect(field('Name').value).toBe('Work OpenAI');
    const protocol = screen.getByRole('group', { name: 'Protocol' });
    expect((within(protocol).getByRole<HTMLInputElement>('radio', { name: 'OpenAI-compatible' })).checked).toBe(true);

    fill('Base URL', 'http://10.0.0.5:8000/v1');
    fireEvent.click(preset('Custom Anthropic-compatible'));
    // A typed address survives a preset change.
    expect(field('Base URL').value).toBe('http://10.0.0.5:8000/v1');
  });
});

describe('Add provider: fields', () => {
  test('the base URL is validated with the shared rule and blocks the test', () => {
    const { calls } = setup();
    fill('Base URL', 'localhost:11434');
    fireEvent.blur(field('Base URL'));
    const input = field('Base URL');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const errorId = input.getAttribute('aria-describedby')?.split(' ').find((id) => document.getElementById(id)?.textContent.includes('http'));
    expect(errorId).toBeDefined();
    expect(document.getElementById(errorId ?? '')?.textContent).toBe('The address must start with http:// or https://.');

    fireEvent.click(button('Test connection'));
    expect(posts(calls, '/text-providers/test')).toHaveLength(0);
  });

  test('the key field is a password field with show/hide and password-manager opt-outs', () => {
    setup();
    const key = field('API key');
    expect(key.type).toBe('password');
    expect(key.getAttribute('autocomplete')).toBe('new-password');
    expect(key.hasAttribute('data-1p-ignore')).toBe(true);
    expect(key.getAttribute('data-lpignore')).toBe('true');
    fireEvent.click(button('Show API key'));
    expect(field('API key').type).toBe('text');
    fireEvent.click(button('Hide API key'));
    expect(field('API key').type).toBe('password');
  });

  test('without BYOK_ENCRYPTION_KEY the key field says keys cannot be stored', () => {
    setup({ byokMissing: true });
    const key = field('API key');
    expect(key.disabled).toBe(true);
    const note = 'This server has no BYOK_ENCRYPTION_KEY, so keys cannot be stored. Providers without a key still work.';
    expect(screen.getByText(note)).toBeTruthy();
    expect(key.getAttribute('aria-describedby')).toContain(screen.getByText(note).id);
  });

  test('turning the model list off asks for a model to test with', async () => {
    const { calls } = setup();
    fireEvent.click(preset('LM Studio'));
    expect(screen.queryByLabelText('Model to test with')).toBeNull();
    fireEvent.click(field('Check the model list'));
    fireEvent.click(button('Test connection'));
    expect(await screen.findByText('Enter the model id to send the test request to.')).toBeTruthy();
    expect(posts(calls, '/text-providers/test')).toHaveLength(0);

    fill('Model to test with', 'qwen3:32b');
    fireEvent.click(button('Test connection'));
    await waitFor(() => { expect(posts(calls, '/text-providers/test')).toHaveLength(1); });
    expect(posts(calls, '/text-providers/test')[0]?.body).toEqual({
      protocol: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
      tokenField: 'max_tokens',
      listModels: false,
      probeModelId: 'qwen3:32b',
    });
  });
});

describe('Add provider: connection test and save', () => {
  test('a passing test reads as a sentence and enables Save, which creates the provider and moves on to its models', async () => {
    const { calls, onClose, onSaved } = setup();
    fireEvent.click(preset('OpenAI'));
    fill('API key', 'sk-test-123');
    expect(button('Save provider').disabled).toBe(true);

    fireEvent.click(button('Test connection'));
    const report = await screen.findByRole('status');
    expect(report.textContent).toContain('Connection works.');
    expect(report.textContent).toContain('The server answered and listed 2 models.');
    expect(posts(calls, '/text-providers/test')[0]?.body).toEqual({
      protocol: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-123',
      tokenField: 'max_completion_tokens',
      listModels: true,
    });
    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();

    fireEvent.click(button('Save provider'));
    // The next step is adding its models, so the dialog hands over instead of closing.
    await waitFor(() => { expect(onSaved).toHaveBeenCalled(); });
    expect(onSaved.mock.calls[0]?.[0]).toMatchObject({ id: 'p-new', name: 'Ollama' });
    expect(onClose).not.toHaveBeenCalled();
    expect(posts(calls, '/text-providers')[0]?.body).toEqual({
      name: 'OpenAI',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      preset: 'openai',
      apiKey: 'sk-test-123',
      tokenField: 'max_completion_tokens',
      listModels: true,
    });
    expect(useAtelierStore.getState().toasts.map((toast) => toast.text)).toContain('Saved Ollama');
  });

  test('changing a connection field after a pass asks for a new test', async () => {
    setup();
    fireEvent.click(preset('Ollama'));
    fireEvent.click(button('Test connection'));
    await screen.findByRole('status');
    expect(button('Save provider').disabled).toBe(false);
    fill('Base URL', 'http://localhost:11435/v1');
    expect(button('Save provider').disabled).toBe(true);
    expect(screen.queryByText('Connection works.')).toBeNull();
    // Renaming does not change what was tested.
    fireEvent.click(button('Test connection'));
    await screen.findByRole('status');
    fill('Name', 'Ollama upstairs');
    expect(button('Save provider').disabled).toBe(false);
  });

  test('a failing test is an alert and keeps Save off', async () => {
    setup({ test: () => Response.json(REFUSED) });
    fireEvent.click(preset('Ollama'));
    fireEvent.click(button('Test connection'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not reach http://localhost:11434/v1: connection refused. Is the server running?');
    expect(button('Save provider').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
  });

  test('a server without a model list can be saved anyway', async () => {
    const { calls, onSaved } = setup({ test: () => Response.json(NO_LIST) });
    fireEvent.click(preset('Custom OpenAI-compatible'));
    fill('Name', 'vLLM box');
    fill('Base URL', 'http://10.0.0.5:8000/v1');
    fireEvent.click(button('Test connection'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The server has no model list at this address (404/405).');
    expect(button('Save provider').disabled).toBe(true);
    fireEvent.click(button('Save anyway'));
    await waitFor(() => { expect(onSaved).toHaveBeenCalled(); });
    expect(posts(calls, '/text-providers')[0]?.body).toMatchObject({ name: 'vLLM box', baseUrl: 'http://10.0.0.5:8000/v1', preset: 'custom-openai' });
  });

  test('a test already running answers 429 with a plain explanation', async () => {
    setup({ test: () => Response.json({ error: 'busy' }, { status: 429 }) });
    fireEvent.click(preset('Ollama'));
    fireEvent.click(button('Test connection'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Another test is running. Try again in a moment.');
  });

  test('a 503 byok-not-configured on save explains that keys cannot be stored', async () => {
    const { onClose } = setup({ create: () => Response.json({ error: 'byok-not-configured' }, { status: 503 }) });
    fireEvent.click(preset('OpenAI'));
    fill('API key', 'sk-test-123');
    fireEvent.click(button('Test connection'));
    await screen.findByRole('status');
    fireEvent.click(button('Save provider'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('This server has no BYOK_ENCRYPTION_KEY, so keys cannot be stored. Providers without a key still work.');
    expect(field('API key').disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('a name is required to save', async () => {
    const { calls } = setup();
    fireEvent.click(preset('Ollama'));
    fill('Name', '  ');
    fireEvent.click(button('Test connection'));
    await screen.findByRole('status');
    fireEvent.click(button('Save provider'));
    expect(await screen.findByText('Give the provider a name.')).toBeTruthy();
    expect(posts(calls, '/text-providers')).toHaveLength(0);
  });
});
