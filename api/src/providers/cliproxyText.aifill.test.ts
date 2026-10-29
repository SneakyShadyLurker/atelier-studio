import { describe, expect, test } from 'bun:test';
import type { AiFillBackend } from '@atelier/shared';
import { buildResilientPolicy } from '../lifecycle/resilient-call';
import { createCliproxyTextProvider } from './cliproxyText';
import {
  AI_FILL_BATCH_MAX_COMPLETION_TOKENS,
  AI_FILL_BATCH_PER_ATTEMPT_TIMEOUT_MS,
  AI_FILL_ROUTE_TIMEOUT_MARGIN_MS,
  GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS,
  aiFillBatchRouteTimeoutMs,
  aiFillPolicyEnvelopeMs,
  aiFillRouteTimeoutMs,
} from './cliproxyText.config';
import { testTextPolicies } from '../test/textPolicies';

// Fast per-attempt policy for tests — small backoff so the transient-retry
// test completes in milliseconds.
const fastPolicy = buildResilientPolicy({
  timeoutPerAttemptMs: 5_000,
  maxAttempts: 2,
  initialBackoffMs: 1,
  maxBackoffMs: 1,
  breakerThreshold: 8,
  halfOpenAfterMs: 30_000,
});

function makeProvider(
  model = 'kimi-latest',
  aiFillBatchPolicy = fastPolicy,
  backend: AiFillBackend | undefined = 'kimi',
) {
  return createCliproxyTextProvider({ ...testTextPolicies(),
    baseUrl: 'http://fake-upstream',
    token: 'sk-test',
    model,
    backend,
    maxResponseBytes: 1_000_000,
    aiFillPolicy: fastPolicy,
    aiFillBatchPolicy,
    // Inject a fast quotaMinRetryAfterMs so the 429 test's Retry-After: 900
    // (900 000 ms) exceeds the floor and is correctly classified as quota.
    quotaMinRetryAfterMs: 300_000,
  });
}

function sseDoneResponse(text: string): Response {
  // Minimal SSE chat-completions response containing the text as delta content.
  const data = JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] });
  const body = `data: ${data}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function sseInStreamErrorResponse(message: string): Response {
  // A 200 stream that carries a quota-worded error frame mid-stream — the
  // variant HTTP-status classification never sees.
  const data = JSON.stringify({ error: { message } });
  return new Response(`data: ${data}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const defaultInput = {
  systemPrompt: 'fill the blanks',
  userContent: '[[0]] and [[1]]',
};

describe('aiFill retry policy', () => {
  for (const reason of [undefined, 'insufficient_system_resource']) {
    test(`retries an incomplete accumulator instead of returning partial text: ${reason ?? 'EOF'}`, async () => {
      const original = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = Object.assign(() => {
        if (++calls > 1) return Promise.resolve(sseDoneResponse('complete replacement'));
        const data = JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: reason }] });
        return Promise.resolve(new Response(`data: ${data}\n\n${reason === undefined ? '' : 'data: [DONE]\n\n'}`));
      }, { preconnect: original.preconnect });
      try {
        expect(await makeProvider().aiFill(defaultInput, new AbortController().signal))
          .toEqual({ type: 'ok', text: 'complete replacement' });
        expect(calls).toBe(2);
      } finally { globalThis.fetch = original; }
    });
  }
  for (const reason of ['length', 'content_filter', 'tool_calls', 'function_call', 'stop', 'DONE']) {
    test(`classifies an accumulator terminal before returning text: ${reason}`, async () => {
      const original = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = Object.assign(() => {
        calls++;
        const data = JSON.stringify({ choices: [{ delta: { content: 'text' }, finish_reason: reason === 'DONE' ? null : reason }] });
        return Promise.resolve(new Response(`data: ${data}\n\ndata: [DONE]\n\n`));
      }, { preconnect: original.preconnect });
      try {
        const result = await makeProvider().aiFill(defaultInput, new AbortController().signal);
        if (reason === 'stop' || reason === 'DONE') expect(result).toEqual({ type: 'ok', text: 'text' });
        else expect(result).toMatchObject({ type: 'failed' });
        expect(calls).toBe(1);
      } finally { globalThis.fetch = original; }
    });
  }

  test('selects the batch policy while leaving the single-item retry policy unchanged', async () => {
    const original = globalThis.fetch;
    const noRetryBatchPolicy = buildResilientPolicy({
      timeoutPerAttemptMs: 5_000,
      maxAttempts: 1,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      breakerThreshold: 8,
      halfOpenAfterMs: 30_000,
    });
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'service unavailable' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;

    try {
      const provider = makeProvider('kimi-latest', noRetryBatchPolicy);
      const batchResult = await provider.aiFill(
        { ...defaultInput, batchSize: 2 },
        new AbortController().signal,
      );
      expect(batchResult.type).toBe('failed');
      expect(calls).toBe(1);

      calls = 0;
      globalThis.fetch = (() => {
        calls += 1;
        return Promise.resolve(calls === 1
          ? new Response(JSON.stringify({ error: { message: 'service unavailable' } }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            })
          : sseDoneResponse('red and blue'));
      }) as unknown as typeof fetch;
      const singleResult = await provider.aiFill(defaultInput, new AbortController().signal);
      expect(singleResult).toEqual({ type: 'ok', text: 'red and blue' });
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('derives a route deadline for every policy call plus teardown margin', () => {
    expect(AI_FILL_BATCH_PER_ATTEMPT_TIMEOUT_MS).toBe(150_000);
    const policyEnvelopeMs = aiFillPolicyEnvelopeMs(AI_FILL_BATCH_PER_ATTEMPT_TIMEOUT_MS, 8_000);
    expect(policyEnvelopeMs).toBe(AI_FILL_BATCH_PER_ATTEMPT_TIMEOUT_MS * 2 + 8_000);

    // The initial call plus one format-recovery call.
    const policyCallCount = 2;
    const timeoutMs = aiFillBatchRouteTimeoutMs('kimi', 8_000);
    expect(timeoutMs).toBe(
      policyEnvelopeMs * policyCallCount + AI_FILL_ROUTE_TIMEOUT_MARGIN_MS,
    );
    expect(timeoutMs).toBeGreaterThan(300_000);

    // A GLM batch budgets its own longer per-attempt timeout for both calls.
    expect(aiFillBatchRouteTimeoutMs('glm-abliterated', 8_000)).toBe(
      2 * aiFillPolicyEnvelopeMs(GLM_ABLITERATED_AI_FILL_PER_ATTEMPT_TIMEOUT_MS, 8_000) + AI_FILL_ROUTE_TIMEOUT_MARGIN_MS,
    );

    expect(aiFillRouteTimeoutMs([140_000, 120_000], 8_000)).toBe(
      (2 * 140_000 + 8_000) + (2 * 120_000 + 8_000) + AI_FILL_ROUTE_TIMEOUT_MARGIN_MS,
    );
  });

  test('scales the completion ceiling on chat batch wire shapes', async () => {
    const original = globalThis.fetch;
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>);
      return Promise.resolve(sseDoneResponse('red and blue'));
    }) as unknown as typeof fetch;

    try {
      const kimi = makeProvider('kimi-latest');
      await kimi.aiFill(defaultInput, new AbortController().signal);
      await kimi.aiFill({ ...defaultInput, batchSize: 3 }, new AbortController().signal);
      const mimo = makeProvider('mimo-v2.6-pro', fastPolicy, 'mimo');
      await mimo.aiFill(defaultInput, new AbortController().signal);
      await mimo.aiFill({ ...defaultInput, batchSize: 4 }, new AbortController().signal);

      expect(sent[0]?.max_completion_tokens).toBe(36_000);
      expect(sent[1]?.max_completion_tokens).toBe(108_000);
      expect(sent[2]?.max_completion_tokens).toBe(36_000);
      expect(sent[3]?.max_completion_tokens).toBe(AI_FILL_BATCH_MAX_COMPLETION_TOKENS);
      expect(sent[0]?.reasoning_effort).toBe('low');
      expect(sent[1]?.reasoning_effort).toBe('low');
      // MiMo's own default, never AI_FILL_DEFAULTS' 'low'.
      expect(sent[2]?.reasoning_effort).toBe('none');
      expect(sent[3]?.reasoning_effort).toBe('none');
      for (const body of sent) {
        expect(body).not.toHaveProperty('thinking');
        expect(body).not.toHaveProperty('max_tokens');
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test('retries once on a transient 503 then succeeds', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      if (calls === 1) {
        // First attempt: 503 — transient, should be retried.
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'service unavailable' } }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      // Second attempt: success.
      return Promise.resolve(sseDoneResponse('red and blue'));
    }) as unknown as typeof fetch;

    try {
      const provider = makeProvider();
      const result = await provider.aiFill(defaultInput, new AbortController().signal);

      expect(calls).toBe(2);
      expect(result).toEqual({ type: 'ok', text: 'red and blue' });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('does NOT retry a quota error (429 with long Retry-After)', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      // 429 with Retry-After: 900 seconds (900 000 ms >= 300 000 ms floor) →
      // classified as QuotaExhaustedError (non-retriable).
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '900',
          },
        }),
      );
    }) as unknown as typeof fetch;

    try {
      const provider = makeProvider();
      const result = await provider.aiFill(defaultInput, new AbortController().signal);

      expect(calls).toBe(1);
      expect(result.type).toBe('failed');
      if (result.type === 'failed') {
        expect(result.kind).toBe('quota');
        expect(result.retryAfterSeconds).toBe(900);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test('classifies an in-stream quota error frame as non-retriable quota (not socket transient)', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(sseInStreamErrorResponse('usage limit reached for this 5 hour window'));
    }) as unknown as typeof fetch;

    try {
      const provider = makeProvider();
      const result = await provider.aiFill(defaultInput, new AbortController().signal);

      // Non-retriable → single attempt; classified quota, not a retried socket transient.
      expect(calls).toBe(1);
      expect(result.type).toBe('failed');
      if (result.type === 'failed') {
        expect(result.kind).toBe('quota');
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test('generic OpenAI-compatible fallback sends reasoning_effort and omits thinking', async () => {
    const original = globalThis.fetch;
    let sent: Record<string, unknown> = {};
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      return Promise.resolve(sseDoneResponse('red and blue'));
    }) as unknown as typeof fetch;
    try {
      // GPT aliases use their dedicated wire shape and moderation gate.
      const result = await makeProvider('generic-openai-model', fastPolicy, undefined).aiFill(defaultInput, new AbortController().signal);
      expect(result.type).toBe('ok');
      expect(sent.model).toBe('generic-openai-model');
      expect(sent.reasoning_effort).toBe('low');
      expect(sent.thinking).toBeUndefined();
      expect(sent).not.toHaveProperty('prompt_cache_key');
      expect(sent).not.toHaveProperty('prompt_cache_isolation_key');
      expect(sent).not.toHaveProperty('perf_metrics_in_response');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('Kimi K3 uses low reasoning and leaves thinking plus sampling provider-owned', async () => {
    const original = globalThis.fetch;
    let sent: Record<string, unknown> = {};
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      sent = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      return Promise.resolve(sseDoneResponse('red and blue'));
    }) as unknown as typeof fetch;
    try {
      await makeProvider('kimi-latest').aiFill(defaultInput, new AbortController().signal);
      expect(sent).toMatchObject({
        model: 'kimi-latest',
        reasoning_effort: 'low',
        max_completion_tokens: 36_000,
      });
      for (const key of [
        'prompt_cache_key', 'prompt_cache_isolation_key', 'perf_metrics_in_response', 'thinking',
        'temperature', 'top_p', 'n', 'presence_penalty', 'frequency_penalty', 'verbosity', 'max_tokens',
      ]) {
        expect(sent).not.toHaveProperty(key);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  test('retries an in-stream time out error frame as transient', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(sseInStreamErrorResponse('upstream time out while streaming'));
    }) as unknown as typeof fetch;

    try {
      const provider = makeProvider();
      const result = await provider.aiFill(defaultInput, new AbortController().signal);

      expect(calls).toBe(2);
      expect(result.type).toBe('failed');
      if (result.type === 'failed') {
        expect(result.kind).toBe('transient');
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});
