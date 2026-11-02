import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { useAtelierStore } from '../../store/atelier';
import SaveTemplateDialog from './index';

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  useAtelierStore.setState({ saveTemplatePrompt: null, toasts: [] });
  globalThis.fetch = originalFetch;
});

function wrapper(client: QueryClient) {
  return function W({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderOpen(prompt = 'a serene koi pond at dawn') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  useAtelierStore.getState().openSaveTemplate(prompt);
  render(<SaveTemplateDialog />, { wrapper: wrapper(client) });
  return { client };
}

function mockCreate(status: number, body: unknown) {
  globalThis.fetch = mock(() => Response.json(body, { status })) as unknown as typeof fetch;
}

describe('SaveTemplateDialog', () => {
  test('renders prefilled name and read-only prompt preview', () => {
    renderOpen('a serene koi pond at dawn');
    const input: HTMLInputElement = screen.getByLabelText('Template name');
    expect(input.value).toBe('a serene koi pond at dawn');
    expect(screen.getByLabelText('Prompt to be saved').textContent).toBe('a serene koi pond at dawn');
  });

  test('save disabled when name cleared', () => {
    renderOpen();
    const input = screen.getByLabelText('Template name');
    fireEvent.change(input, { target: { value: '   ' } });
    const saveBtn: HTMLButtonElement = screen.getByRole('button', { name: 'Save template' });
    expect(saveBtn.disabled).toBe(true);
  });

  test('successful save closes dialog and toasts', async () => {
    mockCreate(201, { id: 't1', name: 'koi', body: 'x', sortOrder: 0, createdAt: 1, updatedAt: 1 });
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => {
      expect(useAtelierStore.getState().saveTemplatePrompt).toBeNull();
    });
    expect(useAtelierStore.getState().toasts.some((t) => t.text === 'Saved to templates')).toBe(true);
  });

  test('duplicate name 409 shows specific inline error and stays open', async () => {
    mockCreate(409, { error: 'name already used' });
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => {
      expect(screen.getByText('A template with that name already exists.')).toBeTruthy();
    });
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(useAtelierStore.getState().saveTemplatePrompt).not.toBeNull();
  });

  test('other 409 shows limit message', async () => {
    mockCreate(409, { error: 'template limit reached' });
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => {
      expect(screen.getByText("You've reached the template limit.")).toBeTruthy();
    });
  });

  test('body-too-large 409 shows a length-specific message', async () => {
    mockCreate(409, { error: 'template body too large' });
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => {
      expect(screen.getByText('This prompt is too long to save as a template.')).toBeTruthy();
    });
  });

  test('network/500 shows generic message', async () => {
    mockCreate(500, { error: 'boom' });
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => {
      expect(screen.getByText('Couldn’t reach the server. Try again.')).toBeTruthy();
    });
  });

  test('typing clears inline error', async () => {
    mockCreate(409, { error: 'name already used' });
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await waitFor(() => screen.getByText('A template with that name already exists.'));
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'new name' } });
    expect(screen.queryByText('A template with that name already exists.')).toBeNull();
  });

  test('Cancel closes without fetching', async () => {
    const spy = mock(() => Response.json({}));
    globalThis.fetch = spy as unknown as typeof fetch;
    renderOpen();
    // Dismissals ride the shared exit transition (useExitTransition), so the
    // store close lands ~160ms after the gesture.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(useAtelierStore.getState().saveTemplatePrompt).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    test(`candidate-confirmation Enter does not save (${JSON.stringify(composition)})`, async () => {
      const spy = mock(() => Response.json({}));
      globalThis.fetch = spy as unknown as typeof fetch;
      renderOpen();
      fireEvent.keyDown(screen.getByLabelText('Template name'), { key: 'Enter', ...composition });
      await Promise.resolve();
      expect(spy).not.toHaveBeenCalled();
      expect(useAtelierStore.getState().saveTemplatePrompt).not.toBeNull();
    });
  }

  test('Escape then Enter during the exit fade does not save', async () => {
    const spy = mock(() => Response.json({ id: 't1', name: 'koi', body: 'x', sortOrder: 0, createdAt: 1, updatedAt: 1 }, { status: 201 }));
    globalThis.fetch = spy as unknown as typeof fetch;
    renderOpen();
    const input = screen.getByLabelText('Template name');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(useAtelierStore.getState().saveTemplatePrompt).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(useAtelierStore.getState().toasts.some((t) => t.text === 'Saved to templates')).toBe(false);
  });

  test('Escape closes', async () => {
    renderOpen();
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(useAtelierStore.getState().saveTemplatePrompt).toBeNull();
  });

  test('while the create is pending: busy affordances on, dismissal blocked, then closes on resolve', async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    globalThis.fetch = mock(() => new Promise<Response>((res) => { resolveFetch = res; })) as unknown as typeof fetch;
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));

    await waitFor(() => {
      const saving: HTMLButtonElement = screen.getByRole('button', { name: 'Saving…' });
      expect(saving.disabled).toBe(true);
    });
    const cancel: HTMLButtonElement = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel.disabled).toBe(true);

    // Escape must NOT close while the mutation is in flight.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useAtelierStore.getState().saveTemplatePrompt).not.toBeNull();

    resolveFetch(Response.json({ id: 't1', name: 'koi', body: 'x', sortOrder: 0, createdAt: 1, updatedAt: 1 }, { status: 201 }));
    await waitFor(() => {
      expect(useAtelierStore.getState().saveTemplatePrompt).toBeNull();
    });
    expect(useAtelierStore.getState().toasts.some((t) => t.text === 'Saved to templates')).toBe(true);
  });
});
