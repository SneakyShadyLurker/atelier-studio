import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setTextModelProviderForTests } from '../providers/text/registry';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { resetLlmAdmissionForTests } from '../orchestrator/llmAdmission';
import {
  type EnhanceChunk,
  type EnhanceImageInput,
  type TestTextFeatureProvider,
} from '../providers/text/featureHelpers';
import { writeAtomic } from '../storage/files';
import { parseSse, restoreFetch, testRuntime, legacyTextUpstreamIds } from '../test/helpers';
import { EnhancePromptRequestSchema } from './enhance.schema';

const TEXT_MODELS = legacyTextUpstreamIds();

const VIDEO_ON = {
  seedLegacyText: true,
  COMFYUI_BASE_URL: 'http://127.0.0.1:1',
  VIDEO_MODELS_ENABLED: 'true',
  LOCAL_MODELS_USERS: 'test',
};
const PREVIOUS_MOTION_PROMPT = `integrated_multimodal_description: [Shot 1] A green-eyed adult woman with long black hair turns toward the window.
overall_soundscape: Rain taps steadily against the glass.
non_diegetic_music: Low cello notes sustain.`;

interface Capture {
  images?: readonly EnhanceImageInput[];
  systemPrompt?: string | undefined;
}

function stub(capture: Capture): TestTextFeatureProvider {
  return {
    async *enhance(_prompt, images, _signal, systemPrompt) {
      capture.images = images;
      capture.systemPrompt = systemPrompt;
      await Promise.resolve();
      yield { type: 'delta', text: 'continued motion' } satisfies EnhanceChunk;
      yield { type: 'done' } satisfies EnhanceChunk;
    },
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: 'x' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'x' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'x' }),
  };
}

function post(app: ReturnType<typeof testRuntime>['app'], body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(app.fetch(new Request('http://local/api/enhance-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Remote-User': 'test' },
    body: JSON.stringify(body),
  })));
}

async function seedHandoffUpload(
  runtime: ReturnType<typeof testRuntime>,
  bytes: Uint8Array,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  runtime.db.query('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run('test', now);
  runtime.db.query(
    "INSERT INTO uploads (id, user_id, ext, mime, size_bytes, width, height, sha256, created_at) VALUES (?, 'test', 'png', 'image/png', ?, 2, 2, ?, ?)",
  ).run(id, bytes.byteLength, `sha-${id}`, now);
  await writeAtomic(runtime.config.DATA_DIR, 'uploads', 'test', id, 'png', bytes);
  return id;
}

async function validPng(): Promise<Uint8Array> {
  const png = await (await import('sharp')).default({
    create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } },
  }).png().toBuffer();
  return new Uint8Array(png);
}

describe('EnhancePromptRequestSchema motion extend context', () => {
  test('accepts a complete extendContext', () => {
    const result = EnhancePromptRequestSchema.safeParse({
      prompt: 'keep turning',
      extendContext: {
        previousMotionPrompt: PREVIOUS_MOTION_PROMPT,
        handoffUploadId: crypto.randomUUID(),
      },
    });
    expect(result.success).toBe(true);
  });

  test('rejects partial, blank, oversized, and malformed extendContext values', () => {
    const validId = crypto.randomUUID();
    const invalid = [
      { previousMotionPrompt: PREVIOUS_MOTION_PROMPT },
      { handoffUploadId: validId },
      { previousMotionPrompt: '   ', handoffUploadId: validId },
      { previousMotionPrompt: 'x'.repeat(MAX_PROMPT_CHARS + 1), handoffUploadId: validId },
      { previousMotionPrompt: PREVIOUS_MOTION_PROMPT, handoffUploadId: 'not-a-uuid' },
    ];
    for (const extendContext of invalid) {
      expect(EnhancePromptRequestSchema.safeParse({ prompt: 'keep turning', extendContext }).success).toBe(false);
    }
  });
});

describe('enhance-prompt h3-motion extend branch', () => {
  beforeEach(() => {
    restoreFetch();
  });
  afterEach(() => {
    restoreFetch();
    resetLlmAdmissionForTests();
    setTextModelProviderForTests(null);
  });

  test('Kimi receives the handoff image and previous motion prompt', async () => {
    const capture: Capture = {};
    setTextModelProviderForTests(stub(capture));
    const runtime = testRuntime(VIDEO_ON);
    const handoffUploadId = await seedHandoffUpload(runtime, await validPng());

    const events = await parseSse(await post(runtime.app, {
      prompt: 'keep turning toward the window',
      modelId: 'minimax-h3-i2v',
      sourcePrompt: 'a 21-year-old woman in a red dress',
      extendContext: { previousMotionPrompt: PREVIOUS_MOTION_PROMPT, handoffUploadId },
    }));

    expect(events.at(-1)?.event).toBe('done');
    expect(capture.images).toHaveLength(1);
    expect(capture.images?.[0]?.mime).toBe('image/jpeg');
    expect(capture.systemPrompt).toContain(PREVIOUS_MOTION_PROMPT);
    expect(capture.systemPrompt).not.toContain('<root_authority priority="absolute">');
  });

  test('motion extend sends the handoff image to Kimi upstream', async () => {
    let capturedBody: Record<string, unknown> = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      const frame = JSON.stringify({
        choices: [{ index: 0, delta: { content: 'continued motion' }, finish_reason: 'stop' }],
      });
      return Promise.resolve(new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }) as typeof fetch;
    setTextModelProviderForTests(null);
    const runtime = testRuntime({ ...VIDEO_ON, CLIPROXY_TOKEN: 'sk-test' });
    const handoffUploadId = await seedHandoffUpload(runtime, await validPng());

    try {
      const events = await parseSse(await post(runtime.app, {
        prompt: 'keep turning toward the window',
        modelId: 'minimax-h3-i2v',
        sourcePrompt: 'a 21-year-old woman in a red dress',
        extendContext: { previousMotionPrompt: PREVIOUS_MOTION_PROMPT, handoffUploadId },
      }));
      expect(events.at(-1)?.event).toBe('done');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(capturedBody.model).toBe(TEXT_MODELS.kimi);
    const userContent = (capturedBody.messages as { role: string; content: unknown }[])
      .find((message) => message.role === 'user')?.content;
    expect(userContent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_url' }),
    ]));
  });

  test('the handoff image always reaches Kimi on extend', async () => {
    const capture: Capture = {};
    setTextModelProviderForTests(stub(capture));
    const runtime = testRuntime(VIDEO_ON);
    const handoffUploadId = await seedHandoffUpload(runtime, await validPng());

    const events = await parseSse(await post(runtime.app, {
      prompt: 'keep turning toward the window',
      modelId: 'minimax-h3-i2v',
      sourcePrompt: 'a dancer in a red dress',
      extendContext: { previousMotionPrompt: PREVIOUS_MOTION_PROMPT, handoffUploadId },
    }));

    expect(events.at(-1)?.event).toBe('done');
    expect(capture.images).toHaveLength(1);
    expect(capture.systemPrompt).toContain(PREVIOUS_MOTION_PROMPT);
    expect(capture.systemPrompt).not.toContain('<root_authority priority="absolute">');
  });

  test('an unreadable Kimi handoff degrades to text-only context', async () => {
    const capture: Capture = {};
    setTextModelProviderForTests(stub(capture));
    const runtime = testRuntime({ ...VIDEO_ON, LOG_LEVEL: 'info' });
    const handoffUploadId = await seedHandoffUpload(runtime, new Uint8Array([0, 1, 2, 3]));

    const events = await parseSse(await post(runtime.app, {
      prompt: 'keep turning toward the window',
      modelId: 'minimax-h3-i2v',
      sourcePrompt: 'a 21-year-old woman in a red dress',
      extendContext: { previousMotionPrompt: PREVIOUS_MOTION_PROMPT, handoffUploadId },
    }));

    expect(events.at(-1)?.event).toBe('done');
    expect(capture.images).toHaveLength(0);
    expect(capture.systemPrompt).toContain(PREVIOUS_MOTION_PROMPT);
    expect(runtime.logs.join('\n')).toContain('motion_extend_handoff_unreadable');
  });
});
