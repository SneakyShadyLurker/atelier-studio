import { describe, expect, spyOn, test } from 'bun:test';
import type { Provider } from './providers/types';
import type { RegistryEntry } from './providers/registry';
import { createGenerationStream } from './test/streamHarness';
import { parseSseText, testRuntime } from './test/helpers';
import { grayCardPng } from './test/image-fixtures';
import * as artifactFiles from './storage/files';
import * as thumbGen from './storage/thumbGen';

function imageEntry(provider: Provider): RegistryEntry {
  return {
    model: {
      id: provider.id,
      name: provider.id,
      backend: provider.backend,
      tag: 'test',
      latency: 'medium',
      supportedRatios: ['1:1'],
      pool: 'shared',
      concurrencyCapPerUser: 4,
      maxCountPerBatch: 4,
    },
    bind: () => provider,
    timeoutMs: () => 5_000,
  };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('thumbnail prewarm did not start');
    await Bun.sleep(0);
  }
}

describe('image thumbnail prewarm', () => {
  test('commit encodes the thumbnail from the in-memory bytes and a thumb GET joins it', async () => {
    const runtime = testRuntime();
    const { db, config, logger } = runtime;
    const png = await grayCardPng(32);
    const provider: Provider = {
      id: 'mock-image', backend: 'cloud',
      async *generate(req) {
        await Promise.resolve();
        yield { status: 'ready', bytes: png, ext: 'png', mime: 'image/png', seed: req.seed, index: 0 };
      },
    };
    const realGenerateThumb = thumbGen.generateThumb;
    let releaseEncode: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseEncode = resolve; });
    const encodeInputs: Uint8Array[] = [];
    const encodeSpy = spyOn(thumbGen, 'generateThumb').mockImplementation(async (source, signal) => {
      encodeInputs.push(source);
      await gate;
      return realGenerateThumb(source, signal);
    });
    const readSpy = spyOn(artifactFiles, 'readArtifactBytes');
    try {
      const stream = createGenerationStream({
        db, config, logger, userId: 'alice',
        request: { prompt: 'x', modelId: provider.id, ratio: '1:1', count: 1 },
        registryEntry: imageEntry(provider), boundProvider: provider,
        disconnectSignal: new AbortController().signal,
        onTileSettled: () => undefined, onSyncFailure: () => undefined,
      });
      const events = parseSseText(await new Response(stream).text());
      expect(events.some((event) => event.event === 'tile'
        && typeof event.data === 'object' && event.data !== null
        && (event.data as { status?: unknown }).status === 'done')).toBe(true);
      const tile = db.query<{ id: string }, []>('SELECT id FROM tiles').get();
      if (!tile) throw new Error('tile missing');

      // The prewarm is encoding before any GET arrives, from the bytes the
      // provider returned rather than a disk read.
      await until(() => encodeInputs.length === 1);
      expect(encodeInputs[0]).toBe(png);

      const responsePromise = runtime.fetch(`/api/img/${tile.id}/thumb`, { headers: { 'Remote-User': 'alice' } });
      await Bun.sleep(5);
      releaseEncode?.();
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('image/webp');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      await response.arrayBuffer();

      expect(encodeSpy).toHaveBeenCalledTimes(1);
      const readRoots: string[] = readSpy.mock.calls.map((args) => args[1]);
      expect(readRoots).not.toContain('images');
    } finally {
      releaseEncode?.();
      encodeSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
});
