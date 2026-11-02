import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ByokDialog } from './index';
import { useAtelierStore } from '../../store/atelier';

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function TestWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

beforeEach(() => {
  useAtelierStore.setState({ byokOpen: true });
});

afterEach(() => {
  cleanup();
  mock.restore();
  useAtelierStore.setState({ byokOpen: false });
});

describe('ByokDialog absent state', () => {
  test('renders title and input when no key is on file', async () => {
    globalThis.fetch = mock(() => Response.json({ present: false })) as unknown as typeof fetch;

    render(<ByokDialog />, { wrapper: wrapper() });

    await waitFor(() => { expect(screen.getByText(/Add your Google API key/i)).toBeTruthy(); });
    expect(screen.getByPlaceholderText(/AIza/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /save key/i })).toBeTruthy();
  });

  test('disables Save when input is empty', async () => {
    globalThis.fetch = mock(() => Response.json({ present: false })) as unknown as typeof fetch;

    render(<ByokDialog />, { wrapper: wrapper() });

    await waitFor(() => { expect(screen.getByPlaceholderText(/AIza/i)).toBeTruthy(); });
    const save = screen.getByRole('button', { name: /save key/i });
    expect(save.hasAttribute('disabled')).toBe(true);
  });
});

describe('ByokDialog present state', () => {
  test('shows masked key with fingerprint and remove action', async () => {
    globalThis.fetch = mock(() =>
      Response.json({ present: true, fingerprint: 'a3f02e9b1c4d', updatedAt: 1_700_000_000_000 })
    ) as unknown as typeof fetch;

    render(<ByokDialog />, { wrapper: wrapper() });

    await waitFor(() => { expect(screen.getByRole('heading', { name: 'Google API key' })).toBeTruthy(); });
    await waitFor(() => { expect(screen.getByText(/a3f02e9b1c4d/)).toBeTruthy(); });
    expect(screen.getByRole('button', { name: /replace/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /remove key/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save key/i })).toBeNull();
  });

  test('opens remove confirmation', async () => {
    globalThis.fetch = mock(() =>
      Response.json({ present: true, fingerprint: 'a3f02e9b1c4d', updatedAt: 1_700_000_000_000 })
    ) as unknown as typeof fetch;

    render(<ByokDialog />, { wrapper: wrapper() });

    await waitFor(() => { expect(screen.getByRole('button', { name: /remove key/i })).toBeTruthy(); });
    fireEvent.click(screen.getByRole('button', { name: /remove key/i }));
    expect(await screen.findByText(/Remove your Google key/i)).toBeTruthy();
  });
});

describe('ByokDialog save flow', () => {
  test('shows inline error on GOOGLE_AUTH_FAILED', async () => {
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = requestUrl(input);
      if (url.endsWith('/keys/google') && method === 'PUT') {
        return Response.json(
          { error: 'google rejected the key', code: 'GOOGLE_AUTH_FAILED' },
          { status: 400 },
        );
      }
      return Response.json({ present: false });
    }) as unknown as typeof fetch;

    render(<ByokDialog />, { wrapper: wrapper() });

    await waitFor(() => { expect(screen.getByPlaceholderText(/AIza/i)).toBeTruthy(); });
    fireEvent.change(screen.getByPlaceholderText(/AIza/i), {
      target: { value: `AIza${'x'.repeat(35)}` },
    });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));
    await waitFor(() => { expect(screen.getByText(/Google rejected the key/i)).toBeTruthy(); });
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });

  test('shows retryable inline error on GOOGLE_UNAVAILABLE before generic 503 handling', async () => {
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = requestUrl(input);
      if (url.endsWith('/keys/google') && method === 'PUT') {
        return Response.json(
          { error: 'google unreachable', code: 'GOOGLE_UNAVAILABLE' },
          { status: 503 },
        );
      }
      return Response.json({ present: false });
    }) as unknown as typeof fetch;

    render(<ByokDialog />, { wrapper: wrapper() });

    await waitFor(() => { expect(screen.getByPlaceholderText(/AIza/i)).toBeTruthy(); });
    fireEvent.change(screen.getByPlaceholderText(/AIza/i), {
      target: { value: `AIza${'x'.repeat(35)}` },
    });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));
    await waitFor(() => {
      expect(screen.getByText(/Couldn't reach Google to verify the key/i)).toBeTruthy();
    });
    expect(screen.queryByText(/BYOK isn't configured/i)).toBeNull();
  });

  test('keeps server-side BYOK misconfiguration assertive', async () => {
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = requestUrl(input);
      if (url.endsWith('/keys/google') && method === 'PUT') {
        return Response.json({ error: 'unconfigured' }, { status: 503 });
      }
      return Response.json({ present: false });
    }) as unknown as typeof fetch;

    render(<ByokDialog />, { wrapper: wrapper() });

    await waitFor(() => { expect(screen.getByPlaceholderText(/AIza/i)).toBeTruthy(); });
    fireEvent.change(screen.getByPlaceholderText(/AIza/i), {
      target: { value: `AIza${'x'.repeat(35)}` },
    });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));
    await waitFor(() => { expect(screen.getByText(/BYOK isn't configured/i)).toBeTruthy(); });
    expect(screen.getByRole('alert').getAttribute('aria-live')).toBe('assertive');
  });

  test('Escape then Enter on Save during the exit fade does not store the key', async () => {
    const writes: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') writes.push(`${method} ${requestUrl(input)}`);
      return Response.json({ present: false });
    }) as unknown as typeof fetch;

    render(<ByokDialog />, { wrapper: wrapper() });

    await waitFor(() => { expect(screen.getByPlaceholderText(/AIza/i)).toBeTruthy(); });
    fireEvent.change(screen.getByPlaceholderText(/AIza/i), {
      target: { value: `AIza${'x'.repeat(35)}` },
    });
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));

    await waitFor(() => { expect(useAtelierStore.getState().byokOpen).toBe(false); });
    expect(writes).toEqual([]);
  });

  test('shows recovery instructions when an existing key row cannot decrypt', async () => {
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = requestUrl(input);
      if (url.endsWith('/keys/google') && method === 'PUT') {
        return Response.json(
          {
            error: 'recovery_required',
            message: 'The previously-stored BYOK key cannot be decrypted with the current master key. Delete the existing key (DELETE /api/keys/<provider>) to acknowledge recovery.',
          },
          { status: 409 },
        );
      }
      return Response.json({ present: false });
    }) as unknown as typeof fetch;

    render(<ByokDialog />, { wrapper: wrapper() });

    await waitFor(() => { expect(screen.getByPlaceholderText(/AIza/i)).toBeTruthy(); });
    fireEvent.change(screen.getByPlaceholderText(/AIza/i), {
      target: { value: `AIza${'x'.repeat(35)}` },
    });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));
    await waitFor(() => {
      expect(screen.getByText(/Delete the existing key/i)).toBeTruthy();
    });
    expect(screen.queryByText(/^recovery_required$/i)).toBeNull();
  });
});
