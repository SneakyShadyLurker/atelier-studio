import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { AdminProvider, ListedModel } from '@atelier/shared';
import { useAtelierStore } from '../../store/atelier';
import AddModelsDialog from './AddModelsDialog';
import { adminModel, adminProvider, SCOUT } from './fixtures';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

type Answer = () => Response;

const LISTED: readonly ListedModel[] = [
  { id: 'llama4:scout', hints: { vision: true, reasoningLevels: ['low'] }, source: 'provider' },
  { id: 'qwen3:32b', hints: { structuredOutput: 'json_schema', reasoningLevels: ['low', 'high'] }, source: 'provider' },
  { id: 'gemma4:27b', source: 'provider' },
  { id: 'gemma4:e4b', hints: { vision: true }, source: 'provider' },
];

const OLLAMA = adminProvider({ id: 'p-ollama', name: 'Ollama on this Mac', baseUrl: 'http://localhost:11434/v1', models: [SCOUT] });

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function setup(options: { list?: Answer; add?: Answer; provider?: AdminProvider } = {}) {
  const calls: Call[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined });
    if (url.endsWith('/models/available')) return (options.list ?? (() => Response.json({ models: LISTED, listUnsupported: false })))();
    if (url.endsWith('/models') && method === 'POST') {
      if (options.add) return options.add();
      // Echo the posted ids as fresh, untested rows.
      const posted = (JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { models: { modelId: string }[] }).models;
      return Response.json(posted.map(({ modelId }) => adminModel({ id: `m-${modelId}`, modelId, displayName: modelId })), { status: 201 });
    }
    return Response.json({ providers: [] });
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = mock(() => undefined);
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<AddModelsDialog provider={options.provider ?? OLLAMA} onClose={onClose} />, { wrapper: Wrapper });
  return { calls, onClose };
}

const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });
const checkbox = (name: string | RegExp) => screen.getByRole<HTMLInputElement>('checkbox', { name });
const posts = (calls: readonly Call[]) => calls.filter((call) => call.method === 'POST' && call.url.endsWith('/models'));
const toastTexts = () => useAtelierStore.getState().toasts.map((toast) => toast.text);

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ toasts: [] });
});

describe('Add models: the listed models', () => {
  test('lists the provider’s models with hints in plain words; added ones are marked and not selectable', async () => {
    setup();
    expect(screen.getByRole('dialog', { name: 'Add models from Ollama on this Mac' })).toBeTruthy();
    const qwen = await screen.findByRole('checkbox', { name: /qwen3:32b/ });
    expect(qwen.closest('li')?.textContent).toContain('JSON · reasoning');
    expect(checkbox(/gemma4:e4b/).closest('li')?.textContent).toContain('image input');

    const scout = checkbox(/llama4:scout/);
    expect(scout.disabled).toBe(true);
    expect(scout.closest('li')?.textContent).toContain('Added');
    expect(screen.getByText('4 listed, 0 selected')).toBeTruthy();
  });

  test('search filters the list without dropping the selection', async () => {
    setup();
    fireEvent.click(await screen.findByRole('checkbox', { name: /qwen3:32b/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search models' }), { target: { value: 'GEMMA' } });
    expect(screen.queryByRole('checkbox', { name: /qwen3:32b/ })).toBeNull();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByText('4 listed, 1 selected')).toBeTruthy();
    expect(button('Add 1 model')).toBeTruthy();
  });

  test('the submit counts the selection and sends the hints so rows start with them', async () => {
    const { calls, onClose } = setup();
    expect(button('Add models').disabled).toBe(true);
    fireEvent.click(await screen.findByRole('checkbox', { name: /qwen3:32b/ }));
    fireEvent.click(checkbox(/gemma4:27b/));
    fireEvent.click(button('Add 2 models'));
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(posts(calls)[0]?.url).toContain('/api/text-providers/p-ollama/models');
    expect(posts(calls)[0]?.body).toEqual({
      models: [
        { modelId: 'qwen3:32b', hints: { structuredOutput: 'json_schema', reasoningLevels: ['low', 'high'] } },
        { modelId: 'gemma4:27b' },
      ],
    });
    expect(toastTexts()).toContain('Added 2 models');
  });

  test('a submit calls the model list once: the add does not refetch it', async () => {
    const { calls, onClose } = setup();
    fireEvent.click(await screen.findByRole('checkbox', { name: /qwen3:32b/ }));
    fireEvent.click(button('Add 1 model'));
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    // Let any invalidation refetch land before counting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => call.url.endsWith('/models/available'))).toHaveLength(1);
  });

  test('a refused add keeps the dialog open with the server’s words', async () => {
    const { onClose } = setup({ add: () => Response.json({ error: 'qwen3:32b is already added.' }, { status: 409 }) });
    fireEvent.click(await screen.findByRole('checkbox', { name: /qwen3:32b/ }));
    fireEvent.click(button('Add 1 model'));
    expect((await screen.findByRole('alert')).textContent).toBe('qwen3:32b is already added.');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Add models: entering an id', () => {
  test('“Not listed?” adds a manual id, selected, without hints', async () => {
    const { calls } = setup();
    await screen.findByRole('checkbox', { name: /qwen3:32b/ });
    const input = screen.getByLabelText('Not listed? Enter a model id');
    fireEvent.change(input, { target: { value: '  my-finetune:7b ' } });
    fireEvent.click(button('Add'));
    expect(checkbox(/my-finetune:7b/).checked).toBe(true);
    expect((input as HTMLInputElement).value).toBe('');
    fireEvent.click(button('Add 1 model'));
    await waitFor(() => { expect(posts(calls)).toHaveLength(1); });
    expect(posts(calls)[0]?.body).toEqual({ models: [{ modelId: 'my-finetune:7b' }] });
  });

  test('an id that is listed selects it; an id already added says so', async () => {
    setup();
    await screen.findByRole('checkbox', { name: /qwen3:32b/ });
    const input = screen.getByLabelText('Not listed? Enter a model id');
    fireEvent.change(input, { target: { value: 'qwen3:32b' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(checkbox(/qwen3:32b/).checked).toBe(true);

    fireEvent.change(input, { target: { value: 'llama4:scout' } });
    fireEvent.click(button('Add'));
    expect(screen.getByText('llama4:scout is already added.')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  test('an id typed before the list arrives is not duplicated once the list lists it', async () => {
    let attempt = 0;
    const { calls } = setup({
      list: () => (++attempt === 1
        ? Response.json({ error: 'busy' }, { status: 429 })
        : Response.json({ models: LISTED, listUnsupported: false })),
    });
    const alert = await screen.findByRole('alert');
    const input = screen.getByLabelText('Not listed? Enter a model id');
    fireEvent.change(input, { target: { value: 'qwen3:32b' } });
    fireEvent.click(button('Add'));
    fireEvent.change(input, { target: { value: 'my-finetune:7b' } });
    fireEvent.click(button('Add'));

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByText('4 listed, 2 selected');
    expect(screen.getAllByRole('checkbox', { name: /qwen3:32b/ })).toHaveLength(1);
    expect(checkbox(/qwen3:32b/).checked).toBe(true);

    fireEvent.click(button('Add 2 models'));
    await waitFor(() => { expect(posts(calls)).toHaveLength(1); });
    expect(posts(calls)[0]?.body).toEqual({
      models: [
        { modelId: 'qwen3:32b', hints: { structuredOutput: 'json_schema', reasoningLevels: ['low', 'high'] } },
        { modelId: 'my-finetune:7b' },
      ],
    });
  });

  test('a provider without a model list switches to manual entry and explains why', async () => {
    const { calls } = setup({ list: () => Response.json({ models: [], listUnsupported: true }) });
    expect(await screen.findByText(/This server doesn’t list its models/)).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.change(screen.getByLabelText('Not listed? Enter a model id'), { target: { value: 'local-model' } });
    fireEvent.click(button('Add'));
    fireEvent.click(button('Add 1 model'));
    await waitFor(() => { expect(posts(calls)).toHaveLength(1); });
  });

  test('a provider with listing turned off never calls the list', () => {
    const { calls } = setup({ provider: { ...OLLAMA, listModels: false } });
    expect(screen.getByText(/model list is turned off/)).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith('/models/available'))).toBe(false);
  });
});

describe('Add models: list failures in plain words', () => {
  test('502 shows the server’s message and keeps manual entry', async () => {
    setup({ list: () => Response.json({ error: 'Could not reach http://localhost:11434/v1: connection refused.' }, { status: 502 }) });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not reach http://localhost:11434/v1: connection refused.');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByLabelText('Not listed? Enter a model id')).toBeTruthy();
  });

  test('429 says another test or list is running', async () => {
    setup({ list: () => Response.json({ error: 'busy' }, { status: 429 }) });
    expect((await screen.findByRole('alert')).textContent).toContain('Another test or model list is running. Try again in a moment.');
  });
});
