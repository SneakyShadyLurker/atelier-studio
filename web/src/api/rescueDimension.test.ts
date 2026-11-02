import { afterEach, describe, expect, test, mock } from 'bun:test';
import { rescueDimension } from './rescueDimension';

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

function sseTextResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('rescueDimension api', () => {
  test('does not reconnect after a pre-payload stream drop because rescue attempts are one-shot', async () => {
    let calls = 0;
    const fetchMock = mock(() => Promise.resolve(new Response(
      ++calls === 1
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(':keepalive\n\n'));
              controller.error(new Error('edge reset'));
            },
          })
        : 'event: done\ndata: {}\n\n',
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    )));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await rescueDimension({ proposalId: 'p', templateName: 'portrait' });
    } catch (error) {
      thrown = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((thrown as Error).message).toBe('edge reset');
  });

  test('resolves to ok with rescueBundle + conflicts on done event', async () => {
    const rescueBundle = {
      key: 'rescue:portrait',
      kind: 'rescue',
      title: 'Rescue: portrait',
      detail: 'Adds "vintage jacket" to outfit',
      impact: '',
      destructive: false,
      defaultChecked: true,
      dependsOn: ['k1'],
      listName: 'outfit',
      optionValue: 'vintage jacket',
      templateName: 'portrait',
    };
    const conflicts = [{
      templateName: 'portrait',
      reason: 'no working combinations',
      culpritBundleKeys: ['k1'],
      rescueAttempted: true,
      culpritKind: 'local',
    }];
    globalThis.fetch = mock(() => Promise.resolve(sseTextResponse(
      `event: done\ndata: ${JSON.stringify({ rescueBundle, conflicts })}\n\n`,
    ))) as unknown as typeof fetch;
    const result = await rescueDimension({ proposalId: 'p', templateName: 'portrait' });
    expect(result.type).toBe('ok');
    if (result.type === 'ok') {
      expect(result.rescueBundle.key).toBe('rescue:portrait');
      expect(result.conflicts).toHaveLength(1);
    }
  });

  test('resolves to failed with reason + conflicts on rescue-failed event', async () => {
    const conflicts = [{
      templateName: 'portrait',
      reason: 'no working combinations',
      culpritBundleKeys: ['k1'],
      rescueAttempted: true,
      culpritKind: 'local',
    }];
    globalThis.fetch = mock(() => Promise.resolve(sseTextResponse(
      `event: rescue-failed\ndata: ${JSON.stringify({ reason: 'option-already-exists', conflicts })}\n\n`,
    ))) as unknown as typeof fetch;
    const result = await rescueDimension({ proposalId: 'p', templateName: 'portrait' });
    expect(result.type).toBe('failed');
    if (result.type === 'failed') {
      expect(result.reason).toBe('option-already-exists');
      expect(result.conflicts).toHaveLength(1);
      const first = result.conflicts[0];
      expect(first).toBeTruthy();
      if (first) expect(first.rescueAttempted).toBe(true);
    }
  });

  test('rescue-failed without conflicts field falls back to empty array (old server)', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseTextResponse(
      'event: rescue-failed\ndata: {"reason":"option-already-exists"}\n\n',
    ))) as unknown as typeof fetch;
    const result = await rescueDimension({ proposalId: 'p', templateName: 'portrait' });
    expect(result.type).toBe('failed');
    if (result.type === 'failed') {
      expect(result.reason).toBe('option-already-exists');
      expect(result.conflicts).toEqual([]);
    }
  });

  test('throws ApiError on !ok HTTP response (e.g. 409 rescue-spent)', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: 'rescue already attempted for this template',
      code: 'rescue-spent',
    }), { status: 409, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch;
    let thrown = false;
    try {
      await rescueDimension({ proposalId: 'p', templateName: 'portrait' });
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(true);
  });

  test('rejects malformed done payloads instead of casting them', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseTextResponse(
      'event: done\ndata: {"rescueBundle":{"key":"x"}}\n\n',
    ))) as unknown as typeof fetch;
    let thrown: unknown;
    try {
      await rescueDimension({ proposalId: 'p', templateName: 'portrait' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    expect((thrown as Error).message).toContain('invalid done SSE payload');
  });

  test('throws when stream ends without a terminal event', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseTextResponse(':keepalive\n\n'))) as unknown as typeof fetch;
    let thrown: unknown;
    try {
      await rescueDimension({ proposalId: 'p', templateName: 'portrait' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    expect((thrown as Error).message).toContain('stream ended');
  });
});
