import { afterEach, beforeEach, expect, test } from 'bun:test';
import { restoreFetch, testRuntime } from '../test/helpers';
import * as queue from '../orchestrator/queue';
import {
  configureUpstreamGate,
  noteBreakerState,
  resetUpstreamGateForTests,
} from '../orchestrator/upstreamGate';

beforeEach(() => {
  restoreFetch();
  queue.resetQueueForTests();
});

afterEach(() => {
  restoreFetch();
  resetUpstreamGateForTests();
});

function generateRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request('http://local/api/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Remote-User': 'alice',
    },
    body: JSON.stringify({
      modelId: 'gpt-image-2.5-sunburst',
      prompt: 'a test image',
      ratio: '1:1',
      count: 1,
      ...overrides,
    }),
  });
}

test('a batched local count above COMFYUI_BATCH_MAX is rejected server-side', async () => {
  const availability = new Map([['krea-2-gonzalomo', { ok: true as const, checkedAt: 1 }]]);
  const { app } = testRuntime({ availability, COMFYUI_BATCH_MAX: '2', LOCAL_MODELS_USERS: 'alice' });
  const res = await app.fetch(generateRequest({ modelId: 'krea-2-gonzalomo', count: 3 }));
  expect(res.status).toBe(400);
  expect((await res.json() as Record<string, unknown>).code).toBe('COUNT_EXCEEDS_POOL');
});

test('paused shared pool enqueues even when slots are free', async () => {
  configureUpstreamGate({
    kickPool: () => undefined,
    failQueued: () => undefined,
    halfOpenAfterMs: 60_000,
    maxPauseMs: 600_000,
    threshold: 5,
  });
  noteBreakerState('shared', 'open');

  const { app } = testRuntime();
  const res = await app.fetch(generateRequest());

  expect(res.status).toBe(201);
  const body = await res.json() as Record<string, unknown>;
  expect(body.status).toBe('queued');
  expect(queue.__queueTest.lengthOf('shared')).toBe(1);
});

test('a rendering story with no batch blocks manual video admission', async () => {
  const availability = new Map([['minimax-h3-t2v', { ok: true as const, checkedAt: 1 }]]);
  const { app, db } = testRuntime({ VIDEO_MODELS_ENABLED: 'true', availability, MAX_INFLIGHT_VIDEO_PER_USER: '1', LOCAL_MODELS_USERS: 'alice' });
  db.query(`INSERT INTO stories (id,user_id,status,outline,logline,continuity_bible,ratio,eta_ms,created_at,updated_at)
    VALUES ('reserved','alice','rendering','outline','logline','bible','16:9',1,1,1)`).run();
  const response = await app.fetch(generateRequest({ modelId: 'minimax-h3-t2v', ratio: '16:9', durationFrames: 124 }));
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ error: 'video generation already in progress', code: 'VIDEO_BUSY' });
  expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM batches').get()?.n).toBe(0);
});
