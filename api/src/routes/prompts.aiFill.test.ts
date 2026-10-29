import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { allowJevForProviderTests, resetJevForProviderTests } from '../test/jev-fixture';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import {
  AI_FILL_FIELD_SEPARATOR,
  AI_FILL_RECORD_SEPARATOR,
} from '@atelier/shared/ai-fill';
import { setCliproxyTextProviderForTests, type AiFillResult, type TestCliproxyTextProvider } from '../providers/cliproxyText';
import type { AiFillProviderInput } from '../providers/cliproxyText';
import { parseSseText, testRuntime } from '../test/helpers';
import { enhancePool, resetLlmAdmissionForTests } from '../orchestrator/llmAdmission';
import { KREA_PROMPT_WORD_BUDGET } from '../prompts/promptBudget';
import { writeTextBackendOverride } from '../routing/textBackendPreference';


beforeEach(allowJevForProviderTests);
afterEach(() => {
  resetJevForProviderTests();
  setCliproxyTextProviderForTests(null);
  resetLlmAdmissionForTests();
});

async function* emptyEnhance(): AsyncGenerator<never, void, unknown> {
  await Promise.resolve();
  if (Date.now() < 0) yield undefined as never;
}

function fakeProvider(aiFill: (input: AiFillProviderInput) => Promise<AiFillResult>): TestCliproxyTextProvider {
  return {
    enhance: emptyEnhance,
    draftList: () => Promise.resolve({ type: 'failed', status: null, detail: '' }),
    draftTemplate: () => Promise.resolve({ type: 'failed', status: null, detail: 'not implemented' }),
    inferDimensions: () => Promise.resolve({ type: 'ok', ops: [] }),
    inferDimensionsSingleAttempt: () => Promise.resolve({ type: 'ok', ops: [] }),
    rescueDimension: () => Promise.resolve({ type: 'failed', kind: 'permanent', status: null, detail: 'x' }),
    aiFill,
  };
}

const BODY = {
  staticSegments: ['A woman, ', ', golden hour.'],
  instructions: ['her swimsuit'],
  modelId: 'gpt-image-2.5-sunburst',
};

function frameData(frames: { event: string; data: unknown }[], event: string): Record<string, unknown> {
  const f = frames.find((x) => x.event === event);
  if (!f) throw new Error(`no ${event} frame`);
  return f.data as Record<string, unknown>;
}

function postAiFill(body: unknown, userId = 'alice') {
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  return app.fetch(new Request('http://local/api/prompts/ai-fill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Remote-User': userId },
    body: JSON.stringify(body),
  }));
}

function postAiFillBatch(body: unknown, userId = 'alice') {
  const { app } = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
  return app.fetch(new Request('http://local/api/prompts/ai-fill/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Remote-User': userId },
    body: JSON.stringify(body),
  }));
}

describe('POST /api/prompts/ai-fill', () => {
  test('routes Krea and MOSS to Kimi and gpt-image to GPT without classification', async () => {
    const seen: AiFillProviderInput[] = [];
    setCliproxyTextProviderForTests(fakeProvider((input) => {
      seen.push(input);
      return Promise.resolve({ type: 'ok', text: 'a red high-cut bikini' });
    }));

    const flashFrames = parseSseText(await (await postAiFill({
      ...BODY,
      modelId: 'krea-2-gonzalomo',
      staticSegments: ['A lone figure, ', ', golden hour.'],
    })).text());
    const flashBackendIndex = flashFrames.findIndex((frame) => frame.event === 'backend');
    const flashResultIndex = flashFrames.findIndex((frame) => frame.event === 'result');
    expect(flashFrames[0]?.event).toBe('backend');
    expect(frameData(flashFrames, 'backend').backend).toBe('kimi');
    expect(flashBackendIndex).toBeGreaterThanOrEqual(0);
    expect(flashResultIndex).toBeGreaterThan(flashBackendIndex);

    const gptFrames = parseSseText(await (await postAiFill({
      ...BODY,
      staticSegments: ['A 25-year-old woman, ', ', golden hour.'],
    })).text());
    const gptBackendIndex = gptFrames.findIndex((frame) => frame.event === 'backend');
    const gptResultIndex = gptFrames.findIndex((frame) => frame.event === 'result');
    expect(gptFrames[0]?.event).toBe('backend');
    expect(frameData(gptFrames, 'backend').backend).toBe('gpt');
    expect(gptBackendIndex).toBeGreaterThanOrEqual(0);
    expect(gptResultIndex).toBeGreaterThan(gptBackendIndex);

    const mossFrames = parseSseText(await (await postAiFill({
      ...BODY,
      modelId: 'moss-image-sft',
      staticSegments: ['A lone figure, ', ', golden hour.'],
    })).text());
    expect(frameData(mossFrames, 'backend').backend).toBe('kimi');
    // Kimi takes the Kimi-tuned body on Krea and MOSS too.
    expect(seen[0]?.systemPrompt).toContain("Atelier's Kimi K3 image-prompt compiler");
    expect(seen[2]?.systemPrompt).toContain("Atelier's Kimi K3 image-prompt compiler");
  });

  test('a grok override selects the Grok backend frame', async () => {
    const seen: AiFillProviderInput[] = [];
    setCliproxyTextProviderForTests(fakeProvider((input) => {
      seen.push(input);
      return Promise.resolve({ type: 'ok', text: 'a red high-cut bikini' });
    }));
    const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    writeTextBackendOverride(runtime.db, 'alice', 'ai-fill', 'grok');
    const frames = parseSseText(await (await runtime.app.fetch(new Request('http://local/api/prompts/ai-fill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Remote-User': 'alice' },
      body: JSON.stringify({ ...BODY, modelId: 'gemini-3-pro-image-preview' }),
    }))).text());
    expect(frameData(frames, 'backend').backend).toBe('grok');
    expect(seen).toHaveLength(1);
  });

  test('a pinned effort reaches every ai-fill call of its pin, including the format retry and batch', async () => {
    const seen: AiFillProviderInput[] = [];
    let call = 0;
    setCliproxyTextProviderForTests(fakeProvider((input) => {
      seen.push(input);
      call += 1;
      // An empty first answer forces the single route's format retry.
      return Promise.resolve({ type: 'ok', text: call === 1 ? '' : 'a red high-cut bikini' });
    }));
    const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    writeTextBackendOverride(runtime.db, 'alice', 'ai-fill', 'mimo', 'high');
    const post = (path: string, body: unknown) => runtime.app.fetch(new Request(`http://local/api/prompts/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Remote-User': 'alice' },
      body: JSON.stringify(body),
    }));
    await (await post('ai-fill', { ...BODY, modelId: 'gemini-3-pro-image-preview' })).text();
    await (await post('ai-fill/batch', {
      items: [{ staticSegments: ['First ', '.'], instructions: ['wardrobe'] }],
      modelId: 'gemini-3-pro-image-preview',
    })).text();
    // Sunburst stays fixed to GPT, so the pin and its effort do not apply.
    await (await post('ai-fill', BODY)).text();

    expect(seen.map((input) => input.reasoningEffort)).toEqual(['high', 'high', 'high', undefined]);
  });

  test('a mimo override selects the generic prompt variant', async () => {
    const seen: AiFillProviderInput[] = [];
    setCliproxyTextProviderForTests(fakeProvider((input) => {
      seen.push(input);
      return Promise.resolve({ type: 'ok', text: 'a red high-cut bikini' });
    }));
    const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice' });
    writeTextBackendOverride(runtime.db, 'alice', 'ai-fill', 'mimo');
    const frames = parseSseText(await (await runtime.app.fetch(new Request('http://local/api/prompts/ai-fill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Remote-User': 'alice' },
      body: JSON.stringify({ ...BODY, modelId: 'gemini-3-pro-image-preview' }),
    }))).text());

    expect(frameData(frames, 'backend').backend).toBe('mimo');
    expect(seen[0]?.systemPrompt).not.toContain('<root_authority priority="absolute">');
    expect(seen[0]?.systemPrompt).toContain("Atelier's image-prompt blank-filling engine");
    expect(seen[0]?.systemPrompt).not.toContain("Atelier's Kimi K3 image-prompt compiler");
  });

  test('happy path: splices the fill verbatim into the static segments', async () => {
    setCliproxyTextProviderForTests(fakeProvider(() => Promise.resolve({ type: 'ok', text: 'a red high-cut bikini' })));
    const frames = parseSseText(await (await postAiFill(BODY)).text());
    expect(frames.some((f) => f.event === 'result')).toBe(true);
    expect(frameData(frames, 'result').prompt).toBe('A woman, a red high-cut bikini, golden hour.');
  });

  test('uses the ai-fill policy envelope instead of the cloud image timeout', async () => {
    setCliproxyTextProviderForTests(fakeProvider(async () => {
      await Bun.sleep(25);
      return { type: 'ok', text: 'a red high-cut bikini' };
    }));
    const runtime = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      CLOUD_TIMEOUT_MS: '5',
    });
    const response = await runtime.app.fetch(new Request('http://local/api/prompts/ai-fill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Remote-User': 'alice' },
      body: JSON.stringify(BODY),
    }));
    const frames = parseSseText(await response.text());
    expect(frameData(frames, 'result').prompt).toBe('A woman, a red high-cut bikini, golden hour.');
  });

  test('uses the storage-derived budget unchanged off Krea and the smaller model budget on Krea', async () => {
    const seen: AiFillProviderInput[] = [];
    setCliproxyTextProviderForTests(fakeProvider((input) => {
      seen.push(input);
      return Promise.resolve({ type: 'ok', text: 'a red high-cut bikini' });
    }));

    await (await postAiFill(BODY)).text();
    await (await postAiFill({ ...BODY, modelId: 'gemini-3-pro-image-preview' })).text();
    await (await postAiFill({ ...BODY, modelId: 'krea-2-gonzalomo' })).text();

    const staticLength = BODY.staticSegments.reduce((total, segment) => total + segment.length, 0);
    const existingBudget = Math.max(8, Math.floor((MAX_PROMPT_CHARS - staticLength) / 6));
    const kreaBudget = Math.max(8, Math.floor((KREA_PROMPT_WORD_BUDGET * 6 - staticLength) / 6));
    expect(seen[0]?.systemPrompt).toContain(`${existingBudget} words per fill`);
    expect(seen[1]?.systemPrompt).toContain(`${existingBudget} words per fill`);
    expect(seen[2]?.systemPrompt).toContain(`${kreaBudget} words per fill`);
    expect(kreaBudget).toBeLessThan(existingBudget);
  });

  test('preserves the legacy prompt bytes, retry behavior, and result shape', async () => {
    const seen: AiFillProviderInput[] = [];
    setCliproxyTextProviderForTests(fakeProvider((input) => {
      seen.push(input);
      if (seen.length === 1) {
        return Promise.resolve({ type: 'ok', text: `first${AI_FILL_FIELD_SEPARATOR}second` });
      }
      return Promise.resolve({ type: 'ok', text: 'a red high-cut bikini' });
    }));
    const frames = parseSseText(await (await postAiFill(BODY)).text());
    expect(seen).toHaveLength(2);
    expect(seen[0]?.systemPrompt).toContain("Atelier's image-prompt blank-filling engine");
    expect(seen[0]?.systemPrompt).toContain('<output_contract>');
    expect(seen[1]).toEqual(seen[0]);
    expect(frameData(frames, 'result')).toEqual({
      prompt: 'A woman, a red high-cut bikini, golden hour.',
      fills: ['a red high-cut bikini'],
    });
  });

  test('count mismatch (too many fills) → error event, no result', async () => {
    setCliproxyTextProviderForTests(fakeProvider(() => Promise.resolve({ type: 'ok', text: `one${AI_FILL_FIELD_SEPARATOR}two` })));
    const frames = parseSseText(await (await postAiFill(BODY)).text());
    expect(frames.some((f) => f.event === 'result')).toBe(false);
    expect(frameData(frames, 'error').code).toBe('count-mismatch');
  });

  test('provider failure → error event with provider-error code', async () => {
    setCliproxyTextProviderForTests(fakeProvider(() => Promise.resolve({ type: 'failed', kind: 'permanent', status: 400, detail: 'x' })));
    const frames = parseSseText(await (await postAiFill(BODY)).text());
    expect(frames.find((f) => f.event === 'error')).toBeDefined();
    expect(frames.some((f) => f.event === 'result')).toBe(false);
    expect(frameData(frames, 'error').code).toBe('provider-error');
  });

  test('quota failure → error event with quota-exhausted code and retryAfterSeconds', async () => {
    setCliproxyTextProviderForTests(fakeProvider(() => Promise.resolve({ type: 'failed', kind: 'quota', status: 429, detail: 'x', retryAfterSeconds: 900 })));
    const frames = parseSseText(await (await postAiFill(BODY)).text());
    const errorFrame = frameData(frames, 'error');
    expect(errorFrame.code).toBe('quota-exhausted');
    expect(errorFrame.retryAfterSeconds).toBe(900);
    expect(errorFrame.message).toBe('Codex quota exhausted');
    expect(frames.some((f) => f.event === 'result')).toBe(false);
  });

  test('over-length assembled prompt → error event', async () => {
    const huge = 'x'.repeat(MAX_PROMPT_CHARS + 1);
    setCliproxyTextProviderForTests(fakeProvider(() => Promise.resolve({ type: 'ok', text: huge })));
    const frames = parseSseText(await (await postAiFill(BODY)).text());
    expect(frameData(frames, 'error').code).toBe('over-length');
  });

  // Verbatim from a production roll that reached the image model as prose.
  const PROD_REFUSAL = "I can't write this fill. The instructions are explicitly framed around producing "
    + 'detailed sexualized nudity for a character stated to be a seventeen-year-old teenager, and I '
    + "won't produce that regardless of the fictional framing.";

  test('a refused fill → refusal error, no result, and no retry call', async () => {
    let calls = 0;
    setCliproxyTextProviderForTests(fakeProvider(() => {
      calls += 1;
      return Promise.resolve({ type: 'ok', text: PROD_REFUSAL });
    }));
    const frames = parseSseText(await (await postAiFill(BODY)).text());
    expect(frames.some((f) => f.event === 'result')).toBe(false);
    expect(frameData(frames, 'error').code).toBe('refusal');
    expect(calls).toBe(1);
  });

  test('a refusal logs only operational counts without the prompt or instructions', async () => {
    setCliproxyTextProviderForTests(fakeProvider(() => Promise.resolve({ type: 'ok', text: PROD_REFUSAL })));
    const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', LOG_LEVEL: 'info' });
    const response = await runtime.app.fetch(new Request('http://local/api/prompts/ai-fill', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Remote-User': 'alice',
      },
      body: JSON.stringify(BODY),
    }));
    parseSseText(await response.text());
    const record = runtime.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === 'ai_fill_refusal');
    expect(record).toMatchObject({
      userId: 'alice',
      backend: 'gpt',
      modelId: 'gpt-image-2.5-sunburst',
      slot: 0,
      instructionCount: BODY.instructions.length,
      refusalChars: PROD_REFUSAL.length,
    });
    expect(runtime.logs.join('')).not.toContain(PROD_REFUSAL);
    for (const instruction of BODY.instructions) expect(runtime.logs.join('')).not.toContain(instruction);
  });

  test('a refusal that only appears on the format retry is still withheld', async () => {
    let calls = 0;
    setCliproxyTextProviderForTests(fakeProvider(() => {
      calls += 1;
      return Promise.resolve({
        type: 'ok',
        text: calls === 1 ? `one${AI_FILL_FIELD_SEPARATOR}two` : PROD_REFUSAL,
      });
    }));
    const frames = parseSseText(await (await postAiFill(BODY)).text());
    expect(frames.some((f) => f.event === 'result')).toBe(false);
    expect(frameData(frames, 'error').code).toBe('refusal');
    expect(calls).toBe(2);
  });

  test('a multi-slot refusal on the retry is logged as a refusal, not a count mismatch', async () => {
    // Pins the post-retry ordering: one refusal paragraph for two slots reads as
    // a count miss, and the mismatch return would swallow the moderation record.
    const twoSlotBody = { ...BODY, staticSegments: ['A woman, ', ' in ', '.'], instructions: ['her swimsuit', 'the setting'] };
    let calls = 0;
    setCliproxyTextProviderForTests(fakeProvider(() => {
      calls += 1;
      return Promise.resolve({ type: 'ok', text: calls === 1 ? 'only one field' : PROD_REFUSAL });
    }));
    const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', LOG_LEVEL: 'info' });
    const response = await runtime.app.fetch(new Request('http://local/api/prompts/ai-fill', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Remote-User': 'alice',
      },
      body: JSON.stringify(twoSlotBody),
    }));
    const frames = parseSseText(await response.text());
    expect(frameData(frames, 'error').code).toBe('refusal');
    expect(runtime.logs.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === 'ai_fill_refusal')).toBeDefined();
  });

  test('non-library user → 404, no stream', async () => {
    setCliproxyTextProviderForTests(fakeProvider(() => Promise.resolve({ type: 'ok', text: 'unused' })));
    const res = await postAiFill(BODY, 'not-a-library-user');
    expect(res.status).toBe(404);
  });

  // End-to-end provider-branch coverage: the test provider stub collapses both
  // branches into one instance, so we mock fetch (no stub) to read the REAL model
  // and prompt selected by the route.
  describe('ai-fill provider routing (real provider, fetch-mocked)', () => {
    function captureUpstream(): {
      getBody: () => Record<string, unknown>;
      getUrl: () => string | undefined;
      restore: () => void;
    } {
      const original = globalThis.fetch;
      let sentBody: Record<string, unknown> = {};
      let sentUrl: string | undefined;
      globalThis.fetch = ((url: string, init?: RequestInit) => {
        sentUrl = url;
        const body = typeof init?.body === 'string' ? init.body : '';
        sentBody = JSON.parse(body) as Record<string, unknown>;
        const data = JSON.stringify({ choices: [{ delta: { content: 'a red bikini' }, finish_reason: 'stop' }] });
        return Promise.resolve(
          new Response(`data: ${data}\n\ndata: [DONE]\n\n`, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      }) as unknown as typeof fetch;
      return { getBody: () => sentBody, getUrl: () => sentUrl, restore: () => { globalThis.fetch = original; } };
    }

    test('simulate:true routes gpt-image prompts to GPT-6.1 Sol', async () => {
      const cap = captureUpstream();
      try {
        const frames = parseSseText(await (await postAiFill({ ...BODY, simulate: true })).text());
        expect(frames.some((f) => f.event === 'result')).toBe(true);
        expect(cap.getBody()).toMatchObject({
          model: 'gpt-6.1-sol',
          reasoning_effort: 'medium',
          max_completion_tokens: 36_000,
        });
        expect(cap.getBody()).not.toHaveProperty('thinking');
        expect(cap.getBody()).not.toHaveProperty('prompt_cache_key');
        const messages = cap.getBody().messages as { role: string; content: string }[];
        expect(messages[0]?.content).toContain("Atelier's image-prompt blank-filling engine");
        expect(cap.getUrl()).toContain('127.0.0.1');
      } finally {
        cap.restore();
      }
    });

    test('Generate routes a Krea target to Kimi K3 with the Kimi-tuned body', async () => {
      const cap = captureUpstream();
      try {
        const frames = parseSseText(await (await postAiFill({
          ...BODY,
          modelId: 'krea-2-gonzalomo',
          staticSegments: ['A 17-year-old girl, ', ', golden hour.'],
        })).text());
        expect(frames.some((f) => f.event === 'result')).toBe(true);
        expect(cap.getBody()).toMatchObject({
          model: 'kimi-latest',
          reasoning_effort: 'low',
          max_completion_tokens: 36_000,
        });
        expect(cap.getBody()).not.toHaveProperty('thinking');
        expect(cap.getBody()).not.toHaveProperty('prompt_cache_key');
        const messages = cap.getBody().messages as { role: string; content: string }[];
        expect(messages[0]?.content).toContain("Atelier's Kimi K3 image-prompt compiler");
      } finally {
        cap.restore();
      }
    });

    test('Krea target stays on Kimi K3 regardless of prompt age', async () => {
      const cap = captureUpstream();
      try {
        const frames = parseSseText(await (await postAiFill({
          ...BODY,
          modelId: 'krea-2-gonzalomo',
          staticSegments: ['A lone elf, ', ', golden hour.'],
        })).text());
        expect(frames.some((f) => f.event === 'result')).toBe(true);
        expect(cap.getBody().model).toBe('kimi-latest');
      } finally {
        cap.restore();
      }
    });

    test('explicit adult age wording does not affect routing — a gpt-image target stays on GPT-6.1 Sol', async () => {
      const cap = captureUpstream();
      try {
        const frames = parseSseText(await (await postAiFill({
          ...BODY,
          staticSegments: ['A lone elf, ', ', golden hour.'],
          instructions: ["the 24-year-old subject's hairstyle"],
        })).text());
        expect(frames.some((f) => f.event === 'result')).toBe(true);
        expect(cap.getBody().model).toBe('gpt-6.1-sol');
      } finally {
        cap.restore();
      }
    });

    test('youthful age wording does not affect routing — a gpt-image target stays on GPT-6.1 Sol', async () => {
      const cap = captureUpstream();
      try {
        const frames = parseSseText(await (await postAiFill({
          ...BODY,
          staticSegments: ['A subject, ', '.'],
          instructions: ['youthful face, eighteen year young teenager'],
        })).text());
        expect(frames.some((f) => f.event === 'result')).toBe(true);
        expect(cap.getBody().model).toBe('gpt-6.1-sol');
      } finally {
        cap.restore();
      }
    });
  });

  // Both routes retry once on the selected backend with the same request shape
  // after a format miss, so a single bad roll self-heals without crossing models.
  describe('format-miss one-shot retry (both paths)', () => {
    const MULTI = {
      staticSegments: ['A ', ' wearing ', ' nearby.'],
      instructions: ['the scene', 'the garment'],
      modelId: 'gpt-image-2.5-sunburst',
    };

    test('simulate retries on the selected backend and splices recovered fills', async () => {
      let calls = 0;
      setCliproxyTextProviderForTests(fakeProvider(() => {
        calls += 1;
        // 1st: a single blob — 1 fill, want 2 → mismatch triggers retry.
        if (calls === 1) return Promise.resolve({ type: 'ok', text: 'one-blob-no-separator' });
        // 2nd: correct two-field output.
        return Promise.resolve({ type: 'ok', text: `a quiet beach${AI_FILL_FIELD_SEPARATOR}a red bikini` });
      }));
      const frames = parseSseText(await (await postAiFill({ ...MULTI, simulate: true })).text());
      expect(calls).toBe(2);
      expect(frameData(frames, 'result').prompt).toBe('A a quiet beach wearing a red bikini nearby.');
    });

    test('Generate path retries once on mismatch', async () => {
      let calls = 0;
      setCliproxyTextProviderForTests(fakeProvider(() => {
        calls += 1;
        // 1st: a single blob — 1 fill, want 2 → mismatch (e.g. a truncated answer).
        if (calls === 1) return Promise.resolve({ type: 'ok', text: 'one-blob-no-separator' });
        // 2nd (same selected-backend request): correct two-field output.
        return Promise.resolve({ type: 'ok', text: `a quiet beach${AI_FILL_FIELD_SEPARATOR}a red bikini` });
      }));
      const frames = parseSseText(await (await postAiFill(MULTI)).text());
      expect(calls).toBe(2);
      expect(frameData(frames, 'result').prompt).toBe('A a quiet beach wearing a red bikini nearby.');
    });

    test('Generate path: a retry that also mismatches surfaces count-mismatch', async () => {
      let calls = 0;
      setCliproxyTextProviderForTests(fakeProvider(() => {
        calls += 1;
        return Promise.resolve({ type: 'ok', text: 'still-one-blob' });
      }));
      const frames = parseSseText(await (await postAiFill(MULTI)).text());
      expect(calls).toBe(2);
      expect(frames.some((f) => f.event === 'result')).toBe(false);
      expect(frameData(frames, 'error').code).toBe('count-mismatch');
    });

    test('simulate: a retry that also mismatches surfaces count-mismatch', async () => {
      let calls = 0;
      setCliproxyTextProviderForTests(fakeProvider(() => {
        calls += 1;
        return Promise.resolve({ type: 'ok', text: 'still-one-blob' });
      }));
      const frames = parseSseText(await (await postAiFill({ ...MULTI, simulate: true })).text());
      expect(calls).toBe(2);
      expect(frames.some((f) => f.event === 'result')).toBe(false);
      expect(frameData(frames, 'error').code).toBe('count-mismatch');
    });
  });
});

describe('POST /api/prompts/ai-fill/batch', () => {
  const item = (label: string) => ({
    staticSegments: [`${label} `, '.'],
    instructions: ['wardrobe'],
  });

  const twoSlotItem = (label: string) => ({
    staticSegments: [`${label} `, ' in ', '.'],
    instructions: ['wardrobe', 'setting'],
  });

  test('uses the target-aware budget for every batched item', async () => {
    const seen: AiFillProviderInput[] = [];
    setCliproxyTextProviderForTests(fakeProvider((input) => {
      seen.push(input);
      return Promise.resolve({ type: 'ok', text: 'red dress' });
    }));

    await (await postAiFillBatch({ items: [item('First')], modelId: 'gpt-image-2.5-sunburst' })).text();
    await (await postAiFillBatch({ items: [item('First')], modelId: 'krea-2-gonzalomo' })).text();

    const staticLength = item('First').staticSegments.reduce((total, segment) => total + segment.length, 0);
    const existingBudget = Math.max(8, Math.floor((MAX_PROMPT_CHARS - staticLength) / 6));
    const kreaBudget = Math.max(8, Math.floor((KREA_PROMPT_WORD_BUDGET * 6 - staticLength) / 6));
    expect(seen[0]?.systemPrompt).toContain(`${existingBudget} words per fill`);
    expect(seen[1]?.systemPrompt).toContain(`${kreaBudget} words per fill`);
  });

  test('uses the batch policy envelope instead of the cloud image timeout', async () => {
    setCliproxyTextProviderForTests(fakeProvider(async () => {
      await Bun.sleep(25);
      return { type: 'ok', text: 'red dress' };
    }));
    const runtime = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      CLOUD_TIMEOUT_MS: '5',
    });
    const response = await runtime.app.fetch(new Request('http://local/api/prompts/ai-fill/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Remote-User': 'alice' },
      body: JSON.stringify({ items: [item('First')], modelId: 'gpt-image-2.5-sunburst' }),
    }));
    const frames = parseSseText(await response.text());
    expect(frameData(frames, 'result').items).toEqual([
      { ok: true, prompt: 'First red dress.', fills: ['red dress'] },
    ]);
  });

  test('splits records, salvages valid items, and preserves request order', async () => {
    let calls = 0;
    setCliproxyTextProviderForTests(fakeProvider(() => {
      calls += 1;
      return Promise.resolve({
        type: 'ok',
        text: `red dress${AI_FILL_RECORD_SEPARATOR}${AI_FILL_RECORD_SEPARATOR}blue coat`,
      });
    }));
    const frames = parseSseText(await (await postAiFillBatch({
      items: [item('First'), item('Second'), item('Third')],
      modelId: 'gpt-image-2.5-sunburst',
    })).text());
    expect(calls).toBe(1);
    expect(frameData(frames, 'result').items).toEqual([
      { ok: true, prompt: 'First red dress.', fills: ['red dress'] },
      { ok: false },
      { ok: true, prompt: 'Third blue coat.', fills: ['blue coat'] },
    ]);
  });

  test('salvages complete leading records from a truncated four-item response without retrying', async () => {
    let calls = 0;
    setCliproxyTextProviderForTests(fakeProvider((input) => {
      calls += 1;
      expect(input.batchSize).toBe(4);
      return Promise.resolve({
        type: 'ok',
        text: ['red dress', 'blue coat', 'green skirt'].join(AI_FILL_RECORD_SEPARATOR),
      });
    }));
    const frames = parseSseText(await (await postAiFillBatch({
      items: [item('First'), item('Second'), item('Third'), item('Fourth')],
      modelId: 'gpt-image-2.5-sunburst',
    })).text());
    expect(calls).toBe(1);
    expect(frameData(frames, 'result').items).toEqual([
      { ok: true, prompt: 'First red dress.', fills: ['red dress'] },
      { ok: true, prompt: 'Second blue coat.', fills: ['blue coat'] },
      { ok: true, prompt: 'Third green skirt.', fills: ['green skirt'] },
      { ok: false },
    ]);
  });

  test('a refused record is dropped while its healthy siblings still ship', async () => {
    let calls = 0;
    setCliproxyTextProviderForTests(fakeProvider(() => {
      calls += 1;
      return Promise.resolve({
        type: 'ok',
        text: [
          'red dress',
          "I can't create this. The instruction specifies a sixteen-year-old subject.",
          'blue coat',
        ].join(AI_FILL_RECORD_SEPARATOR),
      });
    }));
    const frames = parseSseText(await (await postAiFillBatch({
      items: [item('First'), item('Second'), item('Third')],
      modelId: 'gpt-image-2.5-sunburst',
    })).text());
    // No group retry: a refusal is deterministic, unlike a format miss.
    expect(calls).toBe(1);
    expect(frameData(frames, 'result').items).toEqual([
      { ok: true, prompt: 'First red dress.', fills: ['red dress'] },
      { ok: false },
      { ok: true, prompt: 'Third blue coat.', fills: ['blue coat'] },
    ]);
  });

  test('a multi-slot refusal neither retries the group nor escapes as a count mismatch', async () => {
    // One refusal paragraph for a two-instruction item reads as a count miss
    // too. It must still be recognised as a refusal: no group retry, and a
    // moderation record rather than a silent mismatched drop.
    let calls = 0;
    setCliproxyTextProviderForTests(fakeProvider(() => {
      calls += 1;
      return Promise.resolve({ type: 'ok', text: 'Cannot comply with this request. The character is sixteen.' });
    }));
    const runtime = testRuntime({ PROMPT_LIBRARY_USERS: 'alice', LOG_LEVEL: 'info' });
    const response = await runtime.app.fetch(new Request('http://local/api/prompts/ai-fill/batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Remote-User': 'alice',
      },
      body: JSON.stringify({ items: [twoSlotItem('First')], modelId: 'gpt-image-2.5-sunburst' }),
    }));
    const frames = parseSseText(await response.text());
    expect(calls).toBe(1);
    expect(frameData(frames, 'error').code).toBe('refusal');
    const record = runtime.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === 'ai_fill_batch_refusal');
    expect(record).toMatchObject({ itemIndex: 0, instructionCount: 2 });
    expect(JSON.stringify(record)).not.toContain('First');
  });

  test('an all-refused batch reports the refusal code rather than a provider error', async () => {
    setCliproxyTextProviderForTests(fakeProvider(() => Promise.resolve({
      type: 'ok',
      text: [
        'I cannot and will not write image prompts depicting minors.',
        "I can't complete this request.",
      ].join(AI_FILL_RECORD_SEPARATOR),
    })));
    const frames = parseSseText(await (await postAiFillBatch({
      items: [item('First'), item('Second')],
      modelId: 'gpt-image-2.5-sunburst',
    })).text());
    expect(frames.some((f) => f.event === 'result')).toBe(false);
    expect(frameData(frames, 'error').code).toBe('refusal');
  });

  test('retries the entire backend group once with byte-identical prompts after an extra-record protocol violation', async () => {
    const seen: AiFillProviderInput[] = [];
    setCliproxyTextProviderForTests(fakeProvider((input) => {
      seen.push(input);
      return Promise.resolve(seen.length === 1
        ? { type: 'ok', text: ['red dress', 'blue coat', 'extra coat'].join(AI_FILL_RECORD_SEPARATOR) }
        : { type: 'ok', text: `red dress${AI_FILL_RECORD_SEPARATOR}blue coat` });
    }));
    const runtime = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      LOG_LEVEL: 'info',
    });
    const response = await runtime.app.fetch(new Request('http://local/api/prompts/ai-fill/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Remote-User': 'alice' },
      body: JSON.stringify({ items: [item('First'), item('Second')], modelId: 'gpt-image-2.5-sunburst' }),
    }));
    const frames = parseSseText(await response.text());
    expect(seen).toHaveLength(2);
    expect(seen[1]?.systemPrompt).toBe(seen[0]?.systemPrompt);
    expect(seen[1]?.userContent).toBe(seen[0]?.userContent);
    expect(frameData(frames, 'result').items).toEqual([
      { ok: true, prompt: 'First red dress.', fills: ['red dress'] },
      { ok: true, prompt: 'Second blue coat.', fills: ['blue coat'] },
    ]);
    expect(runtime.logs.some((line) => (
      JSON.parse(line) as Record<string, unknown>
    ).event === 'ai_fill_batch_mismatch_retry')).toBe(true);
  });

  test('batch routes Krea to Kimi and gpt-image to GPT with one group each and no classification', async () => {
    const seen: AiFillProviderInput[] = [];
    setCliproxyTextProviderForTests(fakeProvider((input) => {
      seen.push(input);
      const groupSize = input.userContent.match(/<item number=/g)?.length ?? 0;
      const fill = 'adult fill';
      return Promise.resolve({
        type: 'ok',
        text: Array.from({ length: groupSize }, () => fill).join(AI_FILL_RECORD_SEPARATOR),
      });
    }));
    const items = [
      { staticSegments: ['A 25-year-old woman ', '.'], instructions: ['wardrobe'] },
      { staticSegments: ['A 17-year-old girl ', '.'], instructions: ['wardrobe'] },
      { staticSegments: ['Another 25-year-old woman ', '.'], instructions: ['pose'] },
    ];
    const flashFrames = parseSseText(await (await postAiFillBatch({
      items,
      modelId: 'krea-2-gonzalomo',
    })).text());
    const gptFrames = parseSseText(await (await postAiFillBatch({
      items,
      modelId: 'gpt-image-2.5-sunburst',
    })).text());
    expect(seen).toHaveLength(2);
    expect(seen[0]?.systemPrompt).toContain('Kimi K3 multi-item');
    expect(seen[1]?.systemPrompt).not.toContain('Kimi K3 multi-item');
    expect(flashFrames.filter((frame) => frame.event === 'backend').map((frame) => frame.data)).toEqual([
      { backend: 'kimi' },
    ]);
    expect(gptFrames.filter((frame) => frame.event === 'backend').map((frame) => frame.data)).toEqual([
      { backend: 'gpt' },
    ]);
    expect(frameData(gptFrames, 'result').items).toEqual([
      { ok: true, prompt: 'A 25-year-old woman adult fill.', fills: ['adult fill'] },
      { ok: true, prompt: 'A 17-year-old girl adult fill.', fills: ['adult fill'] },
      { ok: true, prompt: 'Another 25-year-old woman adult fill.', fills: ['adult fill'] },
    ]);
  });

  test('batch keeps a single group for its shared target model', async () => {
    const seen: AiFillProviderInput[] = [];
    setCliproxyTextProviderForTests(fakeProvider((input) => {
      seen.push(input);
      const groupSize = input.userContent.match(/<item number=/g)?.length ?? 0;
      return Promise.resolve({
        type: 'ok',
        text: Array.from({ length: groupSize }, () => 'adult fill').join(AI_FILL_RECORD_SEPARATOR),
      });
    }));
    const frames = parseSseText(await (await postAiFillBatch({
      items: [
        { staticSegments: ['A 25-year-old woman ', '.'], instructions: ['wardrobe'] },
        { staticSegments: ['A 17-year-old girl ', '.'], instructions: ['wardrobe'] },
        { staticSegments: ['Another 25-year-old woman ', '.'], instructions: ['pose'] },
      ],
      modelId: 'gpt-image-2.5-sunburst',
    })).text());
    expect(seen).toHaveLength(1);
    expect(frames.filter((frame) => frame.event === 'backend').map((frame) => frame.data)).toEqual([
      { backend: 'gpt' },
    ]);
    expect(frameData(frames, 'result').items).toEqual([
      { ok: true, prompt: 'A 25-year-old woman adult fill.', fills: ['adult fill'] },
      { ok: true, prompt: 'A 17-year-old girl adult fill.', fills: ['adult fill'] },
      { ok: true, prompt: 'Another 25-year-old woman adult fill.', fills: ['adult fill'] },
    ]);
  });

  test('holds one enhance admission slot for the whole multi-item call', async () => {
    const state: {
      started?: () => void;
      release?: (result: AiFillResult) => void;
    } = {};
    const started = new Promise<void>((resolve) => { state.started = resolve; });
    setCliproxyTextProviderForTests(fakeProvider(() => {
      state.started?.();
      return new Promise<AiFillResult>((resolve) => { state.release = resolve; });
    }));
    const runtime = testRuntime({
      PROMPT_LIBRARY_USERS: 'alice',
      MAX_CONCURRENT_LLM_ENHANCE_PER_USER: '2',
      MAX_CONCURRENT_LLM_TOTAL: '2',
      MAX_CONCURRENT_LLM_ENHANCE_GLOBAL_CAP: '2',
    });
    const response = await runtime.app.fetch(new Request('http://local/api/prompts/ai-fill/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Remote-User': 'alice' },
      body: JSON.stringify({ items: Array.from({ length: 4 }, (_, index) => item(`Item ${index + 1}`)), modelId: 'gpt-image-2.5-sunburst' }),
    }));
    const bodyPromise = response.text();
    await started;
    const secondSlot = enhancePool.acquire('alice');
    expect(secondSlot.ok).toBe(true);
    expect(enhancePool.acquire('alice')).toEqual({ ok: false, reason: 'per-user' });
    if (secondSlot.ok) secondSlot.release();
    state.release?.({
      type: 'ok',
      text: Array.from({ length: 4 }, (_, index) => `fill ${index + 1}`).join(AI_FILL_RECORD_SEPARATOR),
    });
    const frames = parseSseText(await bodyPromise);
    expect(frameData(frames, 'result').items).toHaveLength(4);
  });
});
