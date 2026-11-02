import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PromptTemplate } from '@atelier/shared';
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

describe('TemplateEditor — AI Draft Template integration', () => {
  test('native name length and restored over-length names share the server limit', () => {
    const fetch = mock(() => Response.json({}));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    wrap(<TemplateEditor template={null} variableLists={[]} initialName={'x'.repeat(65)} />);
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Template name' });
    expect(input.maxLength).toBe(64);
    fireEvent.change(screen.getByRole('textbox', { name: /body/i }), { target: { value: 'Prompt' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /save template/i }).disabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
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

  test('non-empty body continuation: joined with \\n\\n when no trailing whitespace', async () => {
    globalThis.fetch = mock(() => Promise.resolve(draftDone({ kind: 'body', body: 'CONT', warnings: [] }))) as unknown as typeof fetch;
    wrap(<TemplateEditor template={{ id: 't-1', name: 'X', body: 'existing' } as unknown as PromptTemplate} variableLists={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    await waitFor(() => {
      const ta = screen.getByRole<HTMLTextAreaElement>('textbox', { name: /^body$/i });
      expect(ta.value).toBe('existing\n\nCONT');
    });
  });

  test('non-empty body continuation: no separator when existing ends in whitespace', async () => {
    globalThis.fetch = mock(() => Promise.resolve(draftDone({ kind: 'body', body: 'CONT', warnings: [] }))) as unknown as typeof fetch;
    wrap(<TemplateEditor template={{ id: 't-1', name: 'X', body: 'existing ' } as unknown as PromptTemplate} variableLists={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /draft template/i }));
    await waitFor(() => {
      const ta = screen.getByRole<HTMLTextAreaElement>('textbox', { name: /^body$/i });
      expect(ta.value).toBe('existing CONT');
    });
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
