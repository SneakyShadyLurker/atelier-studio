import { describe, expect, test } from 'bun:test';
import { nextSseFrame, parseSseFrame } from '../src/sse';

describe('nextSseFrame', () => {
  test('consumes exactly the terminator for every LF/CRLF blank-line form', () => {
    for (const terminator of ['\n\n', '\r\n\n', '\n\r\n', '\r\n\r\n']) {
      expect(nextSseFrame(`data: a${terminator}data: b`)).toEqual({ raw: 'data: a', rest: 'data: b' });
    }
  });

  test('returns null until a frame is terminated', () => {
    expect(nextSseFrame('data: a\r\n\r')).toBeNull();
    expect(nextSseFrame('event: done\ndata: {"batchId":"b1"}')).toBeNull();
  });

  test('splits mixed terminators without bleeding into the next frame', () => {
    const first = nextSseFrame('event: a\ndata: 1\r\n\nevent: b\ndata: 2\n\r\n');
    expect(first && parseSseFrame(first.raw)).toEqual({ event: 'a', data: '1' });
    const second = first && nextSseFrame(first.rest);
    expect(second && parseSseFrame(second.raw)).toEqual({ event: 'b', data: '2' });
    expect(second?.rest).toBe('');
  });
});

describe('parseSseFrame', () => {
  test('joins multi-line data fields with newlines and ignores comment lines', () => {
    expect(parseSseFrame(':note\nevent: tile\ndata: {"a":1,\r\ndata: "b":2}')).toEqual({ event: 'tile', data: '{"a":1,\n"b":2}' });
  });

  test('defaults a missing event field to message', () => {
    expect(parseSseFrame('data: hello')).toEqual({ event: 'message', data: 'hello' });
  });

  test('surfaces no frame without a data field', () => {
    expect(parseSseFrame(':keepalive')).toBeNull();
    expect(parseSseFrame('event: tile')).toBeNull();
  });
});
