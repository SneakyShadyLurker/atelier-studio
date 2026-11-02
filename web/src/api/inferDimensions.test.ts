import { afterEach, describe, expect, test, mock } from 'bun:test';
import { inferDimensions, applyDimensions, isInferDimensionsResponse, type InferProgressNotification } from './inferDimensions';

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

function sseBody(eventName: string, payload: unknown): string {
  return `:keepalive\n\nevent: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}
function sseResponse(eventName: string, payload: unknown, status = 200): Response {
  return new Response(sseBody(eventName, payload), {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function sseTextResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('inferDimensions api', () => {
  test('consumes SSE stream and returns the done-event payload', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseResponse('done', {
      proposalId: 'p', proposal: { bundles: [] }, baseSnapshotHash: 'h', warnings: [], coverage: [], rejected: [], conflicts: [],
    }))) as unknown as typeof fetch;
    const r = await inferDimensions();
    expect(r.proposalId).toBe('p');
  });

  test('SSE error event throws ApiError carrying the safe message', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseResponse('error', { message: 'analysis failed' }))) as unknown as typeof fetch;
    let thrown: unknown;
    try {
      await inferDimensions();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    expect((thrown as Error).message).toContain('analysis failed');
  });

  test('rejects malformed done payloads instead of casting them', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseResponse('done', { proposalId: 'p', proposal: {} }))) as unknown as typeof fetch;
    let thrown: unknown;
    try {
      await inferDimensions();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    expect((thrown as Error).message).toContain('invalid done SSE payload');
  });

  test('ignores unknown SSE events before the terminal done event', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseTextResponse(
      ':keepalive\n\n' +
      'event: thinking\n' +
      'data: {"phase":"thinking"}\n\n' +
      'event: done\n' +
      'data: {"proposalId":"p","proposal":{"bundles":[]},"baseSnapshotHash":"h","warnings":[],"coverage":[],"rejected":[],"conflicts":[]}\n\n',
    ))) as unknown as typeof fetch;

    const result = await inferDimensions();

    expect(result.proposalId).toBe('p');
  });

  test('forwards infer-phase and infer-progress events to onProgress', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseTextResponse(
      'event: infer-phase\n' +
      'data: {"phase":"taxonomy"}\n\n' +
      'event: infer-phase\n' +
      'data: {"phase":"chunks"}\n\n' +
      'event: infer-progress\n' +
      'data: {"done":1,"total":3,"wave":1}\n\n' +
      'event: infer-progress\n' +
      'data: {"done":2,"total":3,"wave":1}\n\n' +
      'event: infer-progress\n' +
      'data: {"done":3,"total":3,"wave":1}\n\n' +
      'event: infer-phase\n' +
      'data: {"phase":"finalize"}\n\n' +
      'event: done\n' +
      'data: {"proposalId":"p","proposal":{"bundles":[]},"baseSnapshotHash":"h","warnings":[],"coverage":[],"rejected":[],"conflicts":[]}\n\n',
    ))) as unknown as typeof fetch;

    const notifications: InferProgressNotification[] = [];
    const res = await inferDimensions(undefined, (n) => notifications.push(n));

    expect(res.proposalId).toBe('p');
    expect(notifications.map((n) => n.phase)).toEqual([
      'taxonomy',
      'chunks',
      'chunks',
      'chunks',
      'chunks',
      'finalize',
    ]);
    expect(notifications[2]?.progress).toEqual({ done: 1, total: 3, wave: 1 });
  });

  test('ignores progress before any phase has been observed', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseTextResponse(
      'event: infer-progress\n' +
      'data: {"done":1,"total":3,"wave":1}\n\n' +
      'event: done\n' +
      'data: {"proposalId":"p","proposal":{"bundles":[]},"baseSnapshotHash":"h","warnings":[],"coverage":[],"rejected":[],"conflicts":[]}\n\n',
    ))) as unknown as typeof fetch;

    const notifications: InferProgressNotification[] = [];
    const res = await inferDimensions(undefined, (n) => notifications.push(n));

    expect(res.proposalId).toBe('p');
    expect(notifications).toEqual([]);
  });

  test('ignores malformed non-terminal progress frames and resolves on done', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseTextResponse(
      'event: infer-phase\n' +
      'data: {"phase":"chunks"}\n\n' +
      'event: infer-progress\n' +
      'data: {"done":\n\n' +
      'event: done\n' +
      'data: {"proposalId":"p","proposal":{"bundles":[]},"baseSnapshotHash":"h","warnings":[],"coverage":[],"rejected":[],"conflicts":[]}\n\n',
    ))) as unknown as typeof fetch;

    const notifications: InferProgressNotification[] = [];
    const res = await inferDimensions(undefined, (n) => notifications.push(n));

    expect(res.proposalId).toBe('p');
    expect(notifications).toEqual([{ phase: 'chunks' }]);
  });

  test('applyDimensions throws ApiError on !ok', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ error: 'nope' }), { status: 409 }))) as unknown as typeof fetch;
    let thrown = false;
    try {
      await applyDimensions({ proposalId: 'p', acceptedBundleKeys: [] });
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(true);
  });
});

describe('isInferDimensionsResponse — discriminated-union bundle validator', () => {
  test('accepts rescue bundle variant alongside dimension bundles', () => {
    const payload = {
      proposalId: 'p1',
      proposal: {
        bundles: [
          {
            key: 'k1', kind: 'extend', title: 't', dimensionName: 'd', detail: '',
            impact: '', destructive: false, defaultChecked: true, dependsOn: [],
            optionCount: 1, listCount: 1,
          },
          {
            key: 'rescue:portrait', kind: 'rescue', title: 't', detail: '', impact: '',
            destructive: false, defaultChecked: true, dependsOn: ['k1'],
            listName: 'outfit', optionValue: 'vintage jacket', templateName: 'portrait',
          },
        ],
      },
      baseSnapshotHash: 'h',
      warnings: [],
      coverage: [],
      rejected: [],
      conflicts: [],
    };
    expect(isInferDimensionsResponse(payload)).toBe(true);
  });

  test('rejects rescue bundle missing variant-specific listName', () => {
    const payload = {
      proposalId: 'p1',
      proposal: {
        bundles: [
          {
            // BundleCommon fields all present; rescue kind set; but missing
            // listName, optionValue, templateName — discriminated-union
            // validator must reject this even though it would have passed
            // a permissive BundleCommon-only check.
            key: 'rescue:x', kind: 'rescue', title: 't', detail: '', impact: '',
            destructive: false, defaultChecked: true, dependsOn: [],
          },
        ],
      },
      baseSnapshotHash: 'h', warnings: [], coverage: [], rejected: [], conflicts: [],
    };
    expect(isInferDimensionsResponse(payload)).toBe(false);
  });

  test('rejects rescue bundle with wrong-typed templateName', () => {
    const payload = {
      proposalId: 'p1',
      proposal: {
        bundles: [
          {
            key: 'rescue:x', kind: 'rescue', title: 't', detail: '', impact: '',
            destructive: false, defaultChecked: true, dependsOn: [],
            listName: 'outfit', optionValue: 'v', templateName: 42 /* wrong type */,
          },
        ],
      },
      baseSnapshotHash: 'h', warnings: [], coverage: [], rejected: [], conflicts: [],
    };
    expect(isInferDimensionsResponse(payload)).toBe(false);
  });

  test('still accepts the original 4 dimension kinds (no regression)', () => {
    const dim = (kind: 'create' | 'extend' | 'merge' | 'rename') => ({
      key: `k:${kind}`, kind, title: 't', dimensionName: 'd', detail: '',
      impact: '', destructive: false, defaultChecked: true, dependsOn: [],
      optionCount: 0, listCount: 0,
    });
    const payload = {
      proposalId: 'p',
      proposal: { bundles: [dim('create'), dim('extend'), dim('merge'), dim('rename')] },
      baseSnapshotHash: 'h', warnings: [], coverage: [], rejected: [], conflicts: [],
    };
    expect(isInferDimensionsResponse(payload)).toBe(true);
  });

  test('rejects dimension bundle missing optionCount (variant-specific field)', () => {
    const payload = {
      proposalId: 'p',
      proposal: {
        bundles: [
          {
            key: 'k', kind: 'extend', title: 't', dimensionName: 'd', detail: '',
            impact: '', destructive: false, defaultChecked: true, dependsOn: [],
            /* missing optionCount */ listCount: 1,
          },
        ],
      },
      baseSnapshotHash: 'h', warnings: [], coverage: [], rejected: [], conflicts: [],
    };
    expect(isInferDimensionsResponse(payload)).toBe(false);
  });

  test('rejects unknown bundle kind', () => {
    const payload = {
      proposalId: 'p',
      proposal: {
        bundles: [
          {
            key: 'k', kind: 'mystery', title: 't', detail: '', impact: '',
            destructive: false, defaultChecked: true, dependsOn: [],
          },
        ],
      },
      baseSnapshotHash: 'h', warnings: [], coverage: [], rejected: [], conflicts: [],
    };
    expect(isInferDimensionsResponse(payload)).toBe(false);
  });
});
