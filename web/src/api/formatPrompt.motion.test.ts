import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MAX_PROMPT_CHARS } from '@atelier/shared';
import { formatPromptForModel } from './formatPrompt';

// formatPromptForModel returns the streamed H3 motion prose with a hard length
// cap. We drive the real apiFetch + parseEnhanceStream by stubbing only
// globalThis.fetch with a real SSE response body.

const realFetch = globalThis.fetch;
let nextResponse: () => Response = () => new Response('', { status: 200 });

beforeEach(() => {
  globalThis.fetch = (() => Promise.resolve(nextResponse())) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function sse(...frames: { event: string; data: unknown }[]): Response {
  const body = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('formatPromptForModel — h3-motion', () => {
  it('returns the streamed prose unchanged (no caption extraction)', async () => {
    const prose = 'she turns her head slowly, then smiles; fixed camera.';
    nextResponse = () => sse({ event: 'delta', data: { text: prose } }, { event: 'done', data: {} });
    const out = await formatPromptForModel({ prompt: 'turns and smiles', modelId: 'minimax-h3-i2v' }, 'h3-motion');
    expect(out).toBe(prose);
  });

  it('throws when the prose exceeds MAX_PROMPT_CHARS', async () => {
    nextResponse = () =>
      sse({ event: 'delta', data: { text: 'x'.repeat(MAX_PROMPT_CHARS + 1) } }, { event: 'done', data: {} });
    let threw = false;
    try {
      await formatPromptForModel({ prompt: 'a', modelId: 'minimax-h3-i2v' }, 'h3-motion');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

});
