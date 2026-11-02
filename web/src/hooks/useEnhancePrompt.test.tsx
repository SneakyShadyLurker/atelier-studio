import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useEnhancePrompt } from './useEnhancePrompt';
import { useAtelierStore } from '../store/atelier';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
  useAtelierStore.setState({ toasts: [] });
  useAtelierStore.getState().setDraft({ enhanceAnchor: undefined, enhancedText: undefined });
});

function draft() {
  return useAtelierStore.getState().draft;
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function sseFetch(body: string) {
  return mock(() => Promise.resolve(new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })));
}

function harness(initialPrompt = 'a cat') {
  let prompt = initialPrompt;
  const onPromptChange = mock((next: string) => { prompt = next; });
  const view = renderHook(
    ({ p }: { p: string }) => useEnhancePrompt({ prompt: p, refImageIds: [], onPromptChange }),
    { wrapper: wrapper(), initialProps: { p: prompt } },
  );
  return { view, onPromptChange, getPrompt: () => prompt };
}

describe('useEnhancePrompt', () => {
  test('accumulates deltas into onPromptChange then marks done', async () => {
    globalThis.fetch = sseFetch(
      'event: delta\ndata: {"text":"a "}\n\nevent: delta\ndata: {"text":"fluffy cat"}\n\nevent: done\ndata: {}\n\n',
    ) as unknown as typeof fetch;
    const h = harness('a cat');
    act(() => { h.view.result.current.enhance(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    expect(h.onPromptChange).toHaveBeenLastCalledWith('a fluffy cat');
    expect(draft().enhancedText).toBe('a fluffy cat');
    expect(draft().enhanceAnchor).toBe('a cat');
  });

  test('error restores the original prompt and toasts', async () => {
    globalThis.fetch = sseFetch('event: error\ndata: {"message":"nope"}\n\n') as unknown as typeof fetch;
    const h = harness('keep me');
    act(() => { h.view.result.current.enhance(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('error'); });
    expect(h.onPromptChange).toHaveBeenLastCalledWith('keep me');
    expect(useAtelierStore.getState().toasts.length).toBeGreaterThan(0);
    // error frames now throw (not yield), so the message goes through
    // describeError which falls back to the generic copy for plain Errors
    expect(useAtelierStore.getState().toasts[0]?.text).toContain('enhance the prompt');
  });

  test('a clean EOF without done is a failure: restores the original, persists nothing, never replays', async () => {
    const fetchMock = sseFetch('event: delta\ndata: {"text":"a trunc"}\n\n');
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const h = harness('keep me');
    act(() => { h.view.result.current.enhance(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('error'); });
    expect(h.onPromptChange).toHaveBeenCalledWith('a trunc');
    expect(h.onPromptChange).toHaveBeenLastCalledWith('keep me');
    expect(draft().enhancedText).toBeUndefined();
    expect(useAtelierStore.getState().toasts[0]?.text).toContain('enhance the prompt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('done is terminal: frames after it are not consumed', async () => {
    globalThis.fetch = sseFetch(
      'event: delta\ndata: {"text":"a fluffy cat"}\n\nevent: done\ndata: {}\n\nevent: delta\ndata: {"text":" trailing"}\n\n',
    ) as unknown as typeof fetch;
    const h = harness('a cat');
    act(() => { h.view.result.current.enhance(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    expect(h.onPromptChange).toHaveBeenLastCalledWith('a fluffy cat');
    expect(h.onPromptChange).not.toHaveBeenCalledWith('a fluffy cat trailing');
    expect(draft().enhancedText).toBe('a fluffy cat');
    expect(useAtelierStore.getState().toasts).toHaveLength(0);
  });

  test('undo restores the original; the anchor survives for the next enhance', async () => {
    globalThis.fetch = sseFetch('event: delta\ndata: {"text":"rewritten"}\n\nevent: done\ndata: {}\n\n') as unknown as typeof fetch;
    const h = harness('original');
    act(() => { h.view.result.current.enhance(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    h.view.rerender({ p: h.getPrompt() });
    expect(h.view.result.current.canUndo).toBe(true);
    act(() => { h.view.result.current.undo(); });
    expect(h.onPromptChange).toHaveBeenLastCalledWith('original');
    expect(h.view.result.current.status).toBe('idle');
    h.view.rerender({ p: h.getPrompt() });
    expect(h.view.result.current.canUndo).toBe(false);
    expect(draft().enhanceAnchor).toBe('original');
  });

  test('repeated enhance re-sends the user prompt and undo restores it, not the prior rewrite', async () => {
    const sent: string[] = [];
    let n = 0;
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      sent.push((JSON.parse(init?.body as string) as { prompt: string }).prompt);
      n += 1;
      return Promise.resolve(new Response(
        `event: delta\ndata: {"text":"rewrite ${n}"}\n\nevent: done\ndata: {}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ));
    }) as unknown as typeof fetch;
    const h = harness('original');

    act(() => { h.view.result.current.enhance(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    h.view.rerender({ p: h.getPrompt() });
    expect(h.getPrompt()).toBe('rewrite 1');
    expect(h.view.result.current.canUndo).toBe(true);

    act(() => { h.view.result.current.enhance(); });
    await waitFor(() => { expect(h.getPrompt()).toBe('rewrite 2'); });
    h.view.rerender({ p: h.getPrompt() });
    expect(sent).toEqual(['original', 'original']);

    act(() => { h.view.result.current.undo(); });
    expect(h.onPromptChange).toHaveBeenLastCalledWith('original');
  });

  test('an edited rewrite is new user text: next enhance re-anchors on it', async () => {
    const sent: string[] = [];
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      sent.push((JSON.parse(init?.body as string) as { prompt: string }).prompt);
      return Promise.resolve(new Response(
        'event: delta\ndata: {"text":"rewritten"}\n\nevent: done\ndata: {}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ));
    }) as unknown as typeof fetch;
    const h = harness('original');

    act(() => { h.view.result.current.enhance(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    h.view.rerender({ p: 'rewritten, edited' });
    // Undo still reaches the typed prompt after an edit…
    expect(h.view.result.current.canUndo).toBe(true);

    // …but Enhance treats the edit as the new brief.
    act(() => { h.view.result.current.enhance(); });
    await waitFor(() => { expect(sent.length).toBe(2); });
    expect(sent[1]).toBe('rewritten, edited');
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    expect(draft().enhanceAnchor).toBe('rewritten, edited');
    act(() => { h.view.result.current.undo(); });
    expect(h.onPromptChange).toHaveBeenLastCalledWith('rewritten, edited');
  });

  test('the anchor lives in the draft: a remounted hook still re-rolls and undoes to it', async () => {
    const sent: string[] = [];
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      sent.push((JSON.parse(init?.body as string) as { prompt: string }).prompt);
      return Promise.resolve(new Response(
        'event: delta\ndata: {"text":"rewritten"}\n\nevent: done\ndata: {}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ));
    }) as unknown as typeof fetch;
    const first = harness('original');
    act(() => { first.view.result.current.enhance(); });
    await waitFor(() => { expect(first.view.result.current.status).toBe('done'); });
    first.view.unmount();

    // Composer remounts (e.g. back from Archive) with the draft prompt = rewrite.
    const second = harness('rewritten');
    expect(second.view.result.current.canUndo).toBe(true);
    act(() => { second.view.result.current.enhance(); });
    await waitFor(() => { expect(sent.length).toBe(2); });
    expect(sent[1]).toBe('original');
    await waitFor(() => { expect(second.view.result.current.status).toBe('done'); });
    act(() => { second.view.result.current.undo(); });
    expect(second.onPromptChange).toHaveBeenLastCalledWith('original');
  });

  test('returns stable action callbacks across unchanged renders', () => {
    const h = harness('original');
    const first = h.view.result.current;

    h.view.rerender({ p: 'original' });

    expect(h.view.result.current.enhance).toBe(first.enhance);
    expect(h.view.result.current.undo).toBe(first.undo);
  });

  test('unmount aborts the in-flight stream without toasting', async () => {
    let aborted = false;
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      return Promise.resolve(new Response(
        new ReadableStream<Uint8Array>({ start() { /* stays open */ } }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ));
    }) as unknown as typeof fetch;
    const h = harness('a cat');
    act(() => { h.view.result.current.enhance(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('streaming'); });
    h.view.unmount();
    await waitFor(() => { expect(aborted).toBe(true); });
    expect(useAtelierStore.getState().toasts.length).toBe(0);
  });

  test('unmount mid-stream rolls the prompt back to the anchor, so a partial rewrite never becomes the brief', async () => {
    const sent: string[] = [];
    let call = 0;
    globalThis.fetch = mock((_url: string, init?: RequestInit) => {
      sent.push((JSON.parse(init?.body as string) as { prompt: string }).prompt);
      call += 1;
      if (call === 1) {
        // One delta, then the stream stays open until aborted; like real fetch,
        // aborting the signal rejects the pending read with an AbortError.
        return Promise.resolve(new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'));
              init?.signal?.addEventListener('abort', () => {
                controller.error(new DOMException('aborted', 'AbortError'));
              });
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ));
      }
      return Promise.resolve(new Response(
        'event: delta\ndata: {"text":"rewritten"}\n\nevent: done\ndata: {}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ));
    }) as unknown as typeof fetch;
    const first = harness('original');
    act(() => { first.view.result.current.enhance(); });
    await waitFor(() => { expect(first.getPrompt()).toBe('partial'); });
    first.view.unmount();
    await waitFor(() => { expect(first.getPrompt()).toBe('original'); });

    const second = harness(first.getPrompt());
    expect(second.view.result.current.canUndo).toBe(false);
    act(() => { second.view.result.current.enhance(); });
    await waitFor(() => { expect(second.view.result.current.status).toBe('done'); });
    expect(sent).toEqual(['original', 'original']);
    act(() => { second.view.result.current.undo(); });
    expect(second.onPromptChange).toHaveBeenLastCalledWith('original');
  });

  test('editPrompt: the anchor follows edits of the user prompt, drops when emptied, ignores edits of a rewrite', async () => {
    globalThis.fetch = sseFetch('event: delta\ndata: {"text":"rewritten"}\n\nevent: done\ndata: {}\n\n') as unknown as typeof fetch;
    const h = harness('original');
    act(() => { h.view.result.current.enhance(); });
    await waitFor(() => { expect(h.view.result.current.status).toBe('done'); });
    h.view.rerender({ p: 'rewritten' });

    // Editing the rewrite leaves the anchor alone.
    act(() => { h.view.result.current.editPrompt('rewritten, edited'); });
    h.view.rerender({ p: h.getPrompt() });
    expect(draft().enhanceAnchor).toBe('original');
    expect(h.view.result.current.canUndo).toBe(true);

    // Undo → the box holds the anchor → typing edits the brief itself.
    act(() => { h.view.result.current.undo(); });
    h.view.rerender({ p: h.getPrompt() });
    act(() => { h.view.result.current.editPrompt('original, sharper'); });
    h.view.rerender({ p: h.getPrompt() });
    expect(draft().enhanceAnchor).toBe('original, sharper');
    expect(h.view.result.current.canUndo).toBe(false);

    // Emptying the box while it holds the brief drops the anchor.
    act(() => { h.view.result.current.editPrompt(''); });
    h.view.rerender({ p: h.getPrompt() });
    expect(draft().enhanceAnchor).toBeUndefined();
    act(() => { h.view.result.current.editPrompt('fresh'); });
    h.view.rerender({ p: h.getPrompt() });
    expect(h.view.result.current.canUndo).toBe(false);
  });
});
