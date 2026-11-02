import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { TileMime } from '@atelier/shared';
import { pngBytes } from '../test/image-fixtures';
import { createGoogleProvider } from './google';
import type { ProviderRequest, ProviderResult } from './types';

const originalFetch = globalThis.fetch;

const downscaleCalls: AbortSignal[] = [];

const baseRequest: ProviderRequest = {
  prompt: 'a small dot',
  modelId: 'gemini-3-pro-image-preview',
  ratio: '16:9',
  tileIndex: 0,
  seed: 0,
};

function provider() {
  return createGoogleProvider({
    apiKey: 'AIzaTEST',
    modelId: 'gemini-3-pro-image-preview',
    maxResponseBytes: 50 * 1024 * 1024,
    downscaleRef: async (input: { bytes: Uint8Array; mime: TileMime }, signal?: AbortSignal) => {
      if (!signal) throw new Error('expected google provider to pass an abort signal');
      downscaleCalls.push(signal);
      if (downscaleCalls.length === 1) {
        await Promise.resolve();
      }
      if (signal.aborted) throw signal.reason;
      return input;
    },
  });
}

async function consume(
  provider: ReturnType<typeof createGoogleProvider>,
  req: ProviderRequest,
  signal: AbortSignal,
): Promise<ProviderResult[]> {
  const out: ProviderResult[] = [];
  for await (const r of provider.generate(req, signal)) {
    out.push(r);
  }
  return out;
}

afterEach(() => {
  downscaleCalls.length = 0;
  globalThis.fetch = originalFetch;
});

describe('google adapter - reference preprocessing aborts', () => {
  test('aborts memoized ref preprocessing before later refs or Gemini fetch start', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('{}')));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const controller = new AbortController();
    const reason = new DOMException('batch canceled', 'AbortError');
    const refs = [
      { bytes: new Uint8Array([1]), mime: 'image/png' as const },
      { bytes: new Uint8Array([2]), mime: 'image/png' as const },
    ];

    const resultPromise = consume(provider(), { ...baseRequest, refImages: refs }, controller.signal);
    await Promise.resolve();
    controller.abort(reason);

    let caught: unknown;
    try {
      await resultPromise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(reason);
    expect(downscaleCalls).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('keeps shared preprocessing alive for sibling tiles when only one tile aborts', async () => {
    const responseBytes = pngBytes();
    const fetchMock = mock(() =>
      Promise.resolve(new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: Buffer.from(responseBytes).toString('base64'),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const first = new AbortController();
    const second = new AbortController();
    const refs = [{ bytes: new Uint8Array([1]), mime: 'image/png' as const }];
    const p = provider();

    const firstResult = consume(p, { ...baseRequest, refImages: refs, tileIndex: 0 }, first.signal);
    const secondResult = consume(p, { ...baseRequest, refImages: refs, tileIndex: 1 }, second.signal);
    await Promise.resolve();
    first.abort(new DOMException('tile canceled', 'AbortError'));

    const [firstOut, secondOut] = await Promise.all([firstResult, secondResult]);

    expect(firstOut).toEqual([]);
    expect(secondOut[0]).toMatchObject({ status: 'ready' });
    expect(downscaleCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
