import { afterEach, describe, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { testRuntime } from '../test/helpers';
import { pngBytes } from '../test/image-fixtures';
import { MAX_UPLOAD_REQUEST_BYTES } from './uploads';
import {
  MAX_CONCURRENT_UPLOADS,
  MAX_CONCURRENT_UPLOADS_PER_USER,
  MAX_PENDING_UPLOADS,
  MAX_PENDING_UPLOADS_PER_USER,
  resetUploadsRuntimeForTests,
  withUploadSlot,
} from './uploads-runtime';
import { setHeicShimConfigForTests } from '../storage/heicDecode';

afterEach(() => {
  resetUploadsRuntimeForTests();
  setHeicShimConfigForTests(null);
});

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function holdSlots(users: string[]) {
  const gates = users.map(() => deferred());
  const entered = users.map(() => deferred());
  const runs = users.map((user, index) => withUploadSlot(user, async () => {
    entered[index]?.resolve();
    await gates[index]?.promise;
  }));
  await Promise.all(entered.map((gate) => gate.promise));
  return {
    async release() {
      for (const gate of gates) gate.resolve();
      await Promise.all(runs);
    },
  };
}

function streamedRequest(options: {
  userId?: string;
  signal?: AbortSignal;
  chunk?: Uint8Array;
  stall?: boolean;
  contentLength?: number;
} = {}) {
  let reads = 0;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull(value) {
      reads += 1;
      if (options.stall) return;
      value.enqueue(options.chunk ?? new TextEncoder().encode('--test-boundary--\r\n'));
      value.close();
    },
  }, { highWaterMark: 0 });
  const headers = new Headers({
    'Remote-User': options.userId ?? 'alice',
    'Content-Type': 'multipart/form-data; boundary=test-boundary',
  });
  if (options.contentLength !== undefined) headers.set('Content-Length', String(options.contentLength));
  return {
    request: new Request('http://local/api/uploads', {
      method: 'POST', headers, body: stream,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
    reads: () => reads,
    close: () => {
      controller.enqueue(new TextEncoder().encode('--test-boundary--\r\n'));
      controller.close();
    },
    error: (error: Error) => { controller.error(error); },
  };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('upload did not progress');
    await Bun.sleep(5);
  }
}

async function assertReleasedCapacity(app: ReturnType<typeof testRuntime>['app']) {
  // Both per-user slots must be available, and a third request must stay queued.
  // This catches leaks and double releases without inspecting internal counters.
  const bodies = Array.from({ length: 3 }, () => streamedRequest({ stall: true }));
  const runs = bodies.map((body) => Promise.resolve(app.fetch(body.request)));
  const [firstBody, secondBody, queuedBody] = bodies;
  const [firstRun] = runs;
  try {
    if (!firstBody || !secondBody || !queuedBody || !firstRun) throw new Error('capacity fixtures missing');
    await until(() => firstBody.reads() === 1 && secondBody.reads() === 1);
    expect(queuedBody.reads()).toBe(0);
    firstBody.close();
    expect((await firstRun).status).toBe(400);
    await until(() => queuedBody.reads() === 1);
  } finally {
    for (const body of bodies) {
      try { body.close(); } catch { /* already closed */ }
    }
    await Promise.all(runs);
  }
  // The global four-slot pool must also still admit exactly its full capacity.
  const held = await holdSlots(Array.from({ length: MAX_CONCURRENT_UPLOADS }, (_, index) => `capacity-${index}`));
  const body = streamedRequest({ userId: 'global-capacity' });
  const run = app.fetch(body.request);
  try {
    await Bun.sleep(10);
    expect(body.reads()).toBe(0);
  } finally {
    await held.release();
    expect((await run).status).toBe(400);
  }
}

describe('upload body admission', () => {
  test('keeps queued and rejected no-length bodies unread while both user slots are occupied', async () => {
    const { app } = testRuntime();
    const held = await holdSlots(Array.from({ length: MAX_CONCURRENT_UPLOADS_PER_USER }, () => 'alice'));
    const bodies = Array.from({ length: MAX_PENDING_UPLOADS_PER_USER + 1 }, () => streamedRequest());
    const runs = bodies.map((body) => Promise.resolve(app.fetch(body.request)));
    try {
      const rejectedRun = runs.at(-1);
      if (!rejectedRun) throw new Error('overflow request missing');
      const rejected = await rejectedRun;
      expect(rejected.status).toBe(503);
      expect(rejected.headers.get('Retry-After')).toBe('5');
      expect(bodies.map((body) => body.reads())).toEqual(bodies.map(() => 0));
    } finally {
      await held.release();
      await Promise.all(runs);
    }
    expect(bodies.slice(0, -1).every((body) => body.reads() > 0)).toBe(true);
    const rejectedBody = bodies.at(-1);
    if (!rejectedBody) throw new Error('overflow body missing');
    expect(rejectedBody.reads()).toBe(0);
  });

  test('keeps global-pool waiters and overflow unread across distinct users', async () => {
    const { app } = testRuntime();
    const held = await holdSlots(Array.from({ length: MAX_CONCURRENT_UPLOADS }, (_, index) => `held-${index}`));
    const bodies = Array.from({ length: MAX_PENDING_UPLOADS + 1 }, (_, index) => streamedRequest({ userId: `waiting-${index}` }));
    const runs = bodies.map((body) => Promise.resolve(app.fetch(body.request)));
    try {
      const rejectedRun = runs.at(-1);
      if (!rejectedRun) throw new Error('overflow request missing');
      expect((await rejectedRun).status).toBe(503);
      expect(bodies.every((body) => body.reads() === 0)).toBe(true);
    } finally {
      await held.release();
      await Promise.all(runs);
    }
    expect(bodies.slice(0, -1).every((body) => body.reads() > 0)).toBe(true);
  });

  test('consumes an admitted chunked upload and preserves its successful response', async () => {
    const { app } = testRuntime();
    const png = pngBytes();
    const head = new TextEncoder().encode('--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="ref.png"\r\nContent-Type: image/png\r\n\r\n');
    const tail = new TextEncoder().encode('\r\n--test-boundary--\r\n');
    const chunk = new Uint8Array(head.length + png.length + tail.length);
    chunk.set(head); chunk.set(png, head.length); chunk.set(tail, head.length + png.length);
    const body = streamedRequest({ chunk });
    const response = await app.fetch(body.request);
    expect(body.reads()).toBe(1);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ext: 'png', mime: 'image/png' });
    await assertReleasedCapacity(app);
  });

  test('preserves 413 and releases capacity after an oversized streamed body', async () => {
    const { app } = testRuntime();
    const body = streamedRequest({ chunk: new Uint8Array(MAX_UPLOAD_REQUEST_BYTES + 1) });
    expect((await app.fetch(body.request)).status).toBe(413);
    expect(body.reads()).toBe(1);
    await assertReleasedCapacity(app);
  });

  test('preserves a Content-Length 413 without reading and releases capacity', async () => {
    const { app } = testRuntime();
    const body = streamedRequest({ contentLength: MAX_UPLOAD_REQUEST_BYTES + 1 });
    expect((await app.fetch(body.request)).status).toBe(413);
    expect(body.reads()).toBe(0);
    await assertReleasedCapacity(app);
  });

  test('releases capacity when the body reader throws', async () => {
    const { app } = testRuntime();
    const body = streamedRequest({ stall: true });
    const run = app.fetch(body.request);
    await until(() => body.reads() === 1);
    body.error(new Error('body read failed'));
    expect((await run).status).toBe(500);
    await assertReleasedCapacity(app);
  });

  test('returns 499 for queued cancellation without reading the body', async () => {
    const { app } = testRuntime();
    const held = await holdSlots(Array.from({ length: MAX_CONCURRENT_UPLOADS_PER_USER }, () => 'alice'));
    const ac = new AbortController();
    const body = streamedRequest({ signal: ac.signal });
    const run = app.fetch(body.request);
    try {
      await Bun.sleep(10);
      ac.abort();
      expect((await run).status).toBe(499);
      expect(body.reads()).toBe(0);
    } finally {
      await held.release();
    }
    await assertReleasedCapacity(app);
  });

  test('returns 499 and releases capacity when an active body read is aborted', async () => {
    const { app } = testRuntime();
    const ac = new AbortController();
    const body = streamedRequest({ signal: ac.signal, stall: true });
    const run = app.fetch(body.request);
    await until(() => body.reads() === 1);
    ac.abort();
    body.error(new DOMException('aborted', 'AbortError'));
    expect((await run).status).toBe(499);
    await assertReleasedCapacity(app);
  });

  test('maps numbered HEIC decoder output to a sanitized 400 and removes scratch', async () => {
    const { app } = testRuntime();
    let directory = '';
    setHeicShimConfigForTests({ command: (input, output) => {
      directory = dirname(input);
      return [process.execPath, '-e', `
        const fs = require('node:fs');
        const output = process.argv.at(-1);
        fs.writeFileSync(output.replace('.png', '-1.png'), 'first');
        fs.writeFileSync(output.replace('.png', '-2.png'), 'second');
      `, output];
    } });
    const form = new FormData();
    form.set('file', new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99, 0, 0, 0, 0])], 'ref.heic'));
    const response = await app.fetch(new Request('http://local/api/uploads', {
      method: 'POST', headers: { 'Remote-User': 'alice' }, body: form,
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unsupported image' });
    expect(directory).not.toBe('');
    expect(existsSync(directory)).toBe(false);
    await assertReleasedCapacity(app);
  });
});
