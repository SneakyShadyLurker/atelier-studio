import { afterEach, describe, expect, mock, test } from 'bun:test';
import { ApiError } from './client';
import { createCollection, fetchCollections } from './collections';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; mock.restore(); });

function jsonFetch(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}) {
  return mock(() => Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })));
}

describe('fetchCollections', () => {
  test('rejects malformed collection responses', async () => {
    globalThis.fetch = jsonFetch(200, { items: [{ id: 'c1', name: 'A' }], summary: {} }) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await fetchCollections();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      status: 200,
      body: { code: 'invalid-response-shape' },
    });
    expect(caught).toHaveProperty('requestId', undefined);
  });

  test('stores only server-echoed response request ids', async () => {
    globalThis.fetch = jsonFetch(200, { items: [], summary: {} }, { 'X-Request-Id': 'req_server_123' }) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await fetchCollections();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toHaveProperty('requestId', 'req_server_123');
  });
});

describe('createCollection', () => {
  test('accepts single collection mutation responses', async () => {
    globalThis.fetch = jsonFetch(200, {
      id: 'c1',
      name: 'A',
      count: 0,
      archivedCount: 0,
      createdAt: 1,
    }) as unknown as typeof fetch;

    const created = await createCollection('A');
    expect(created).toMatchObject({ id: 'c1', name: 'A' });
  });

  test('does not expose client-generated request ids on server errors', async () => {
    globalThis.fetch = jsonFetch(503, { error: 'server failed' }) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await createCollection('A');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toHaveProperty('requestId', undefined);
  });
});
