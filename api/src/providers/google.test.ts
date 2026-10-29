import { afterEach, describe, expect, mock, test } from 'bun:test';
import { pngBytes } from '../test/image-fixtures';
import { createGoogleProvider } from './google';
import type { ProviderRequest, ProviderResult } from './types';

type GooglePartWire = { text: string } | { inlineData: { mimeType: string; data: string } };

interface GoogleRequestBody {
  contents: [{ parts: readonly GooglePartWire[] }];
  generationConfig: {
    responseModalities: string[];
    candidateCount: number;
    imageConfig: {
      aspectRatio: string;
      imageSize: string;
    };
  };
  safetySettings: { category: string; threshold: string }[];
}

function expectTextPart(part: GooglePartWire | undefined): asserts part is { text: string } {
  if (!part || !('text' in part)) throw new Error('expected text part');
}

function expectInlineDataPart(
  part: GooglePartWire | undefined,
): asserts part is { inlineData: { mimeType: string; data: string } } {
  if (!part || !('inlineData' in part)) throw new Error('expected inlineData part');
}

const baseRequest: ProviderRequest = {
  prompt: 'a small dot',
  modelId: 'gemini-3-pro-image-preview',
  ratio: '16:9',
  tileIndex: 0,
  seed: 0,
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = mock((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'),
                  },
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { calls, fetchMock };
}

function onlyCall(calls: { url: string; init: RequestInit }[]) {
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (!call) throw new Error('expected one fetch call');
  return call;
}

function parseSentBody(call: { init: RequestInit }): GoogleRequestBody {
  if (typeof call.init.body !== 'string') throw new Error('expected string fetch body');
  return JSON.parse(call.init.body) as GoogleRequestBody;
}

function expectGoogleBodyShape(sentBody: GoogleRequestBody) {
  const [textPart] = sentBody.contents[0].parts;
  expectTextPart(textPart);
  expect(textPart.text).toBe('a small dot');
  expect(sentBody.generationConfig.responseModalities).toEqual(['IMAGE']);
  expect(sentBody.generationConfig.candidateCount).toBe(1);
  expect(sentBody.generationConfig.imageConfig).toEqual({
    aspectRatio: '16:9',
    imageSize: '2K',
  });
  expect(sentBody.safetySettings).toEqual([
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  ]);
}

function fetchMockOnce(response: Response) {
  globalThis.fetch = mock(() => Promise.resolve(response)) as unknown as typeof fetch;
}

async function consume(
  provider: ReturnType<typeof createGoogleProvider>,
  req: ProviderRequest,
): Promise<ProviderResult[]> {
  const out: ProviderResult[] = [];
  for await (const r of provider.generate(req, new AbortController().signal)) {
    out.push(r);
  }
  return out;
}

function expectFailedReason(results: ProviderResult[], reason: Record<string, unknown>) {
  expect(results[0]).toMatchObject({ status: 'failed' });
  const [result] = results;
  if (result?.status !== 'failed') throw new Error('expected failed result');
  expect(result.error).toMatchObject({ reason });
}

const provider = () =>
  createGoogleProvider({
    apiKey: 'AIzaTEST',
    modelId: 'gemini-3-pro-image-preview',
    maxResponseBytes: 50 * 1024 * 1024,
  });

describe('google adapter - request shape', () => {
  test('sends hardcoded imageConfig and safetySettings on Pro', async () => {
    const { calls } = captureFetch();
    const provider = createGoogleProvider({
      apiKey: 'AIzaTEST',
      modelId: 'gemini-3-pro-image-preview',
      maxResponseBytes: 50 * 1024 * 1024,
    });

    for await (const _ of provider.generate(baseRequest, new AbortController().signal)) {
      /* drain */
    }

    const call = onlyCall(calls);
    expect(call.url).toContain('gemini-3-pro-image-preview:generateContent');
    expectGoogleBodyShape(parseSentBody(call));
    expect((call.init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIzaTEST');
  });

  test('appends reference images as inlineData parts in order', async () => {
    const { calls } = captureFetch();
    const refA = pngBytes(8, 8);
    const refB = pngBytes(16, 16);
    for await (const _ of provider().generate(
      { ...baseRequest, refImages: [{ bytes: refA, mime: 'image/png' }, { bytes: refB, mime: 'image/png' }] },
      new AbortController().signal,
    )) {
      /* drain */
    }
    const call = onlyCall(calls);
    const sent = parseSentBody(call);
    expect(sent.contents[0].parts).toHaveLength(3);
    const [textPart, firstRef, secondRef] = sent.contents[0].parts;
    expectTextPart(textPart);
    expect(textPart.text).toBe('a small dot');
    expectInlineDataPart(firstRef);
    expect(firstRef.inlineData.mimeType).toBe('image/png');
    expect(firstRef.inlineData.data).toBe(Buffer.from(refA).toString('base64'));
    expectInlineDataPart(secondRef);
    expect(secondRef.inlineData.data).toBe(Buffer.from(refB).toString('base64'));
  });

  test('memoizes ref encoding across tiles in the same batch', async () => {
    const { calls } = captureFetch();
    const refA = pngBytes(8, 8);
    const refs = [{ bytes: refA, mime: 'image/png' as const }];
    const p = provider();
    for (let i = 0; i < 3; i++) {
      for await (const _ of p.generate(
        { ...baseRequest, refImages: refs, tileIndex: i },
        new AbortController().signal,
      )) {
        /* drain */
      }
    }
    expect(calls).toHaveLength(3);
    const bodies = calls.map((c) => parseSentBody(c));
    for (const sent of bodies) {
      const [, firstRef] = sent.contents[0].parts;
      expectInlineDataPart(firstRef);
      expect(firstRef.inlineData.data).toBe(Buffer.from(refA).toString('base64'));
    }
  });

  test('omits inlineData parts when refImages is empty', async () => {
    const { calls } = captureFetch();
    for await (const _ of provider().generate(baseRequest, new AbortController().signal)) {
      /* drain */
    }
    const sent = parseSentBody(onlyCall(calls));
    expect(sent.contents[0].parts).toHaveLength(1);
  });

  test('sends same shape on Flash', async () => {
    const { calls } = captureFetch();
    const provider = createGoogleProvider({
      apiKey: 'AIzaTEST',
      modelId: 'gemini-3.1-flash-image-preview',
      maxResponseBytes: 50 * 1024 * 1024,
    });

    for await (const _ of provider.generate(baseRequest, new AbortController().signal)) {
      /* drain */
    }

    const call = onlyCall(calls);
    expect(call.url).toContain('gemini-3.1-flash-image-preview:generateContent');
    expectGoogleBodyShape(parseSentBody(call));
  });

  test('sends 1K imageSize on Flash Lite (2K/4K are unsupported for this model)', async () => {
    const { calls } = captureFetch();
    const provider = createGoogleProvider({
      apiKey: 'AIzaTEST',
      modelId: 'gemini-3.1-flash-lite-image',
      maxResponseBytes: 50 * 1024 * 1024,
    });

    for await (const _ of provider.generate(baseRequest, new AbortController().signal)) {
      /* drain */
    }

    const call = onlyCall(calls);
    expect(call.url).toContain('gemini-3.1-flash-lite-image:generateContent');
    const sent = parseSentBody(call);
    expect(sent.generationConfig.imageConfig).toEqual({
      aspectRatio: '16:9',
      imageSize: '1K',
    });
  });
});

describe('google adapter - response handling', () => {
  test('200 with inlineData PNG yields ready', async () => {
    const bytes = pngBytes();
    fetchMockOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: Buffer.from(bytes).toString('base64'),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const results = await consume(provider(), baseRequest);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: 'ready',
      ext: 'png',
      mime: 'image/png',
      seed: 0,
    });
  });

  test('HTTP 401 yields failed', async () => {
    fetchMockOnce(
      new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 }),
    );
    const results = await consume(provider(), baseRequest);
    expect(results[0]).toMatchObject({ status: 'failed' });
  });

  test('HTTP 429 yields failed', async () => {
    fetchMockOnce(
      new Response(JSON.stringify({ error: { code: 429 } }), { status: 429 }),
    );
    const results = await consume(provider(), baseRequest);
    expect(results[0]).toMatchObject({ status: 'failed' });
  });

  test('HTTP 200 with promptFeedback.blockReason yields failed', async () => {
    fetchMockOnce(
      new Response(
        JSON.stringify({
          promptFeedback: { blockReason: 'SAFETY' },
          candidates: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const results = await consume(provider(), baseRequest);
    expectFailedReason(results, { kind: 'policy', raw: 'SAFETY' });
  });

  test('HTTP 200 with candidates[0].finishReason SAFETY yields failed', async () => {
    fetchMockOnce(
      new Response(
        JSON.stringify({
          candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const results = await consume(provider(), baseRequest);
    expectFailedReason(results, { kind: 'policy', raw: 'SAFETY' });
  });

  test('HTTP 200 with policy finish reason yields failed', async () => {
    fetchMockOnce(
      new Response(
        JSON.stringify({
          candidates: [{ finishReason: 'IMAGE_PROHIBITED_CONTENT', content: { parts: [] } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const results = await consume(provider(), baseRequest);
    expectFailedReason(results, { kind: 'policy', raw: 'IMAGE_PROHIBITED_CONTENT' });
  });

  test('HTTP 200 with NO_IMAGE finish reason yields upstream-rejected failure', async () => {
    fetchMockOnce(
      new Response(
        JSON.stringify({
          candidates: [{ finishReason: 'NO_IMAGE', content: {} }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const results = await consume(provider(), baseRequest);
    expectFailedReason(results, { kind: 'no-image', raw: 'NO_IMAGE' });
  });

  test('HTTP 200 with no inlineData yields failed', async () => {
    fetchMockOnce(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const results = await consume(provider(), baseRequest);
    expect(results[0]).toMatchObject({ status: 'failed' });
  });

  test('HTTP 200 with non-image inlineData yields failed', async () => {
    fetchMockOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: Buffer.from('not an image').toString('base64'),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const results = await consume(provider(), baseRequest);
    expectFailedReason(results, { kind: 'unsupported', raw: 'unsupported format' });
  });

  test('response body over maxResponseBytes yields failed', async () => {
    fetchMockOnce(
      new Response('x'.repeat(100), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const tight = createGoogleProvider({
      apiKey: 'AIzaTEST',
      modelId: 'gemini-3-pro-image-preview',
      maxResponseBytes: 10,
    });
    const results = await consume(tight, baseRequest);
    expect(results[0]).toMatchObject({ status: 'failed' });
  });
});
