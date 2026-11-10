import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  getMediaSnapshot,
  isMediaCacheable,
  mediaCacheBytes,
  resetMediaCacheForTests,
  retainMedia,
  retryMedia,
  subscribeMedia,
} from './mediaCache';

interface Call { url: string; init: RequestInit | undefined; resolve: (response: Response) => void; reject: (error: unknown) => void }

const realFetch = globalThis.fetch;
const realCreate = URL.createObjectURL.bind(URL);
const realRevoke = URL.revokeObjectURL.bind(URL);
let calls: Call[] = [];
let revoked: string[] = [];
let created = 0;

function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await flush();
}

function bytes(size: number): Response {
  return new Response(new Blob([new Uint8Array(size)], { type: 'image/webp' }), { status: 200 });
}

beforeEach(() => {
  calls = [];
  revoked = [];
  created = 0;
  resetMediaCacheForTests({ capBytes: 1000, backoffMs: 1 });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init, resolve, reject });
    init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); });
  })) as typeof fetch;
  URL.createObjectURL = () => { created += 1; return `blob:test/${created}`; };
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
});

afterEach(() => {
  resetMediaCacheForTests();
  globalThis.fetch = realFetch;
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

describe('mediaCache', () => {
  test('de-duplicates concurrent consumers into one same-origin fetch with the requested priority', async () => {
    const releaseA = retainMedia('/api/img/a/thumb', { priority: 'high' });
    const releaseB = retainMedia('/api/img/a/thumb');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.credentials).toBe('same-origin');
    expect(calls[0]?.init?.priority).toBe('high');
    expect(getMediaSnapshot('/api/img/a/thumb')?.status).toBe('loading');
    calls[0]?.resolve(bytes(100));
    await settle();
    expect(getMediaSnapshot('/api/img/a/thumb')).toEqual({ status: 'ready', src: 'blob:test/1' });
    expect(mediaCacheBytes()).toBe(100);
    releaseA();
    releaseB();
    await settle();
    // Released entries stay for the next remount: no second request.
    const releaseC = retainMedia('/api/img/a/thumb');
    expect(calls).toHaveLength(1);
    expect(getMediaSnapshot('/api/img/a/thumb')?.src).toBe('blob:test/1');
    releaseC();
  });

  test('notifies subscribers when the entry becomes ready', async () => {
    let notified = 0;
    const unsubscribe = subscribeMedia('/x', () => { notified += 1; });
    const release = retainMedia('/x');
    calls[0]?.resolve(bytes(10));
    await settle();
    expect(notified).toBeGreaterThan(0);
    unsubscribe();
    release();
  });

  test('evicts unreferenced entries oldest first by bytes and revokes their object URLs', async () => {
    for (const url of ['/a', '/b', '/c', '/d', '/e']) {
      const release = retainMedia(url);
      calls.at(-1)?.resolve(bytes(240));
      await settle();
      release();
      await settle();
    }
    // 1200 bytes against a 1000 byte cap: the oldest unreferenced entry goes.
    expect(getMediaSnapshot('/a')).toBeUndefined();
    expect(revoked).toEqual(['blob:test/1']);
    for (const url of ['/b', '/c', '/d', '/e']) expect(getMediaSnapshot(url)?.status).toBe('ready');
    expect(mediaCacheBytes()).toBe(960);
  });

  test('a read refreshes recency so a repainted entry outlives older ones', async () => {
    for (const url of ['/a', '/b', '/c', '/d']) {
      const release = retainMedia(url);
      calls.at(-1)?.resolve(bytes(240));
      await settle();
      release();
      await settle();
    }
    expect(getMediaSnapshot('/a')?.status).toBe('ready');
    const release = retainMedia('/e');
    calls.at(-1)?.resolve(bytes(240));
    await settle();
    release();
    await settle();
    expect(getMediaSnapshot('/a')?.status).toBe('ready');
    expect(getMediaSnapshot('/b')).toBeUndefined();
  });

  test('never evicts an entry in use and admits referenced entries over the cap', async () => {
    const releases = [];
    const urls = ['/a', '/b', '/c', '/d', '/e'];
    for (const url of urls) {
      releases.push(retainMedia(url));
      calls.at(-1)?.resolve(bytes(240));
      await settle();
    }
    expect(mediaCacheBytes()).toBe(1200);
    for (const url of urls) expect(getMediaSnapshot(url)?.status).toBe('ready');
    expect(revoked).toEqual([]);
    releases[1]?.();
    await settle();
    // Over the cap once /b is unreferenced: it goes now, though /a is older.
    expect(getMediaSnapshot('/b')).toBeUndefined();
    expect(getMediaSnapshot('/a')?.status).toBe('ready');
    expect(revoked).toEqual(['blob:test/2']);
    for (const release of releases) release();
  });

  test('drops an entry larger than a quarter of the cap on its last release', async () => {
    const release = retainMedia('/big');
    calls[0]?.resolve(bytes(300));
    await settle();
    expect(getMediaSnapshot('/big')?.status).toBe('ready');
    release();
    await settle();
    expect(getMediaSnapshot('/big')).toBeUndefined();
    expect(revoked).toEqual(['blob:test/1']);
    expect(mediaCacheBytes()).toBe(0);
  });

  test('a release followed by a retain in the same task keeps the fetch (StrictMode, priority change)', async () => {
    const first = retainMedia('/a');
    first();
    const second = retainMedia('/a');
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.signal?.aborted).toBe(false);
    second();
  });

  test('aborts the fetch when its last consumer leaves', async () => {
    const releaseA = retainMedia('/a');
    const releaseB = retainMedia('/a');
    releaseA();
    await settle();
    expect(calls[0]?.init?.signal?.aborted).toBe(false);
    releaseB();
    await settle();
    expect(calls[0]?.init?.signal?.aborted).toBe(true);
    expect(getMediaSnapshot('/a')).toBeUndefined();
    // A later consumer starts over.
    const release = retainMedia('/a');
    expect(calls).toHaveLength(2);
    release();
  });

  test('retries a 503 after its Retry-After (capped) and a network error, then reports an error', async () => {
    resetMediaCacheForTests({ capBytes: 1000, backoffMs: 1, maxRetryAfterMs: 5 });
    const release = retainMedia('/t');
    calls[0]?.resolve(new Response(null, { status: 503, headers: { 'Retry-After': '30' } }));
    await settle();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(calls).toHaveLength(2);
    calls[1]?.reject(new TypeError('Failed to fetch'));
    await settle();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(calls).toHaveLength(3);
    calls[2]?.resolve(new Response(null, { status: 503 }));
    await settle();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    // Two retries, then the consumer is told.
    expect(calls).toHaveLength(3);
    expect(getMediaSnapshot('/t')).toEqual({ status: 'error', src: undefined });
    release();
  });

  test('a transient failure that recovers on retry becomes ready', async () => {
    const release = retainMedia('/t');
    calls[0]?.resolve(new Response(null, { status: 503, headers: { 'Retry-After': '0' } }));
    await settle();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    calls[1]?.resolve(bytes(10));
    await settle();
    expect(getMediaSnapshot('/t')?.status).toBe('ready');
    release();
  });

  test('a permanent failure does not retry; retryMedia starts a fresh attempt', async () => {
    const release = retainMedia('/gone');
    calls[0]?.resolve(new Response(null, { status: 404 }));
    await settle();
    expect(calls).toHaveLength(1);
    expect(getMediaSnapshot('/gone')?.status).toBe('error');
    retryMedia('/gone');
    expect(getMediaSnapshot('/gone')?.status).toBe('loading');
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(bytes(10));
    await settle();
    expect(getMediaSnapshot('/gone')?.status).toBe('ready');
    release();
  });

  test('an errored entry is forgotten on its last release so a remount tries again', async () => {
    const release = retainMedia('/gone');
    calls[0]?.resolve(new Response(null, { status: 404 }));
    await settle();
    release();
    await settle();
    expect(getMediaSnapshot('/gone')).toBeUndefined();
  });

  test('a fetch that answers synchronously or throws settles like any other', async () => {
    globalThis.fetch = (() => bytes(10)) as unknown as typeof fetch;
    const releaseSync = retainMedia('/sync');
    await settle();
    expect(getMediaSnapshot('/sync')?.status).toBe('ready');
    globalThis.fetch = (() => { throw new TypeError('blocked'); }) as unknown as typeof fetch;
    const releaseThrow = retainMedia('/throws');
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(getMediaSnapshot('/throws')?.status).toBe('error');
    releaseSync();
    releaseThrow();
  });

  test('data: and blob: URLs bypass the cache', () => {
    const release = retainMedia('data:image/png;base64,AAAA');
    const releaseBlob = retainMedia('blob:http://atelier.test/abc');
    expect(calls).toHaveLength(0);
    expect(getMediaSnapshot('data:image/png;base64,AAAA')).toBeUndefined();
    expect(isMediaCacheable('data:image/png;base64,AAAA')).toBe(false);
    expect(isMediaCacheable('blob:http://atelier.test/abc')).toBe(false);
    expect(isMediaCacheable('/api/img/a/thumb?media=2')).toBe(true);
    release();
    releaseBlob();
  });

  test('the snapshot object is stable between changes', async () => {
    const release = retainMedia('/a');
    const loading = getMediaSnapshot('/a');
    expect(getMediaSnapshot('/a') === loading).toBe(true);
    calls[0]?.resolve(bytes(10));
    await settle();
    const ready = getMediaSnapshot('/a');
    expect(ready === loading).toBe(false);
    expect(getMediaSnapshot('/a') === ready).toBe(true);
    release();
  });
});
