import { describe, expect, test } from 'bun:test';
import { parseSseFrame } from '@atelier/shared/sse';
import { frameDataText, readSseFrames } from './_sse';

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const neverOversize = (limit: number, total: number): never => {
  throw new Error(`oversize ${total}>${limit}`);
};

describe('_sse readSseFrames', () => {
  test('parses event + data frames split on blank line', async () => {
    const frames = [];
    for await (const f of readSseFrames(streamOf('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n'), 1024, neverOversize)) {
      frames.push(f);
    }
    expect(frames).toEqual([
      { event: 'a', data: '1', raw: 'event: a\ndata: 1' },
      { event: 'b', data: '2', raw: 'event: b\ndata: 2' },
    ]);
  });

  test('data-only frame defaults event to "message"', async () => {
    const frames = [];
    for await (const f of readSseFrames(streamOf('data: hello\n\n'), 1024, neverOversize)) frames.push(f);
    expect(frames).toEqual([{ event: 'message', data: 'hello', raw: 'data: hello' }]);
  });

  test('multi-line data is joined with newline', () => {
    expect(parseSseFrame('data: a\ndata: b')).toEqual({ event: 'message', data: 'a\nb' });
  });

  // CLIProxyAPI 7.2.50 pretty-prints JSON payloads across lines with only the
  // first line data:-prefixed; frameDataText recovers the full payload from
  // the raw frame without disturbing spec-compliant frames.
  test('frameDataText recovers a pretty-printed prefix-less JSON payload', () => {
    const raw = 'event: error\ndata: {\n  "error": {\n    "message": "boom"\n  }\n}';
    const frame = { event: 'error', data: '{', raw };
    expect(JSON.parse(frameDataText(frame))).toEqual({ error: { message: 'boom' } });
  });

  test('frameDataText leaves valid single-line JSON data untouched', () => {
    const frame = { event: 'message', data: '{"a":1}', raw: 'data: {"a":1}' };
    expect(frameDataText(frame)).toBe('{"a":1}');
  });

  test('frameDataText leaves proper multi-data-line JSON untouched', () => {
    const raw = 'data: {"a":\ndata: 1}';
    const frame = parseSseFrame(raw);
    if (!frame) throw new Error('frame should parse');
    expect(frameDataText({ ...frame, raw })).toBe('{"a":\n1}');
  });

  test('frameDataText passes non-JSON data through unchanged', () => {
    const frame = { event: 'message', data: '[DONE]', raw: 'data: [DONE]' };
    expect(frameDataText(frame)).toBe('[DONE]');
  });

  test('invokes onOversize past the byte limit', async () => {
    let tripped = false;
    const gen = readSseFrames(streamOf('x'.repeat(100)), 10, () => { tripped = true; throw new Error('too big'); });
    let caught: unknown;
    try {
      for await (const _frame of gen) { /* drain */ }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('too big');
    expect(tripped).toBe(true);
  });

  test('throws signal.reason if signal is already aborted on entry', async () => {
    const ac = new AbortController();
    const reason = new DOMException('pre-aborted', 'AbortError');
    ac.abort(reason);
    const gen = readSseFrames(streamOf('data: 1\n\n'), 1024, neverOversize, ac.signal);
    let caught: unknown;
    try {
      for await (const _frame of gen) { /* unreachable */ }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });

  test('aborting mid-stream surfaces signal.reason and cancels the stream', async () => {
    const ac = new AbortController();
    const reason = new DOMException('mid-stream cancel', 'AbortError');
    let cancelCalled = false;
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\n'));
        // intentionally never enqueue more / never close — abort path drives termination
      },
      cancel() { cancelCalled = true; },
    });
    const frames: { event: string; data: string; raw: string }[] = [];
    let caught: unknown;
    const run = (async () => {
      try {
        for await (const f of readSseFrames(stalled, 1024, neverOversize, ac.signal)) {
          frames.push(f);
          ac.abort(reason);
        }
      } catch (error) {
        caught = error;
      }
    })();
    await run;
    expect(frames).toEqual([{ event: 'message', data: 'first', raw: 'data: first' }]);
    expect(caught).toBe(reason);
    expect(cancelCalled).toBe(true);
  });
});
