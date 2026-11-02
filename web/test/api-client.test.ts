import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const originalReload = window.location.reload.bind(window.location);
let removePersistedQueryClientMock = mock(() => Promise.resolve());

void mock.module('../src/lib/persister', () => ({
  removePersistedQueryClient: () => removePersistedQueryClientMock(),
}));

const { ApiError, apiFetch, requestJson } = await import('../src/api/client');
const { fetchHistoryPage } = await import('../src/api/history');
const { fetchArchivePage } = await import('../src/api/archive');
const { fetchPromptLibrary, reorderTemplates, reorderLists } = await import('../src/api/prompts');

beforeEach(() => {
  removePersistedQueryClientMock = mock(() => Promise.resolve());
});

afterEach(() => {
  mock.restore();
  sessionStorage.clear();
  window.location.reload = originalReload;
});

async function rejectedValue(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected promise to reject');
}

describe('API client', () => {
  test('apiFetch injects a request id and keeps cookie credentials same-origin', async () => {
    let observed: RequestInit | undefined;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      observed = init;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    await apiFetch('/health');

    const headers = new Headers(observed?.headers);
    expect(headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(observed?.credentials).toBe('same-origin');
  });

  test('history, archive, and prompt library wrappers validate response shapes', async () => {
    globalThis.fetch = mock(() => Response.json({ nextCursor: null })) as unknown as typeof fetch;
    expect(await rejectedValue(fetchHistoryPage(null))).toMatchObject({ message: 'invalid response shape' });

    globalThis.fetch = mock(() => Response.json({ items: [], nextCursor: null })) as unknown as typeof fetch;
    expect(await rejectedValue(fetchArchivePage(null))).toMatchObject({ message: 'invalid response shape' });

    globalThis.fetch = mock(() => Response.json({ templates: [], variableLists: [] })) as unknown as typeof fetch;
    expect(await rejectedValue(fetchPromptLibrary())).toMatchObject({ message: 'invalid response shape' });
    expect(await rejectedValue(reorderTemplates([]))).toMatchObject({ message: 'invalid response shape' });
    expect(await rejectedValue(reorderLists([]))).toMatchObject({ message: 'invalid response shape' });
  });

  test('maps 4xx response bodies to typed non-retryable errors', async () => {
    const body = { error: 'validation failed', code: 'VALIDATION_FAILED' };
    globalThis.fetch = mock(() => new Response(JSON.stringify(body), { status: 400 })) as unknown as typeof fetch;

    expect(await rejectedValue(requestJson('/generate'))).toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'validation failed',
      retryable: false,
      body,
    });
  });

  test('marks 5xx errors retryable', async () => {
    globalThis.fetch = mock(() => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;

    expect(await rejectedValue(requestJson('/models'))).toMatchObject({
      status: 502,
      retryable: true,
    });
  });

  test('propagates abort errors without remapping', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    globalThis.fetch = mock(() => {
      throw abort;
    }) as unknown as typeof fetch;

    expect(await rejectedValue(requestJson('/history'))).toBe(abort);
  });

  test('exposes ApiError instances for instanceof checks', () => {
    expect(new ApiError(500, 'internal error') instanceof Error).toBe(true);
  });

  test('reloads once when Authelia session expiry returns 401', async () => {
    const reload = mock(() => undefined);
    window.location.reload = reload;
    globalThis.fetch = mock(() => new Response('', { status: 401 })) as unknown as typeof fetch;

    expect(await rejectedValue(requestJson('/history'))).toMatchObject({ status: 401 });
    expect(await rejectedValue(requestJson('/models'))).toMatchObject({ status: 401 });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('waits for persisted query deletion before reloading after auth expiry', async () => {
    let resolveRemoval: (() => void) | undefined;
    removePersistedQueryClientMock = mock(() => new Promise<void>((resolve) => {
      resolveRemoval = resolve;
    }));
    const reload = mock(() => undefined);
    window.location.reload = reload;
    globalThis.fetch = mock(() => new Response('', { status: 401 })) as unknown as typeof fetch;

    expect(await rejectedValue(requestJson('/history'))).toMatchObject({ status: 401 });
    expect(removePersistedQueryClientMock).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();

    resolveRemoval?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('reloads once when the CSRF guard returns 403', async () => {
    const reload = mock(() => undefined);
    window.location.reload = reload;
    globalThis.fetch = mock(() => Response.json({ error: 'forbidden' }, { status: 403 })) as unknown as typeof fetch;

    expect(await rejectedValue(requestJson('/generate'))).toMatchObject({ status: 403 });
    expect(await rejectedValue(requestJson('/generate'))).toMatchObject({ status: 403 });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('reloads when an Authelia soft redirect returns html with a 200', async () => {
    const reload = mock(() => undefined);
    window.location.reload = reload;
    globalThis.fetch = mock(() => new Response('<!doctype html><title>Login</title>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })) as unknown as typeof fetch;

    await rejectedValue(requestJson('/history'));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('reloads when fetch exposes the redirected flag on an html response', async () => {
    const reload = mock(() => undefined);
    window.location.reload = reload;
    globalThis.fetch = mock(() => {
      const response = new Response('<!doctype html><title>Login</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
      Object.defineProperty(response, 'redirected', { value: true });
      return response;
    }) as unknown as typeof fetch;

    await rejectedValue(requestJson('/models'));

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
