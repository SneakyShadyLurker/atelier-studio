import { describe, expect, test } from 'bun:test';
import { toGenerateEvent } from './sse';

describe('progress tile SSE events', () => {
  test('accepts video done events', () => {
    const frame = { event: 'tile', data: '{"tileId":"t1","tileIndex":0,"status":"done","url":"/api/img/t1","thumbUrl":"/api/img/t1/thumb","ext":"mp4","mime":"video/mp4","completedAt":1700000000000}' };

    expect(toGenerateEvent(frame)).toEqual({
      event: 'tile',
      data: {
        tileId: 't1',
        tileIndex: 0,
        status: 'done',
        url: '/api/img/t1',
        thumbUrl: '/api/img/t1/thumb',
        ext: 'mp4',
        mime: 'video/mp4',
        completedAt: 1_700_000_000_000,
      },
    });
  });

  test('rejects mismatched media pairs in done events', () => {
    const mp4Png = { event: 'tile', data: '{"tileId":"t1","tileIndex":0,"status":"done","url":"/api/img/t1","ext":"mp4","mime":"image/png","completedAt":1700000000000}' };
    const pngMp4 = { event: 'tile', data: '{"tileId":"t2","tileIndex":0,"status":"done","url":"/api/img/t2","ext":"png","mime":"video/mp4","completedAt":1700000000000}' };

    expect(() => toGenerateEvent(mp4Png)).toThrow('invalid tile SSE payload');
    expect(() => toGenerateEvent(pngMp4)).toThrow('invalid tile SSE payload');
  });

  test('accepts bounded numeric progress events', () => {
    const frame = { event: 'tile', data: '{"tileId":"t1","tileIndex":0,"status":"progress","progress":0.5,"phase":"sampling"}' };

    expect(toGenerateEvent(frame)).toEqual({
      event: 'tile',
      data: { tileId: 't1', tileIndex: 0, status: 'progress', progress: 0.5, phase: 'sampling' },
    });
  });

  test('rejects non-number progress events', () => {
    const frame = { event: 'tile', data: '{"tileId":"t1","tileIndex":0,"status":"progress","progress":"x"}' };

    expect(() => toGenerateEvent(frame)).toThrow('invalid tile SSE payload');
  });

  test('rejects out-of-range progress events', () => {
    const frame = { event: 'tile', data: '{"tileId":"t1","tileIndex":0,"status":"progress","progress":2}' };

    expect(() => toGenerateEvent(frame)).toThrow('invalid tile SSE payload');
  });
});
