import { describe, expect, test } from 'bun:test';
import { parseBrainstormStream } from './sse';

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

describe('parseBrainstormStream', () => {
  test('yields prompt then done events', async () => {
    const body =
      'event: prompt\ndata: {"index":0,"text":"a"}\n\n' +
      'event: prompt\ndata: {"index":1,"text":"b"}\n\n' +
      'event: done\ndata: {"count":2}\n\n';
    const events = [];
    for await (const e of parseBrainstormStream(streamOf(body))) events.push(e);
    expect(events).toEqual([
      { event: 'prompt', data: { index: 0, text: 'a' } },
      { event: 'prompt', data: { index: 1, text: 'b' } },
      { event: 'done', data: { count: 2 } },
    ]);
  });
});
