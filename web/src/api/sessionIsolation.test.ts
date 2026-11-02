import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { apiFetch, requestJson, requestNoContent } from './client';
import {
  bindSessionScope,
  invalidateSessionScope,
  isSessionLocked,
  onSessionScopeInvalidated,
  resetSessionScopeForTests,
  sessionBinding,
} from '../lib/sessionScope';
import { SESSION_SCOPE_HEADER } from '@atelier/shared';

const SCOPE_A = '3d3a4748-9b9e-4b22-b72d-e6d4d95e47f8';
const SCOPE_B = '96aa4d98-e85c-420f-a0ae-be475f59747a';
const originalFetch = globalThis.fetch;
const originalReload = window.location.reload.bind(window.location);

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.location.reload = originalReload;
  sessionStorage.clear();
  resetSessionScopeForTests();
  mock.restore();
});

describe('bound API session', () => {
  test('overrides caller scope on mutations and SSE while preserving request ids', async () => {
    bindSessionScope(SCOPE_A);
    const observed: RequestInit[] = [];
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init) observed.push(init);
      return Promise.resolve(Response.json({}, { headers: { [SESSION_SCOPE_HEADER]: SCOPE_A } }));
    }) as unknown as typeof fetch;
    await apiFetch('/uploads', { method: 'POST', headers: { [SESSION_SCOPE_HEADER]: SCOPE_B, 'X-Request-Id': 'req-upload' } });
    await apiFetch('/generate', { method: 'POST' });
    await apiFetch('/batches/batch-1/events', { headers: { Accept: 'text/event-stream' } });
    expect(observed).toHaveLength(3);
    for (const init of observed) {
      expect(new Headers(init.headers).get(SESSION_SCOPE_HEADER)).toBe(SCOPE_A);
      expect(init.credentials).toBe('same-origin');
      expect(init.signal?.aborted).toBe(false);
    }
    expect(new Headers(observed[0]?.headers).get('X-Request-Id')).toBe('req-upload');
    expect(isSessionLocked()).toBe(false);
  });

  test('mismatch locks synchronously, aborts requests and streams, rejects late responses, then reloads once', async () => {
    bindSessionScope(SCOPE_A);
    const reload = mock(() => undefined);
    window.location.reload = reload;
    let finishLate: ((response: Response) => void) | undefined;
    let lateSignal: AbortSignal | null | undefined;
    let requests = 0;
    const cancelStream = mock(() => undefined);
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      requests += 1;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/late')) {
        lateSignal = init?.signal;
        return new Promise<Response>((resolve) => { finishLate = resolve; });
      }
      if (url.endsWith('/stream')) {
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ cancel: cancelStream }), {
          headers: { [SESSION_SCOPE_HEADER]: SCOPE_A, 'Content-Type': 'text/event-stream' },
        }));
      }
      return Promise.resolve(Response.json({ error: 'session changed', code: 'SESSION_CHANGED' }, {
        status: 409, headers: { [SESSION_SCOPE_HEADER]: SCOPE_B, 'X-Request-Id': 'req-switch' },
      }));
    }) as unknown as typeof fetch;
    const late = apiFetch('/late');
    const stream = await apiFetch('/stream');
    if (!stream.body) throw new Error('expected stream');
    const reading = stream.body.getReader().read().catch((error: unknown) => error);
    let lockedInCallback = false;
    const forbiddenFromCallback: Promise<unknown>[] = [];
    onSessionScopeInvalidated(() => {
      lockedInCallback = isSessionLocked();
      forbiddenFromCallback.push(apiFetch('/must-not-send').catch((error: unknown) => error));
      expect(reload).not.toHaveBeenCalled();
    });
    const changed = apiFetch('/switch');
    expect(await changed.catch((error: unknown) => error)).toMatchObject({
      status: 409, body: { code: 'SESSION_CHANGED' }, requestId: 'req-switch', retryable: false,
    });
    expect(lockedInCallback).toBe(true);
    expect(lateSignal?.aborted).toBe(true);
    expect(await reading).toHaveProperty('name', 'AbortError');
    expect(cancelStream).toHaveBeenCalledTimes(1);
    for (const forbidden of forbiddenFromCallback) expect(await forbidden).toMatchObject({ status: 409 });
    finishLate?.(Response.json({ accountB: 'must not hydrate' }));
    expect(await late.catch((error: unknown) => error)).toMatchObject({ status: 409 });
    expect(await apiFetch('/again').catch((error: unknown) => error)).toMatchObject({ status: 409 });
    expect(requests).toBe(3);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('honors SESSION_CHANGED when an intermediary drops the scope response header', async () => {
    bindSessionScope(SCOPE_A);
    window.location.reload = mock(() => undefined);
    globalThis.fetch = mock(() => Promise.resolve(Response.json({ code: 'SESSION_CHANGED', error: 'session changed' }, {
      status: 409,
    }))) as unknown as typeof fetch;
    expect(await apiFetch('/generate', { method: 'POST' }).catch((error: unknown) => error)).toMatchObject({ status: 409 });
    expect(isSessionLocked()).toBe(true);
  });

  test('ordinary conflicts do not retire the session or consume the error body', async () => {
    bindSessionScope(SCOPE_A);
    globalThis.fetch = mock(() => Promise.resolve(Response.json({ error: 'name already used' }, { status: 409 }))) as unknown as typeof fetch;
    expect(await requestJson('/collections').catch((error: unknown) => error)).toMatchObject({ status: 409, message: 'name already used' });
    expect(isSessionLocked()).toBe(false);
  });

  test('a no-content response passes through even though the browser gives it an empty body', async () => {
    bindSessionScope(SCOPE_A);
    // Chromium hands a 204 an empty, non-null body and, unlike Bun, refuses
    // to construct a null-body-status Response that has one.
    const noContent = new Response(new ReadableStream<Uint8Array>(), { status: 204, headers: { [SESSION_SCOPE_HEADER]: SCOPE_A } });
    globalThis.fetch = mock(() => Promise.resolve(noContent)) as unknown as typeof fetch;
    const NativeResponse = globalThis.Response;
    globalThis.Response = class extends NativeResponse {
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        if (body != null && [101, 103, 204, 205, 304].includes(init?.status ?? 200)) {
          throw new TypeError("Failed to construct 'Response': Response with null body status cannot have body");
        }
        super(body, init);
      }
    };
    try {
      await requestNoContent('/batches/batch-1', { method: 'DELETE' });
    } finally {
      globalThis.Response = NativeResponse;
    }
    expect(isSessionLocked()).toBe(false);
  });

  test('caller abort still cancels body consumption without retiring the session', async () => {
    bindSessionScope(SCOPE_A);
    const caller = new AbortController();
    let observedSignal: AbortSignal | null | undefined;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>()));
    }) as unknown as typeof fetch;
    const response = await apiFetch('/stream', { signal: caller.signal });
    const reading = response.text();
    const reason = new DOMException('caller canceled', 'AbortError');
    caller.abort(reason);
    expect(observedSignal?.aborted).toBe(true);
    expect(await reading.catch((error: unknown) => error)).toBe(reason);
    expect(isSessionLocked()).toBe(false);
  });

  test('unread buffered bodies do not subscribe or prefill, and reading after cancellation rejects', async () => {
    bindSessionScope(SCOPE_A);
    const signal = sessionBinding().signal;
    const add = spyOn(signal, 'addEventListener');
    const remove = spyOn(signal, 'removeEventListener');
    const originals: Response[] = [];
    globalThis.fetch = mock(() => {
      const response = new Response('buffered');
      originals.push(response);
      return Promise.resolve(response);
    }) as unknown as typeof fetch;
    const first = await apiFetch('/unread-success');
    const second = await apiFetch('/unread-error');
    await Promise.resolve();
    await Promise.resolve();
    expect(add.mock.calls.filter(([type]) => type === 'abort').length).toBe(0);
    expect(originals[0]?.body?.locked).toBe(false);
    expect(originals[1]?.body?.locked).toBe(false);

    expect(await first.text()).toBe('buffered');
    expect(add.mock.calls.filter(([type]) => type === 'abort').length).toBe(1);
    expect(remove.mock.calls.filter(([type]) => type === 'abort').length).toBe(1);
    expect(originals[0]?.body?.locked).toBe(false);

    invalidateSessionScope();
    expect(await second.text().catch((error: unknown) => error)).toHaveProperty('name', 'AbortError');
    expect(add.mock.calls.filter(([type]) => type === 'abort').length).toBe(1);
    expect(remove.mock.calls.filter(([type]) => type === 'abort').length).toBe(1);
  });

  test('active reads subscribe and detach when the session aborts an SSE body', async () => {
    bindSessionScope(SCOPE_A);
    const signal = sessionBinding().signal;
    const add = spyOn(signal, 'addEventListener');
    const remove = spyOn(signal, 'removeEventListener');
    const canceled = mock(() => undefined);
    globalThis.fetch = mock(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      cancel: canceled,
    }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } }))) as unknown as typeof fetch;
    const response = await apiFetch('/active-stream');
    if (!response.body) throw new Error('expected stream');
    const reading = response.body.getReader().read().catch((error: unknown) => error);
    await Promise.resolve();
    const subscriptions = add.mock.calls.filter(([type]) => type === 'abort');
    expect(subscriptions.length).toBe(1);
    const subscription = subscriptions[0];
    if (!subscription) throw new Error('expected abort subscription');
    const abortListener = subscription[1];
    const wasDetached = () => remove.mock.calls.some(([type, listener]) => type === 'abort' && listener === abortListener);
    expect(wasDetached()).toBe(false);
    invalidateSessionScope();
    expect(await reading).toHaveProperty('name', 'AbortError');
    // Happy DOM also removes once listeners during dispatch, so cleanup may
    // produce two removals of this same callback. Verify its identity instead.
    expect(wasDetached()).toBe(true);
    expect(canceled).toHaveBeenCalledTimes(1);
  });

  test('consumer cancellation and source errors detach listeners and release source readers', async () => {
    bindSessionScope(SCOPE_A);
    const signal = sessionBinding().signal;
    const add = spyOn(signal, 'addEventListener');
    const remove = spyOn(signal, 'removeEventListener');
    for (const mode of ['cancel', 'error']) {
      let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const canceled = mock(() => undefined);
      const source = new ReadableStream<Uint8Array>({
        start(controller) { sourceController = controller; },
        cancel: canceled,
      }, { highWaterMark: 0 });
      globalThis.fetch = mock(() => Promise.resolve(new Response(source))) as unknown as typeof fetch;
      const response = await apiFetch(`/stream-${mode}`);
      if (!response.body) throw new Error('expected stream');
      const reader = response.body.getReader();
      const reading = reader.read().catch((error: unknown) => error);
      await Promise.resolve();
      if (mode === 'cancel') {
        await reader.cancel('discard');
        await reading;
        expect(canceled).toHaveBeenCalledTimes(1);
      } else {
        const failure = new Error('source failed');
        sourceController?.error(failure);
        expect(await reading).toBe(failure);
      }
      expect(source.locked).toBe(false);
    }
    expect(add.mock.calls.filter(([type]) => type === 'abort').length).toBe(2);
    expect(remove.mock.calls.filter(([type]) => type === 'abort').length).toBe(2);
    expect(isSessionLocked()).toBe(false);
  });

  test('a page binding cannot be rebound in place', () => {
    bindSessionScope(SCOPE_A);
    bindSessionScope(SCOPE_A);
    expect(() => { bindSessionScope(SCOPE_B); }).toThrow('session changed');
    expect(isSessionLocked()).toBe(true);
    invalidateSessionScope();
    expect(() => { bindSessionScope(SCOPE_A); }).toThrow('session changed');
  });
});
