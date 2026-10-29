import { afterEach, describe, expect, test, mock } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useInferDimensions } from './useInferDimensions';

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

const wrap = () => {
  const qc = new QueryClient();
  return ({ children }: { children: ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

function sseDone(payload: unknown): Response {
  return new Response(`:keepalive\n\nevent: done\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('useInferDimensions', () => {
  test('analyze -> status review, proposal populated', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseDone({
      proposalId: 'p',
      baseSnapshotHash: 'h',
      warnings: [],
      coverage: [],
      rejected: [],
      conflicts: [],
      proposal: {
        bundles: [{
          key: 'create:F',
          kind: 'create',
          title: 't',
          dimensionName: 'F',
          detail: 'd',
          impact: '',
          destructive: false,
          defaultChecked: true,
          dependsOn: [],
          optionCount: 1,
          listCount: 1,
        }],
      },
    }))) as unknown as typeof fetch;
    const { result } = renderHook(() => useInferDimensions(), { wrapper: wrap() });
    act(() => {
      result.current.analyze();
    });
    await waitFor(() => { expect(result.current.status).toBe('review'); });
    expect(result.current.proposal?.bundles[0]?.key).toBe('create:F');
  });

  test('empty proposal returns to idle (no silent click-into-void)', async () => {
    globalThis.fetch = mock(() => Promise.resolve(sseDone({
      proposalId: '',
      proposal: { bundles: [] },
      baseSnapshotHash: 'h',
      warnings: [],
      coverage: [],
      rejected: [],
      conflicts: [],
    }))) as unknown as typeof fetch;
    const { result } = renderHook(() => useInferDimensions(), { wrapper: wrap() });
    act(() => {
      result.current.analyze();
    });
    await waitFor(() => { expect(result.current.status).toBe('idle'); });
    expect(result.current.proposal).toBeNull();
  });

  test('analyze({ priorDiagnosis }) does NOT send priorDiagnosis in POST body (server recomputes)', async () => {
    // The server now unconditionally recomputes the prior diagnosis from its own DB.
    // The client must NOT send priorDiagnosis even when analyze() is called with it,
    // to avoid the prompt-injection + stale-snapshot vector.
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock((_url: unknown, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(sseDone({
        proposalId: 'p',
        baseSnapshotHash: 'h',
        warnings: [],
        coverage: [],
        rejected: [],
        conflicts: [],
        proposal: {
          bundles: [{
            key: 'create:F',
            kind: 'create',
            title: 't',
            dimensionName: 'F',
            detail: 'd',
            impact: '',
            destructive: false,
            defaultChecked: true,
            dependsOn: [],
            optionCount: 1,
            listCount: 1,
          }],
        },
      }));
    }) as unknown as typeof fetch;
    const diagnosis = {
      templates: [{ templateName: 'Broken', satisfiable: false, reason: 'conflict' }],
      librarySnapshotHash: 'snap-h',
      templatesDigest: 'tmpl-h',
    };
    const { result } = renderHook(() => useInferDimensions(), { wrapper: wrap() });
    act(() => {
      result.current.analyze({ priorDiagnosis: diagnosis });
    });
    await waitFor(() => { expect(result.current.status).toBe('review'); });
    // Body must be absent — server owns diagnosis recomputation.
    expect(capturedInit?.body).toBeUndefined();
  });

  test('exposes progress state during analysis', async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    globalThis.fetch = mock(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))) as unknown as typeof fetch;
    const { result } = renderHook(() => useInferDimensions(), { wrapper: wrap() });
    act(() => {
      result.current.analyze();
    });
    await waitFor(() => { expect(result.current.status).toBe('analyzing'); });
    act(() => {
      streamController?.enqueue(encoder.encode(
        'event: infer-phase\n' +
        'data: {"phase":"taxonomy"}\n\n',
      ));
    });
    await waitFor(() => { expect(result.current.progress?.phase).toBe('taxonomy'); });
    act(() => {
      streamController?.enqueue(encoder.encode(
        'event: infer-phase\n' +
        'data: {"phase":"chunks"}\n\n' +
        'event: infer-progress\n' +
        'data: {"done":1,"total":3,"wave":1}\n\n',
      ));
    });
    await waitFor(() => {
      expect(result.current.progress).toEqual({
        phase: 'chunks',
        progress: { done: 1, total: 3, wave: 1 },
      });
    });
    act(() => {
      streamController?.enqueue(encoder.encode(
        'event: done\n' +
        'data: {"proposalId":"","proposal":{"bundles":[]},"baseSnapshotHash":"h","warnings":[],"coverage":[],"rejected":[],"conflicts":[]}\n\n',
      ));
      streamController?.close();
    });
    await waitFor(() => { expect(result.current.status).toBe('idle'); });
    expect(result.current.progress).toBeNull();
  });
});
