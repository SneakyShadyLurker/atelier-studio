import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { TextRoutingResponse } from '@atelier/shared';
import { TEXT_TASK_LABELS, TEXT_TASKS } from '@atelier/shared';
import { textAdminKeys } from '../../api/textProviders';
import { textModelKeys } from '../../api/textModels';
import { useAtelierStore } from '../../store/atelier';
import { PROVIDERS, ROUTING } from './fixtures';
import RoutingPanel from './RoutingPanel';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

/** The server answers each routing PUT with `next(url, body, current)`. */
function renderPanel(
  initial: TextRoutingResponse = ROUTING,
  next: (url: string, body: { modelId: string | null; mode?: 'lock' | 'prefer' }, current: TextRoutingResponse) => TextRoutingResponse = () => initial,
) {
  const calls: Call[] = [];
  let current = initial;
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { modelId: string | null; mode?: 'lock' | 'prefer' } : undefined;
    calls.push({ method, url, body });
    if (url.includes('/api/text-routing')) {
      if (method === 'PUT' && body) current = next(url, body, current);
      return Response.json(current);
    }
    if (url.includes('/api/text-providers')) return Response.json({ providers: PROVIDERS });
    return Response.json({ models: [], tasks: [], defaults: { byTask: {} }, writers: {} });
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(textAdminKeys.routing(), initial);
  client.setQueryData(textModelKeys.all(), { models: [], tasks: [], defaults: { byTask: {} }, writers: {} });
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(<RoutingPanel providers={PROVIDERS} />, { wrapper: Wrapper });
  return { calls, client };
}

const puts = (calls: readonly Call[]) => calls.filter((call) => call.method === 'PUT');

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ toasts: [] });
});

describe('RoutingPanel', () => {
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
    await waitFor(() => { expect(client.getQueryState(textModelKeys.all())?.isInvalidated).toBe(true); });
  });

  test('task assignments list all eleven tasks, "Use default" first', async () => {
    renderPanel();
    await screen.findByRole('region', { name: 'Routing' });
    for (const task of TEXT_TASKS) {
      const label = TEXT_TASK_LABELS[task];
      const expected = task === 'ai-fill' ? 'Kimi K3' : 'Use default';
      expect(screen.getByRole('button', { name: `Model for ${label}, currently ${expected}` })).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { name: /^Model for / })).toHaveLength(11);
    expect(screen.getByText('1 assigned, 10 use the default')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Model for Enhance, currently Use default' }));
    expect(screen.getAllByRole('option')[0]?.textContent).toBe('Use default');
  });

  test('assigning and clearing a task', async () => {
    const { calls } = renderPanel(ROUTING, (url, body, current) => {
      const task = url.split('/').at(-1) as 'enhance' | 'ai-fill';
      const byTask = Object.fromEntries(Object.entries(current.defaults.byTask).filter(([key]) => key !== task));
      return { ...current, defaults: { ...current.defaults, byTask: body.modelId === null ? byTask : { ...byTask, [task]: body.modelId } } };
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Model for Enhance, currently Use default' }));
    fireEvent.click(screen.getByRole('option', { name: 'Llama 4 Scout' }));
    await screen.findByRole('button', { name: 'Model for Enhance, currently Llama 4 Scout' });
    // The first menu leaves on a timer; let it unmount before opening the next.
    await act(() => Bun.sleep(300));

    fireEvent.click(screen.getByRole('button', { name: 'Model for AI fill, currently Kimi K3' }));
    fireEvent.click(screen.getByRole('option', { name: 'Use default' }));
    await screen.findByRole('button', { name: 'Model for AI fill, currently Use default' });

    expect(puts(calls).map((call) => [call.url, call.body])).toEqual([
      ['/api/text-routing/defaults/enhance', { modelId: 'm-scout' }],
      ['/api/text-routing/defaults/ai-fill', { modelId: null }],
    ]);
  });

  test('prompt writers: one row per registered image model, "No writer" by default, no mode until chosen', async () => {
    renderPanel();
    await screen.findByRole('region', { name: 'Routing' });
    expect(screen.getByRole('button', { name: 'Prompt writer for GPT Image 2.5 Sunburst, currently No writer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prompt writer for Krea 2, currently No writer' })).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
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
    const prefer = within(group).getByRole('radio', { name: 'Use unless the person picked their own' });
    const lock = within(group).getByRole('radio', { name: 'Always use this model' });
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

  test('a failed write toasts the server message and keeps the saved state', async () => {
    globalThis.fetch = mock(() => Response.json({ error: 'That model is turned off.' }, { status: 400 })) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(textAdminKeys.routing(), ROUTING);
    render(
      <QueryClientProvider client={client}><RoutingPanel providers={PROVIDERS} /></QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Default model, currently Kimi K3' }));
    fireEvent.click(screen.getByRole('option', { name: /^GLM 5\.3/ }));
    await waitFor(() => {
      expect(useAtelierStore.getState().toasts.some((toast) => toast.text.includes('That model is turned off.'))).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'Default model, currently Kimi K3' })).toBeTruthy();
  });
});
