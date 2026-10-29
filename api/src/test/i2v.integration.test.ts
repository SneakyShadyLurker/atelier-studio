import { privateWorkerTestTls, privateWorkerTestCa, privateWorkerTestToken } from './private-worker-tls';
import { privateWorkerFixture } from './private-worker-fixture';
import { afterEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { generateEvents, testRuntime } from './helpers';
import { grayCardPng, pngBytes } from './image-fixtures';
import { writeAtomic } from '../storage/files';
import { setFfmpegRunnerForTests } from '../storage/posterFrame';
import { setLastFrameRunnerForTests } from '../storage/lastFrame';
import { setSequenceStitchRunnerForTests } from '../storage/stitchSequence';
import {
  resetStitchQueueForTests,
  waitForStitchQueueIdle,
} from '../orchestrator/stitchQueue';

interface PromptBody {
  prompt: Record<string, unknown>;
  client_id: string;
  prompt_id: string;
}

interface WsCtx {
  clientId: string;
}

interface VideoMockServer {
  baseUrl: string;
  uploadedBytes: Uint8Array | undefined;
  lastOutputPath: string | undefined;
  stop: () => Promise<void>;
}

const servers: { stop: () => Promise<void> }[] = [];
const sourceBytes = pngBytes();
const mp4Bytes = new Uint8Array([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x00,
]);

afterEach(async () => {
  await waitForStitchQueueIdle();
  resetStitchQueueForTests();
  setFfmpegRunnerForTests(null);
  setLastFrameRunnerForTests(null);
  setSequenceStitchRunnerForTests(null);
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function startVideoMock(): VideoMockServer {
  const sockets = new Map<string, ServerWebSocket<WsCtx>>();
  const worker = privateWorkerFixture();
  const state: {
    uploadedBytes: Uint8Array | undefined;
    lastOutputPath: string | undefined;
  } = {
    uploadedBytes: undefined,
    lastOutputPath: undefined,
  };

  const server = Bun.serve<WsCtx>({
    port: 0,
    tls: privateWorkerTestTls,
    idleTimeout: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname.includes('/outputs/')) state.lastOutputPath = url.pathname;
      const handled = worker.handle(req);
      if (handled) return handled;
      if (url.pathname === '/ws') {
        const clientId = url.searchParams.get('clientId') ?? '';
        if (srv.upgrade(req, { data: { clientId } })) return undefined;
        return new Response('upgrade required', { status: 426 });
      }
      if (url.pathname.includes('/inputs/') && req.method === 'PUT') {
        state.uploadedBytes = new Uint8Array(await req.arrayBuffer());
        return Response.json({ ok: true });
      }
      if (url.pathname === '/prompt' && req.method === 'POST') {
        const body = (await req.json()) as PromptBody;
        const promptId = body.prompt_id;
        setTimeout(() => {
          worker.complete(promptId, [mp4Bytes], 'video/mp4');
          const ws = sockets.get(body.client_id);
          ws?.send(JSON.stringify({
            type: 'progress',
            data: { node: '11', prompt_id: promptId, value: 3, max: 12 },
          }));
          ws?.send(JSON.stringify({
            type: 'executed',
            data: {
              node: '15',
              display_node: '15',
              prompt_id: promptId,
              output: { gifs: [{ filename: 'abcddcba-1234-4321-8123-123456789abc', subfolder: promptId, type: 'atelier-memory' }] },
            },
          }));
        }, 5);
        return Response.json({ prompt_id: promptId, number: 0, node_errors: {} });
      }
      if (url.pathname === '/queue' && req.method === 'POST') {
        return Response.json({});
      }
      if (url.pathname === '/interrupt' && req.method === 'POST') {
        return Response.json({});
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.set(ws.data.clientId, ws);
      },
      message() {
        // The provider never sends client messages in these tests.
      },
      close(ws) {
        sockets.delete(ws.data.clientId);
      },
    },
  });

  const stop = async () => {
    await Promise.race([
      server.stop(true),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
  };
  servers.push({ stop });

  return {
    baseUrl: `https://127.0.0.1:${server.port}`,
    get uploadedBytes() {
      return state.uploadedBytes;
    },
    get lastOutputPath() {
      return state.lastOutputPath;
    },
    stop,
  };
}

async function seedSourceUpload(runtime: ReturnType<typeof testRuntime>, userId: string): Promise<string> {
  const uploadId = crypto.randomUUID();
  const now = Date.now();
  runtime.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  runtime.db.query(
    "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, ?, 'png', 'image/png', ?, 64, 64, ?, ?)",
  ).run(uploadId, userId, sourceBytes.byteLength, `sha-${uploadId}`, now);
  await writeAtomic(runtime.config.DATA_DIR, 'uploads', userId, uploadId, 'png', sourceBytes);
  return uploadId;
}

async function seedStandaloneVideo(
  runtime: ReturnType<typeof testRuntime>,
  userId: string,
): Promise<string> {
  const batchId = crypto.randomUUID();
  const tileId = crypto.randomUUID();
  const now = Date.now();
  runtime.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, now);
  runtime.db.query(
    `INSERT INTO batches
      (id, user_id, prompt, ratio, model_id, model_label, created_at, status, pool, duration_frames)
     VALUES (?, ?, 'opening shot', '16:9', 'minimax-h3-i2v', 'MiniMax H3', ?, 'done', 'local', 124)`,
  ).run(batchId, userId, now);
  runtime.db.query(
    `INSERT INTO tiles
      (id, batch_id, user_id, tile_index, seed, status, ext, mime, completed_at)
     VALUES (?, ?, ?, 0, 1, 'done', 'mp4', 'video/mp4', ?)`,
  ).run(tileId, batchId, userId, now);
  await writeAtomic(runtime.config.DATA_DIR, 'images', userId, tileId, 'mp4', mp4Bytes);
  return tileId;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('i2v full-stack integration', () => {
  test('handoff, linked submit, segment success, stitch, and master serving converge through history', async () => {
    const mock = startVideoMock();
    const runtime = testRuntime({
      COMFYUI_BASE_URL: mock.baseUrl,
      COMFYUI_ATELIER_TOKEN: privateWorkerTestToken,
      COMFYUI_ATELIER_CA: privateWorkerTestCa,
      VIDEO_MODELS_ENABLED: 'true',
      LOCAL_MODELS_USERS: 'alice',
      availability: new Map([
        ['minimax-h3-i2v', { ok: true as const, checkedAt: Date.now() }],
      ]),
    });
    const frame = await grayCardPng(32);
    setLastFrameRunnerForTests(() => Promise.resolve(frame));
    setFfmpegRunnerForTests(() => Promise.resolve(frame));
    let releaseStitch: () => void = () => undefined;
    let signalStitchStarted: () => void = () => undefined;
    const stitchStarted = new Promise<void>((resolve) => { signalStitchStarted = resolve; });
    const stitchGate = new Promise<void>((resolve) => { releaseStitch = resolve; });
    setSequenceStitchRunnerForTests(async () => {
      signalStitchStarted();
      await stitchGate;
      return mp4Bytes;
    });

    const sourceTileId = await seedStandaloneVideo(runtime, 'alice');
    const handoff = await runtime.app.fetch(new Request(
      `http://local/api/tiles/${sourceTileId}/handoff-frame`,
      { method: 'POST', headers: { 'Remote-User': 'alice' } },
    ));
    expect(handoff.status).toBe(200);
    const { uploadId } = await handoff.json() as { uploadId: string };
    expect(runtime.db.query<{ source_tile_id: string | null }, [string]>(
      'SELECT source_tile_id FROM uploads WHERE id = ?',
    ).get(uploadId)?.source_tile_id).toBe(sourceTileId);

    const events = await generateEvents(runtime.app, {
      prompt: 'continue the camera move',
      modelId: 'minimax-h3-i2v',
      ratio: '16:9',
      count: 1,
      i2vSourceUploadId: uploadId,
      extendsTileId: sourceTileId,
      motionPrompt: 'continue the camera move',
    }, 'alice');
    expect(events.some((event) => event.event === 'done')).toBe(true);
    await stitchStarted;

    const stitchingHistory = await runtime.app.fetch(new Request('http://local/api/history', {
      headers: { 'Remote-User': 'alice' },
    }));
    const stitching = await stitchingHistory.json() as {
      items: { sequence?: { id: string; masterStatus: string } }[];
    };
    const sequence = stitching.items.find((item) => item.sequence)?.sequence;
    expect(sequence?.masterStatus).toBe('stitching');

    releaseStitch();
    await waitForStitchQueueIdle();
    const readyHistory = await runtime.app.fetch(new Request('http://local/api/history', {
      headers: { 'Remote-User': 'alice' },
    }));
    const ready = await readyHistory.json() as {
      items: { sequence?: { id: string; masterStatus: string } }[];
    };
    expect(ready.items.find((item) => item.sequence?.id === sequence?.id)?.sequence?.masterStatus)
      .toBe('ready');
    const master = await runtime.app.fetch(new Request(
      `http://local/api/sequences/${sequence?.id ?? ''}/master`,
      { headers: { 'Remote-User': 'alice' } },
    ));
    expect(master.status).toBe(200);
    expect(new Uint8Array(await master.arrayBuffer())).toEqual(mp4Bytes);
  });

  test('reveals H3 behind the video flag and persists a mocked mp4 generation into history', async () => {
    const mock = startVideoMock();
    const runtime = testRuntime({
      COMFYUI_BASE_URL: mock.baseUrl,
      COMFYUI_ATELIER_TOKEN: privateWorkerTestToken,
      COMFYUI_ATELIER_CA: privateWorkerTestCa,
      VIDEO_MODELS_ENABLED: 'true',
      LOCAL_MODELS_USERS: 'alice',
      availability: new Map([
        ['minimax-h3-i2v', { ok: true as const, checkedAt: Date.now() }],
      ]),
    });
    const posterFrame = await grayCardPng(32);
    setFfmpegRunnerForTests(() => Promise.resolve(posterFrame));
    const uploadId = await seedSourceUpload(runtime, 'alice');

    const modelsRes = await runtime.app.fetch(new Request('http://local/api/models', {
      headers: { 'Remote-User': 'alice' },
    }));
    expect(modelsRes.status).toBe(200);
    const models = (await modelsRes.json()) as { id: string; supportsI2V?: boolean }[];
    expect(models.find((model) => model.id === 'minimax-h3-i2v')).toMatchObject({ supportsI2V: true });

    const events = await generateEvents(runtime.app, {
      prompt: 'animate the source still',
      modelId: 'minimax-h3-i2v',
      ratio: '16:9',
      count: 1,
      i2vSourceUploadId: uploadId,
      motionPrompt: 'slow cinematic push in',
    }, 'alice');

    expect(mock.uploadedBytes).toEqual(sourceBytes);
    expect(mock.lastOutputPath).toMatch(/^\/atelier\/v1\/jobs\/[0-9a-f-]{36}\/outputs\/[0-9a-f-]{36}$/);
    const progressIndex = events.findIndex((event) =>
      event.event === 'tile' && isObject(event.data) && event.data.status === 'progress'
    );
    const doneIndex = events.findIndex((event) =>
      event.event === 'tile' && isObject(event.data) && event.data.status === 'done'
    );
    expect(progressIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(progressIndex);
    expect(events[doneIndex]?.data).toMatchObject({
      status: 'done',
      ext: 'mp4',
      mime: 'video/mp4',
    });

    const historyRes = await runtime.app.fetch(new Request('http://local/api/history', {
      headers: { 'Remote-User': 'alice' },
    }));
    expect(historyRes.status).toBe(200);
    const history = (await historyRes.json()) as {
      items: { modelId: string; tiles: { status: string; mime?: string; thumbUrl?: string }[] }[];
    };
    const batch = history.items.find((item) => item.modelId === 'minimax-h3-i2v');
    expect(batch?.tiles[0]).toMatchObject({
      status: 'done',
      mime: 'video/mp4',
    });
    expect(batch?.tiles[0]?.thumbUrl).toContain('/thumb');
  });

  test('T2V generates a video from a bare prompt — no source upload involved', async () => {
    const mock = startVideoMock();
    const runtime = testRuntime({
      COMFYUI_BASE_URL: mock.baseUrl,
      COMFYUI_ATELIER_TOKEN: privateWorkerTestToken,
      COMFYUI_ATELIER_CA: privateWorkerTestCa,
      VIDEO_MODELS_ENABLED: 'true',
      LOCAL_MODELS_USERS: 'alice',
      availability: new Map([
        ['minimax-h3-t2v', { ok: true as const, checkedAt: Date.now() }],
      ]),
    });
    const posterFrame = await grayCardPng(32);
    setFfmpegRunnerForTests(() => Promise.resolve(posterFrame));

    const modelsRes = await runtime.app.fetch(new Request('http://local/api/models', {
      headers: { 'Remote-User': 'alice' },
    }));
    const models = (await modelsRes.json()) as { id: string; supportsI2V?: boolean; outputsVideo?: boolean }[];
    const t2v = models.find((model) => model.id === 'minimax-h3-t2v');
    expect(t2v).toMatchObject({ outputsVideo: true });
    expect(t2v?.supportsI2V).toBeUndefined();

    const events = await generateEvents(runtime.app, {
      prompt: 'a slow pan over a foggy harbor at dawn',
      modelId: 'minimax-h3-t2v',
      ratio: '16:9',
      count: 1,
    }, 'alice');

    // No source still is ever uploaded to ComfyUI on the T2V path.
    expect(mock.uploadedBytes).toBeUndefined();
    expect(mock.lastOutputPath).toMatch(/^\/atelier\/v1\/jobs\/[0-9a-f-]{36}\/outputs\/[0-9a-f-]{36}$/);
    const doneEvent = events.find((event) =>
      event.event === 'tile' && isObject(event.data) && event.data.status === 'done'
    );
    expect(doneEvent?.data).toMatchObject({
      status: 'done',
      ext: 'mp4',
      mime: 'video/mp4',
    });
  });
});
