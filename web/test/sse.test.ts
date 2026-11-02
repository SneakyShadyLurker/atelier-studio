import { describe, expect, test } from 'bun:test';
import { isTileEvent, readSseFrames, toGenerateEvent } from '../src/api/sse';

describe('SSE parser', () => {
  test('reads joined multi-line data across chunks, skips comments and drops an unterminated tail', async () => {
    const encoder = new TextEncoder();
    const chunks = [':keepalive\n\nevent: tile\ndata: {"a":1,\r', '\ndata: "b":2}\r\n\r\ndata: hello\n\nevent: done\ndata: {}'];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const frames = await Array.fromAsync(readSseFrames(stream));

    expect(frames).toEqual([
      { event: 'tile', data: '{"a":1,\n"b":2}' },
      { event: 'message', data: 'hello' },
    ]);
  });

  test('rejects unknown event types at the generate boundary', () => {
    expect(() => toGenerateEvent({ event: 'nope', data: '{"ok":true}' })).toThrow('unknown SSE event');
  });

  test('rejects tile errors outside the strict public category union', () => {
    const frame = { event: 'tile', data: '{"tileId":"t1","tileIndex":0,"status":"failed","error":"raw upstream 500","completedAt":1}' };

    expect(() => toGenerateEvent(frame)).toThrow('invalid tile SSE payload');
  });

  test('accepts partial tile events with a data: preview URL', () => {
    const frame = { event: 'tile', data: '{"tileId":"t1","tileIndex":0,"status":"partial","preview":"data:image/png;base64,abc","index":0}' };
    const event = toGenerateEvent(frame);
    expect(event).toEqual({
      event: 'tile',
      data: { tileId: 't1', tileIndex: 0, status: 'partial', preview: 'data:image/png;base64,abc', index: 0 },
    });
  });

  test('accepts optional thumbnail URLs on done tile events', () => {
    const frame = { event: 'tile', data: '{"tileId":"t1","tileIndex":0,"status":"done","url":"/api/img/t1","thumbUrl":"/api/img/t1/thumb","ext":"png","mime":"image/png","completedAt":1}' };
    const event = toGenerateEvent(frame);
    expect(event).toEqual({
      event: 'tile',
      data: {
        tileId: 't1',
        tileIndex: 0,
        status: 'done',
        url: '/api/img/t1',
        thumbUrl: '/api/img/t1/thumb',
        ext: 'png',
        mime: 'image/png',
        completedAt: 1,
      },
    });
  });

  test('rejects non-string thumbnail URLs on done tile events', () => {
    const frame = { event: 'tile', data: '{"tileId":"t1","tileIndex":0,"status":"done","url":"/api/img/t1","thumbUrl":5,"ext":"png","mime":"image/png","completedAt":1}' };
    expect(() => toGenerateEvent(frame)).toThrow('invalid tile SSE payload');
  });

  test('accepts canceled tile events with completedAt', () => {
    expect(isTileEvent({ tileId: 't1', tileIndex: 0, status: 'canceled', completedAt: 1 })).toBe(true);
  });

  test('rejects canceled tile events missing completedAt', () => {
    expect(isTileEvent({ tileId: 't1', tileIndex: 0, status: 'canceled' })).toBe(false);
  });

  test('rejects canceled tile events missing tile identity fields', () => {
    expect(isTileEvent({ tileIndex: 0, status: 'canceled', completedAt: 1 })).toBe(false);
    expect(isTileEvent({ tileId: 't1', status: 'canceled', completedAt: 1 })).toBe(false);
  });

  test('rejects partial tile events whose preview is not a data: URL', () => {
    const frame = { event: 'tile', data: '{"tileId":"t1","tileIndex":0,"status":"partial","preview":"http://evil/x.png","index":0}' };
    expect(() => toGenerateEvent(frame)).toThrow('invalid tile SSE payload');
  });

  test('accepts batch events with refImageIds when all entries are strings', () => {
    const frame = { event: 'batch', data: '{"batchId":"b1","createdAt":123,"tiles":[{"tileId":"t1","tileIndex":0,"seed":1}],"refImageIds":["ab"]}' };
    const event = toGenerateEvent(frame);
    expect(event.event).toBe('batch');
    if (event.event !== 'batch') return;
    expect(event.data.refImageIds).toEqual(['ab']);
    expect(event.data.createdAt).toBe(123);
  });

  test('rejects batch events missing server-authoritative createdAt', () => {
    const frame = { event: 'batch', data: '{"batchId":"b1","tiles":[{"tileId":"t1","tileIndex":0,"seed":1}]}' };
    expect(() => toGenerateEvent(frame)).toThrow('invalid batch SSE payload');
  });

  test('rejects batch events whose refImageIds is not a string array', () => {
    const cases = [
      '{"batchId":"b1","tiles":[],"refImageIds":"not-array"}',
      '{"batchId":"b1","tiles":[],"refImageIds":[1,2]}',
      '{"batchId":"b1","tiles":[],"refImageIds":{"0":"x"}}',
    ];
    for (const data of cases) {
      const frame = { event: 'batch', data: data };
      expect(() => toGenerateEvent(frame)).toThrow('invalid batch SSE payload');
    }
  });

  test('rejects partial tile events with non-image data URI mime types', () => {
    const cases = [
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'data:image/svg+xml;base64,PHN2Zy8+',
      'data:application/octet-stream;base64,abc',
      'data:',
      'data:image/png;base64,', // empty payload
    ];
    for (const preview of cases) {
      const frame = { event: 'tile', data: JSON.stringify({ tileId: 't1', tileIndex: 0, status: 'partial', preview, index: 0 }) };
      expect(() => toGenerateEvent(frame)).toThrow('invalid tile SSE payload');
    }
  });
});
