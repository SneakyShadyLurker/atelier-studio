import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { AdminModel, AdminProvider, TestReport } from '@atelier/shared';
import { useAtelierStore } from '../../store/atelier';
import EditModelDialog from './EditModelDialog';
import { adminModel, adminProvider, KIMI } from './fixtures';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const SCOUT = adminModel({
  id: 'm-scout',
  providerId: 'p-ollama',
  modelId: 'llama4:scout',
  displayName: 'Llama 4 Scout',
  vision: true,
  maxImages: 4,
  structuredOutput: 'json_schema',
  reasoningLevels: ['low', 'high'],
  reasoningDefault: 'low',
});

const OLLAMA = adminProvider({ id: 'p-ollama', name: 'Ollama on this Mac', models: [SCOUT] });

const REPORT: TestReport = {
  checks: [
    { id: 'plain', status: 'pass', message: 'The model replied.' },
    { id: 'json', status: 'pass', message: 'JSON object output works (schema mode was refused).' },
    { id: 'image', status: 'pass', message: 'The server refused the image: it answered 400 "image input not supported". Image input turned off.' },
    { id: 'reasoning', status: 'pass', message: "The server accepted reasoning efforts 'low' and 'high'." },
  ],
  proposed: { structuredOutput: 'json_object', vision: false, reasoningLevels: ['low', 'high'], reasoningDefault: 'low' },
  advertised: { reasoningLevels: ['medium'] },
  wireNotes: [],
};

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(options: {
  model?: AdminModel;
  provider?: AdminProvider;
  startTest?: boolean;
  test?: () => Response | Promise<Response>;
  patch?: () => Response;
} = {}) {
  const calls: Call[] = [];
  const model = options.model ?? SCOUT;
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined });
    if (url.endsWith('/test') && method === 'POST') return (options.test ?? (() => Response.json(REPORT)))();
    if (method === 'PATCH') {
      if (options.patch) return options.patch();
      return Response.json({ ...model, ...(calls.at(-1)?.body as Partial<AdminModel>) });
    }
    if (method === 'DELETE') return Response.json({ ok: true });
    return Response.json({ providers: [] });
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = mock(() => undefined);
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(
    <EditModelDialog
      provider={options.provider ?? OLLAMA}
      model={model}
      imageLabel={(id) => (id === 'gpt-image-2.5-sunburst' ? 'GPT Image 2.5 Sunburst' : id)}
      startTest={options.startTest ?? false}
      onClose={onClose}
    />,
    { wrapper: Wrapper },
  );
  return { calls, onClose };
}

const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });
const field = (name: string | RegExp) => screen.getByLabelText<HTMLInputElement>(name);
const patches = (calls: readonly Call[]) => calls.filter((call) => call.method === 'PATCH');
const toastTexts = () => useAtelierStore.getState().toasts.map((toast) => toast.text);
const chip = (name: string) => within(screen.getByRole('group', { name: 'Reasoning levels' })).getByRole('button', { name });

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ toasts: [] });
});

describe('Edit model: capabilities', () => {
  test('the form starts from the model, and Save sends only what changed', async () => {
    const { calls, onClose } = setup();
    expect(screen.getByRole('dialog', { name: 'Edit model' }).textContent).toContain('llama4:scout');
    expect(field('Display name').value).toBe('Llama 4 Scout');
    expect(field('Image input').checked).toBe(true);
    expect(field('Max images').value).toBe('4');
    expect(field('Schema').checked).toBe(true);
    expect(chip('Low').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Medium').getAttribute('aria-pressed')).toBe('false');
    expect(button('Save').disabled).toBe(true);

    fireEvent.change(field('Display name'), { target: { value: 'Scout' } });
    fireEvent.click(field('JSON only'));
    fireEvent.click(chip('Medium'));
    fireEvent.click(button('Save'));
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(patches(calls)[0]?.url).toContain('/api/text-providers/p-ollama/models/m-scout');
    expect(patches(calls)[0]?.body).toEqual({
      displayName: 'Scout',
      structuredOutput: 'json_object',
      reasoningLevels: ['low', 'medium', 'high'],
    });
    expect(toastTexts()).toContain('Saved Scout');
  });

  test('validation mirrors the server: an image limit needs image input', () => {
    setup();
    fireEvent.click(field('Image input'));
    expect(screen.getByText('An image limit needs image input turned on.')).toBeTruthy();
    expect(field('Max images').getAttribute('aria-invalid')).toBe('true');
    expect(button('Save').disabled).toBe(true);
    fireEvent.change(field('Max images'), { target: { value: '' } });
    expect(button('Save').disabled).toBe(false);
  });

  test('validation mirrors the server: the default must be one of the picked levels', () => {
    setup();
    fireEvent.click(chip('Low'));
    expect(screen.getByText('The default reasoning level must be one of the levels users can pick.')).toBeTruthy();
    expect(button('Save').disabled).toBe(true);
    fireEvent.change(field('Default effort'), { target: { value: 'high' } });
    expect(button('Save').disabled).toBe(false);
  });

  test('display name and numbers are checked before Save', () => {
    setup();
    fireEvent.change(field('Display name'), { target: { value: '   ' } });
    expect(screen.getByText('Display name must be 1 to 60 characters.')).toBeTruthy();
    fireEvent.change(field('Display name'), { target: { value: 'Scout' } });
    fireEvent.change(field('Max images'), { target: { value: '2.5' } });
    expect(screen.getByText('Max images must be a whole number from 1 to 1000.')).toBeTruthy();
    expect(button('Save').disabled).toBe(true);
  });

  test('with no levels picked the default becomes a fixed effort that allows any level', async () => {
    const { calls } = setup({ model: { ...SCOUT, reasoningLevels: [], reasoningDefault: null } });
    expect(screen.queryByLabelText('Default effort')).toBeNull();
    const fixed = field('Fixed effort') as unknown as HTMLSelectElement;
    expect([...fixed.options].map((option) => option.textContent)).toEqual(
      ['Not sent', 'None', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'],
    );
    fireEvent.change(fixed, { target: { value: 'max' } });
    fireEvent.click(button('Save'));
    await waitFor(() => { expect(patches(calls)).toHaveLength(1); });
    expect(patches(calls)[0]?.body).toEqual({ reasoningDefault: 'max' });
  });
});

describe('Edit model: advanced', () => {
  test('sampling, fixed output tokens, slow model, prompt style and screening are saved', async () => {
    const { calls } = setup();
    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.change(field('Temperature'), { target: { value: '0.7' } });
    fireEvent.change(field('Top P'), { target: { value: '0.9' } });
    fireEvent.change(field('Fixed output tokens'), { target: { value: '4000' } });
    fireEvent.click(field('Slow model'));
    fireEvent.click(field('Kimi-tuned'));
    fireEvent.click(field('Screen requests first'));
    fireEvent.click(button('Save'));
    await waitFor(() => { expect(patches(calls)).toHaveLength(1); });
    expect(patches(calls)[0]?.body).toEqual({
      temperature: 0.7,
      topP: 0.9,
      fixedOutputTokens: 4000,
      latencyProfile: 'slow',
      promptVariant: 'kimi',
      screenRequests: true,
    });
  });

  test('out-of-range sampling is refused in plain words', () => {
    setup();
    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.change(field('Temperature'), { target: { value: '3' } });
    expect(screen.getByText('Temperature must be a number from 0 to 2.')).toBeTruthy();
    expect(button('Save').disabled).toBe(true);
  });

  test('screening explains itself and warns when the server has no OPENROUTER_API_KEY', () => {
    setup({ provider: { ...OLLAMA, warnings: ['screen-requests-without-key'] } });
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByText(/Checks each request with the content screen/)).toBeTruthy();
    expect(screen.getByText(/OPENROUTER_API_KEY is not set on this server/)).toBeTruthy();
  });
});

describe('Edit model: Test model', () => {
  test('the four checks show as pending, then fill from the one report', async () => {
    const answer = deferred<Response>();
    const { calls } = setup({ test: () => answer.promise });
    fireEvent.click(button('Test model'));
    const pending = await screen.findByRole('status');
    expect(within(pending).getAllByRole('listitem').map((line) => line.textContent)).toEqual([
      'Plain reply: checking…',
      'JSON output: checking…',
      'Image input: checking…',
      'Reasoning: checking…',
    ]);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/api/text-providers/p-ollama/models/m-scout/test'))).toHaveLength(1);

    await act(async () => { answer.resolve(Response.json(REPORT)); await answer.promise; });
    const report = await screen.findByRole('status');
    await waitFor(() => { expect(report.textContent).toContain('The model replied.'); });
    expect(report.textContent).toContain('Image input turned off.');
    const confirmed = within(report).getByRole('group', { name: 'Confirmed by the test' });
    expect(confirmed.textContent).toContain('Image input: off');
    expect(confirmed.textContent).toContain('JSON output: JSON only');
    const reported = within(report).getByRole('group', { name: 'Reported by the provider' });
    const suggestion = within(reported).getByRole<HTMLInputElement>('checkbox', { name: 'Reasoning levels: also Medium' });
    expect(suggestion.checked).toBe(false);
  });

  test('Apply findings merges confirmed values without clobbering edits made during the test', async () => {
    const answer = deferred<Response>();
    setup({ test: () => answer.promise });
    fireEvent.click(button('Test model'));
    // The admin changes JSON output while the test runs.
    fireEvent.click(field('None'));
    await act(async () => { answer.resolve(Response.json(REPORT)); await answer.promise; });
    await screen.findByRole('group', { name: 'Confirmed by the test' });

    fireEvent.click(button('Apply findings'));
    expect(field('Image input').checked).toBe(false);
    expect(field('None').checked).toBe(true);
    expect(screen.getByText('Kept your change to JSON output.')).toBeTruthy();
    expect(chip('Medium').getAttribute('aria-pressed')).toBe('false');
  });

  test('advertised values apply only when ticked', async () => {
    const { calls } = setup();
    fireEvent.click(button('Test model'));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Reasoning levels: also Medium' }));
    fireEvent.click(button('Apply findings'));
    expect(chip('Medium').getAttribute('aria-pressed')).toBe('true');
    // Image input went off, so the image limit is cleared with it.
    expect(field('Max images').value).toBe('');
    fireEvent.click(button('Save'));
    await waitFor(() => { expect(patches(calls)).toHaveLength(1); });
    expect(patches(calls)[0]?.body).toEqual({
      vision: false,
      maxImages: null,
      structuredOutput: 'json_object',
      reasoningLevels: ['low', 'medium', 'high'],
    });
  });

  test('a failed check is announced and the plain words stay', async () => {
    setup({
      test: () => Response.json({
        ...REPORT,
        checks: [{ id: 'plain', status: 'fail', message: 'The server answered 401: invalid key.' }, ...REPORT.checks.slice(1).map((check) => ({ ...check, status: 'skip' as const, message: 'Skipped because the plain reply failed.' }))],
        proposed: {},
        advertised: {},
      }),
    });
    fireEvent.click(button('Test model'));
    expect((await screen.findByRole('alert')).textContent).toContain('1 check failed.');
    expect(screen.getByText(/The server answered 401: invalid key./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply findings' })).toBeNull();
  });

  test('429 says another test is running', async () => {
    setup({ test: () => Response.json({ error: 'busy' }, { status: 429 }) });
    fireEvent.click(button('Test model'));
    expect((await screen.findByRole('alert')).textContent).toContain('Another test or model list is running. Try again in a moment.');
  });

  test('opened from the row’s Test, it starts the test at once', async () => {
    const { calls } = setup({ startTest: true });
    await waitFor(() => { expect(calls.filter((call) => call.url.endsWith('/test'))).toHaveLength(1); });
    expect(await screen.findByRole('group', { name: 'Confirmed by the test' })).toBeTruthy();
  });

  test('says when it was last tested, and shows the stored report', () => {
    setup({ model: { ...SCOUT, verifiedAt: Date.now() - 5 * 60_000, lastTest: REPORT } });
    expect(screen.getByText('Last tested 5m ago')).toBeTruthy();
    expect(screen.getByText(/The model replied./)).toBeTruthy();
  });

  test('an untested model says so', () => {
    setup();
    expect(screen.getByText('Not tested yet. Test to confirm capabilities.')).toBeTruthy();
  });
});

describe('Edit model: remove', () => {
  test('Remove confirms with what uses the model, then deletes it', async () => {
    const { calls, onClose } = setup({ model: { ...KIMI, providerId: 'p-ollama' } });
    fireEvent.click(button('Remove model…'));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Kimi K3?' });
    expect(confirm.textContent).toContain(
      'It is the default model, assigned to AI fill, the prompt writer for GPT Image 2.5 Sunburst, and picked by 3 people. Those will fall back to the next model in line.',
    );
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove model' }));
    await waitFor(() => { expect(onClose).toHaveBeenCalled(); });
    expect(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/api/text-providers/p-ollama/models/m-kimi'))).toBe(true);
    expect(toastTexts()).toContain('Removed Kimi K3');
  });
});
