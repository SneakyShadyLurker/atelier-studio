import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { boundedFetch, setTextFetchForTests, TextResponseTooLargeError } from './fetch';

let server: ReturnType<typeof Bun.serve>;
let origin = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/redirect') return new Response(null, { status: 302, headers: { location: '/small' } });
      if (path === '/big') {
        // Three 1 KiB chunks (3072 bytes in total).
        const chunk = new Uint8Array(1024).fill(97);
        let sent = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent === 3) {
              controller.close();
              return;
            }
            sent += 1;
            controller.enqueue(chunk);
          },
        }));
      }
      return new Response('hello');
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  void server.stop(true);
});

afterEach(() => {
  setTextFetchForTests(null);
});

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('boundedFetch', () => {
  test('passes a body under the cap through unchanged', async () => {
    const res = await boundedFetch({ maxBytes: 100 })(`${origin}/small`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  test('errors the body with TextResponseTooLargeError past the cap and reports it once', async () => {
    const seen: [number, number][] = [];
    const res = await boundedFetch({
      maxBytes: 1500,
      onOversize: (limit, seenBytes) => { seen.push([limit, seenBytes]); },
    })(`${origin}/big`);
    expect(res.status).toBe(200);
    const caught = await rejectionOf(res.text());
    expect(caught).toBeInstanceOf(TextResponseTooLargeError);
    // TCP may coalesce the chunks, so only the overshoot is fixed.
    expect(caught).toMatchObject({ limit: 1500 });
    const seenBytes = (caught as TextResponseTooLargeError).seenBytes;
    expect(seenBytes).toBeGreaterThan(1500);
    expect(seen).toEqual([[1500, seenBytes]]);
  });

  test('a body exactly at the cap is accepted', async () => {
    const res = await boundedFetch({ maxBytes: 3072 })(`${origin}/big`);
    expect((await res.arrayBuffer()).byteLength).toBe(3072);
  });

  test('rejects a 302 instead of following it', async () => {
    const err = await rejectionOf(boundedFetch({ maxBytes: 100 })(`${origin}/redirect`));
    expect(err).toBeInstanceOf(Error);
  });

  test('the test hook replaces the network but keeps redirect rejection and the cap', async () => {
    const inits: (RequestInit | undefined)[] = [];
    setTextFetchForTests((_input, init) => {
      inits.push(init);
      return Promise.resolve(new Response('x'.repeat(50)));
    });
    const res = await boundedFetch({ maxBytes: 10 })('http://provider.invalid/v1/chat/completions', {
      method: 'POST',
      redirect: 'follow',
    });
    expect(inits[0]?.redirect).toBe('error');
    expect(inits[0]?.method).toBe('POST');
    expect(await rejectionOf(res.text())).toBeInstanceOf(TextResponseTooLargeError);
  });
});
