import { afterEach, expect, test } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callStorage } from './storage';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-control-'));
  cleanup.push(() => { rmSync(dir, { recursive: true, force: true }); });
  return join(dir, 'control.sock');
}

for (const path of ['/status', '/unseal']) {
  for (const phase of ['headers', 'body']) {
    test(`${path} deadline aborts stalled ${phase}`, async () => {
      const socket = socketPath();
      let finish: () => void = () => undefined;
      let entered = false;
      let requests = 0;
      const server = Bun.serve({
        unix: socket,
        async fetch(req) {
          requests += 1;
          expect(new URL(req.url).pathname).toBe(path);
          if (path === '/unseal') expect(await req.text()).toBe('synthetic-test-identity');
          entered = true;
          if (phase === 'headers') return new Promise<Response>((resolve) => {
            finish = () => { resolve(Response.json({ sealed: true })); };
          });
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"sealed":'));
              finish = () => { try { controller.close(); } catch { /* Already canceled. */ } };
            },
          }));
        },
      });
      cleanup.push(async () => { finish(); await server.stop(true); });
      const started = performance.now();
      await rejects(callStorage(path, path === '/unseal' ? { method: 'POST', body: 'synthetic-test-identity' } : {}, {
        socket, deadlineMs: 100, retryDelayMs: 5,
      }), { name: 'TimeoutError' });
      expect(entered).toBe(true);
      expect(requests).toBe(1);
      expect(performance.now() - started).toBeLessThan(1_000);
    });
  }
}

test('retry deadline interrupts a long retry sleep when the socket is absent', async () => {
  const started = performance.now();
  await rejects(callStorage('/status', {}, {
    socket: socketPath(), deadlineMs: 40, retryDelayMs: 10_000,
  }), { name: 'TimeoutError' });
  expect(performance.now() - started).toBeLessThan(1_000);
});

test('a socket that starts within the shared retry budget completes normally', async () => {
  const socket = socketPath();
  const start = setTimeout(() => {
    const server = Bun.serve({ unix: socket, fetch: () => Response.json({ sealed: true }) });
    cleanup.push(async () => { await server.stop(true); });
  }, 20);
  cleanup.push(() => { clearTimeout(start); });
  expect(await callStorage('/status', {}, { socket, deadlineMs: 1_000, retryDelayMs: 5 }))
    .toEqual({ ok: true, status: 200, body: '{"sealed":true}' });
});

test('verify can outlive the control deadline and is sent once', async () => {
  const socket = socketPath();
  let requests = 0;
  const server = Bun.serve({
    unix: socket,
    async fetch() {
      requests += 1;
      await Bun.sleep(60);
      return Response.json({ summary: { userKeyFailures: 0, failures: 0, missing: 0 } });
    },
  });
  cleanup.push(async () => { await server.stop(true); });
  const result = await callStorage('/verify', { method: 'POST' }, { socket, retry: false, deadlineMs: 5 });
  expect(result.ok).toBe(true);
  expect(requests).toBe(1);
});

test('verify transport failure is never replayed', async () => {
  const started = performance.now();
  await rejects(callStorage('/verify', { method: 'POST' }, {
    socket: socketPath(), retry: false, deadlineMs: 10_000, retryDelayMs: 10_000,
  }), Error);
  expect(performance.now() - started).toBeLessThan(1_000);
});
