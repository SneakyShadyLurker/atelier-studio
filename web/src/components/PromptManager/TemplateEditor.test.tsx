import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PromptTemplate, TextModelsResponse } from '@atelier/shared';
import { TEXT_TASKS } from '@atelier/shared';
import { useAtelierStore } from '../../store/atelier';
import TemplateEditor from './TemplateEditor';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; mock.restore(); cleanup(); });

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// The draft route streams its result as SSE: a 200 success carries the payload
// in a terminal `done` frame.
function draftDone(payload: unknown): Response {
  return new Response(`event: done\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}


const LISTING: TextModelsResponse = {
  models: [
    { id: 'kimi', displayName: 'Kimi K3', providerName: 'CLIProxyAPI', vision: true, reasoningLevels: ['low', 'high'], status: 'available' },
    { id: 'grok', displayName: 'Grok 4.7', providerName: 'CLIProxyAPI', vision: false, reasoningLevels: ['low', 'medium'], status: 'available' },
    { id: 'scout', displayName: 'Llama 4 Scout', providerName: 'Ollama', vision: true, reasoningLevels: [], status: 'available' },
  ],
  tasks: TEXT_TASKS.map((task) => (task === 'template-draft'
    ? { task, pick: 'kimi', effectiveModelId: 'kimi', pickState: 'active' }
    : { task, effectiveModelId: 'kimi' })),
  defaults: { default: 'kimi', byTask: {} },
  writers: { 'img-lock': 'scout' },
  lockedWriters: ['img-lock'],
};

// Routes the editor's requests: the text-model listing, the task-pick PUT and
// the draft POST, recording what was sent and in which order.
function routedFetch(options: { draft?: unknown; putStatus?: number } = {}) {
  const calls = { order: [] as string[], puts: [] as unknown[], drafts: [] as unknown[] };
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    if (url.endsWith('/text-models/tasks/template-draft') && init?.method === 'PUT') {
      calls.order.push('PUT template-draft');
      calls.puts.push(body);
      return Promise.resolve(options.putStatus === undefined ? Response.json(LISTING) : Response.json({ error: 'nope' }, { status: options.putStatus }));
    }
    if (url.endsWith('/text-models')) {
      calls.order.push('GET text-models');
      return Promise.resolve(Response.json(LISTING));
    }
    if (url.endsWith('/prompts/templates/draft')) {
      calls.order.push('POST draft');
      const { modelId: _imageModel, ...rest } = body as Record<string, unknown>;
      calls.drafts.push(rest);
      return Promise.resolve(draftDone(options.draft ?? { kind: 'body', body: 'REVISED', warnings: [] }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  }) as unknown as typeof fetch;
  return calls;
}

describe('TemplateEditor — AI Draft Template integration', () => {
  test('native name length and restored over-length names share the server limit', () => {
    const fetch = mock((_input: RequestInfo | URL) => Response.json({}));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    wrap(<TemplateEditor template={null} variableLists={[]} initialName={'x'.repeat(65)} />);
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Template name' });
    expect(input.maxLength).toBe(64);
    fireEvent.change(screen.getByRole('textbox', { name: /body/i }), { target: { value: 'Prompt' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /save template/i }).disabled).toBe(true);
    // Only the text-model gate's reads may go out; nothing is drafted or saved.
    const urls = fetch.mock.calls.map(([input]) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
    expect(urls.filter((url) => !url.endsWith('/text-models') && !url.endsWith('/text-providers'))).toEqual([]);
  });
  test('AI button visible in data-zone="head" next to Save template', () => {
    wrap(<TemplateEditor template={null} variableLists={[]} initialName="MyTpl" />);
    const head = document.querySelector('[data-zone="head"]');
    expect(head?.textContent).toContain('Draft Template');
    expect(head?.textContent).toContain('Save template');
  });

  test('AI button disabled when name is empty', () => {
    wrap(<TemplateEditor template={null} variableLists={[]} initialName="" />);
    const ai = screen.getByRole('button', { name: /draft template/i });
    expect((ai as HTMLButtonElement).disabled).toBe(true);
  });

  test('clicking AI on empty body opens the seed dialog', () => {
    wrap(<TemplateEditor template={null} variableLists={[]} initialName="MyTpl" />);
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    expect(screen.getByRole('heading', { name: /describe the template/i })).toBeTruthy();
  });

  test('seed-submit writes generated body on success', async () => {
    globalThis.fetch = mock(() => Promise.resolve(draftDone({ kind: 'body', body: 'GENERATED', warnings: [] }))) as unknown as typeof fetch;
    wrap(<TemplateEditor template={null} variableLists={[]} initialName="MyTpl" />);
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /description/i }), { target: { value: 'noir' } });
    fireEvent.click(screen.getByRole('button', { name: /generate template/i }));
    await waitFor(() => {
      const ta = screen.getByRole<HTMLTextAreaElement>('textbox', { name: /^body$/i });
      expect(ta.value).toBe('GENERATED');
    });
  });

  test('the Draft button tooltip names both jobs', () => {
    wrap(<TemplateEditor template={null} variableLists={[]} initialName="MyTpl" />);
    expect(screen.getByRole('button', { name: /draft template/i }).getAttribute('data-tip'))
      .toBe('Describe what to draft or what to change, and pick the text model that writes it');
  });

  test('a seed draft fills the empty body without a rework toast', async () => {
    useAtelierStore.setState({ toasts: [] });
    globalThis.fetch = mock(() => Promise.resolve(draftDone({ kind: 'body', body: 'GENERATED', warnings: [] }))) as unknown as typeof fetch;
    wrap(<TemplateEditor template={null} variableLists={[]} initialName="MyTpl" />);
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /description/i }), { target: { value: 'noir' } });
    fireEvent.click(screen.getByRole('button', { name: /generate template/i }));
    await waitFor(() => { expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /^body$/i }).value).toBe('GENERATED'); });
    expect(useAtelierStore.getState().toasts.some((t) => t.text === 'Template reworked')).toBe(false);
  });

  test('a filled body opens the rework dialog and sends nothing until submitted', async () => {
    const calls = routedFetch();
    wrap(<TemplateEditor template={{ id: 't-1', name: 'X', body: 'existing' } as unknown as PromptTemplate} variableLists={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    expect(screen.getByRole('heading', { name: 'Rework the template' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.drafts).toEqual([]);
  });

  test('rework replaces the body and Undo in its toast restores the previous one', async () => {
    useAtelierStore.setState({ toasts: [] });
    const calls = routedFetch({ draft: { kind: 'body', body: 'REVISED', warnings: [] } });
    wrap(<TemplateEditor template={{ id: 't-1', name: 'X', body: 'existing ' } as unknown as PromptTemplate} variableLists={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Change instructions' }), { target: { value: 'moodier' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rework template' }));
    const ta = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: /^body$/i });
    await waitFor(() => { expect(ta().value).toBe('REVISED'); });
    expect(calls.drafts).toEqual([{ name: 'X', existingBody: 'existing', description: 'moodier' }]);
    const toast = useAtelierStore.getState().toasts.find((t) => t.text === 'Template reworked');
    expect(toast?.tone).toBe('success');
    expect(toast?.action?.label).toBe('Undo');
    toast?.action?.onClick();
    await waitFor(() => { expect(ta().value).toBe('existing '); });
  });

  test('a changed model choice is saved before the draft request; an unchanged one is not', async () => {
    const calls = routedFetch({ draft: { kind: 'body', body: 'REVISED', warnings: [] } });
    wrap(<TemplateEditor template={{ id: 't-1', name: 'X', body: 'existing' } as unknown as PromptTemplate} variableLists={[]} />);
    await waitFor(() => { expect(calls.order).toContain('GET text-models'); });
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    const model = await screen.findByLabelText<HTMLSelectElement>('Model');
    await waitFor(() => { expect(model.disabled).toBe(false); });
    fireEvent.change(model, { target: { value: 'grok' } });
    fireEvent.change(screen.getByLabelText('Reasoning'), { target: { value: 'medium' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Change instructions' }), { target: { value: 'moodier' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rework template' }));
    await waitFor(() => { expect(calls.drafts).toHaveLength(1); });
    expect(calls.puts).toEqual([{ modelId: 'grok', effort: 'medium' }]);
    expect(calls.order.filter((entry) => entry !== 'GET text-models')).toEqual(['PUT template-draft', 'POST draft']);
  });

  test('cancelling the dialog saves no model choice; reopening shows the saved pick', async () => {
    const calls = routedFetch();
    wrap(<TemplateEditor template={{ id: 't-1', name: 'X', body: 'existing' } as unknown as PromptTemplate} variableLists={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    const model = await screen.findByLabelText<HTMLSelectElement>('Model');
    await waitFor(() => { expect(model.disabled).toBe(false); });
    fireEvent.change(model, { target: { value: 'grok' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    // Dismissal rides the shared exit transition before the dialog unmounts.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByRole('heading', { name: 'Rework the template' }) === null).toBe(true);
    expect(calls.puts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    expect((await screen.findByLabelText<HTMLSelectElement>('Model')).value).toBe('kimi');
  });

  test('a failed model save shows inline and sends no draft', async () => {
    const calls = routedFetch({ putStatus: 500 });
    wrap(<TemplateEditor template={{ id: 't-1', name: 'X', body: 'existing' } as unknown as PromptTemplate} variableLists={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    const model = await screen.findByLabelText<HTMLSelectElement>('Model');
    await waitFor(() => { expect(model.disabled).toBe(false); });
    fireEvent.change(model, { target: { value: 'grok' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Change instructions' }), { target: { value: 'moodier' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rework template' }));
    await waitFor(() => { expect(screen.getByRole('status').textContent).not.toBe(''); });
    expect(screen.getByRole('heading', { name: 'Rework the template' })).toBeTruthy();
    expect(calls.drafts).toEqual([]);
  });

  test('a locked writer for the Composer image model shows the fixed note instead of the selects', async () => {
    const previous = useAtelierStore.getState().draft;
    useAtelierStore.setState({ draft: { ...previous, modelId: 'img-lock' } });
    try {
      routedFetch();
      wrap(<TemplateEditor template={{ id: 't-1', name: 'X', body: 'existing' } as unknown as PromptTemplate} variableLists={[]} />);
      fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
      expect(await screen.findByText('Prompts for this image model are always written by Llama 4 Scout.')).toBeTruthy();
      expect(screen.queryByLabelText('Model')).toBeNull();
    } finally {
      useAtelierStore.setState({ draft: previous });
    }
  });

  test('starting the next draft retires the previous rework\'s Undo', async () => {
    useAtelierStore.setState({ toasts: [] });
    routedFetch({ draft: { kind: 'body', body: 'REVISED', warnings: [] } });
    wrap(<TemplateEditor template={{ id: 't-1', name: 'X', body: 'existing' } as unknown as PromptTemplate} variableLists={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Change instructions' }), { target: { value: 'moodier' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rework template' }));
    await waitFor(() => { expect(useAtelierStore.getState().toasts.some((t) => t.text === 'Template reworked')).toBe(true); });
    // The second dialog captures the revised body; an Undo pressed under it
    // would put the old body back while the request reworks the new one.
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    expect(screen.getByRole('textbox', { name: 'Change instructions' })).toBeTruthy();
    expect(useAtelierStore.getState().toasts.some((t) => t.text === 'Template reworked')).toBe(false);
  });

  test('unmounting the editor takes its Undo toast with it', async () => {
    useAtelierStore.setState({ toasts: [] });
    routedFetch({ draft: { kind: 'body', body: 'REVISED', warnings: [] } });
    const view = wrap(<TemplateEditor template={{ id: 't-1', name: 'X', body: 'existing' } as unknown as PromptTemplate} variableLists={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Change instructions' }), { target: { value: 'moodier' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rework template' }));
    await waitFor(() => { expect(useAtelierStore.getState().toasts.some((t) => t.text === 'Template reworked')).toBe(true); });
    view.unmount();
    expect(useAtelierStore.getState().toasts.some((t) => t.text === 'Template reworked')).toBe(false);
  });

  test('each warning from the AI response fires a separate soft toast', async () => {
    const warnings = [
      'Removed unknown {{var::camera}} reference',
      'Removed unknown {{var::backdrop}} reference',
    ];
    globalThis.fetch = mock(() => Promise.resolve(draftDone({ kind: 'body', body: 'GENERATED', warnings }))) as unknown as typeof fetch;
    // Reset store toast state before the test.
    useAtelierStore.setState({ toasts: [] });
    wrap(<TemplateEditor template={null} variableLists={[]} initialName="MyTpl" />);
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /description/i }), { target: { value: 'studio' } });
    fireEvent.click(screen.getByRole('button', { name: /generate template/i }));
    // Each warning must produce its own entry in the Zustand toast queue.
    await waitFor(() => {
      const toasts = useAtelierStore.getState().toasts;
      for (const warning of warnings) {
        expect(toasts.some((t) => t.text === warning && t.tone === 'soft')).toBe(true);
      }
    });
  });

  test('regression: AI Draft on new template (template=null) POSTs to /prompts/templates/draft, NOT /templates/unsaved/draft', async () => {
    let capturedUrl = '';
    globalThis.fetch = mock((input: RequestInfo | URL, _init?: RequestInit) => {
      capturedUrl = input instanceof Request ? input.url : String(input);
      return Promise.resolve(draftDone({ kind: 'body', body: 'GENERATED', warnings: [] }));
    }) as unknown as typeof fetch;
    wrap(<TemplateEditor template={null} variableLists={[]} initialName="MyTpl" />);
    // Open the seed dialog (body is empty on a new template)
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /description/i }), { target: { value: 'portrait' } });
    fireEvent.click(screen.getByRole('button', { name: /generate template/i }));
    await waitFor(() => {
      expect(capturedUrl).toContain('/prompts/templates/draft');
    });
    expect(capturedUrl).not.toContain('/unsaved');
    expect(capturedUrl).not.toContain('/unsaved/draft');
  });
});

describe('TemplateEditor — no text model', () => {
  const realMatchMedia = window.matchMedia.bind(window);
  afterEach(() => { window.matchMedia = realMatchMedia; });

  test('phone More → Draft Template opens the note anchored to the More button, not the describe dialog', async () => {
    window.matchMedia = mock((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: mock(() => undefined),
      removeEventListener: mock(() => undefined),
      addListener: mock(() => undefined),
      removeListener: mock(() => undefined),
      dispatchEvent: mock(() => true),
    }));
    const requests: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      if (url.endsWith('/text-models')) return Promise.resolve(Response.json({ models: [], tasks: [], defaults: { byTask: {} }, writers: {}, lockedWriters: [] }));
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as unknown as typeof fetch;
    wrap(<TemplateEditor template={null} variableLists={[]} initialName="MyTpl" />);
    await waitFor(() => { expect(requests.some((url) => url.endsWith('/text-models'))).toBe(true); });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const more = screen.getByRole('button', { name: 'More template actions' });
    more.focus();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Draft Template' }));

    const note = await screen.findByRole('dialog', { name: 'Draft Template needs a text model.' });
    expect(screen.queryByRole('heading', { name: /describe the template/i })).toBeNull();
    await waitFor(() => { expect(note.contains(document.activeElement)).toBe(true); });
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Escape' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    await waitFor(() => { expect(document.activeElement === more).toBe(true); });
  });
});

describe('TemplateEditor — Referenced lists disclosure', () => {
  test('the closed panel stays mounted and inert; the toggle flips data-open on the same panel', () => {
    wrap(<TemplateEditor template={null} variableLists={[]} initialName="MyTpl" />);
    fireEvent.change(screen.getByRole('textbox', { name: /body/i }), { target: { value: 'A {{var::lighting}} study' } });
    const toggle = screen.getByRole('button', { name: /Referenced lists, 1/ });
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    if (!panel) throw new Error('Referenced lists panel missing');
    expect(panel.textContent).toContain('lighting');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel.getAttribute('data-open')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(false);
    fireEvent.click(toggle);
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).toBe(panel);
    expect(panel.hasAttribute('data-open')).toBe(false);
    expect(panel.hasAttribute('inert')).toBe(true);
  });
});
