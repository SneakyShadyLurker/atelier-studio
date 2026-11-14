import { describe, expect, test } from 'bun:test';
import { isTileEvent, toGenerateEvent } from './sse';

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

  test('accepts a coherent step set on progress events', () => {
    const frame = { event: 'tile', data: '{"tileId":"t1","tileIndex":0,"status":"progress","progress":0.4,"phase":"20","step":12,"totalSteps":25,"pass":1,"passCount":2}' };

    expect(toGenerateEvent(frame)).toEqual({
      event: 'tile',
      data: { tileId: 't1', tileIndex: 0, status: 'progress', progress: 0.4, phase: '20', step: 12, totalSteps: 25, pass: 1, passCount: 2 },
    });
  });

  for (const steps of [
    '"step":26,"totalSteps":25,"pass":1,"passCount":1',
    '"step":2,"totalSteps":25,"pass":3,"passCount":2',
    '"step":0,"totalSteps":25,"pass":1,"passCount":1',
    '"step":1.5,"totalSteps":25,"pass":1,"passCount":1',
    '"step":"3","totalSteps":25,"pass":1,"passCount":1',
    '"step":3,"totalSteps":25',
  ]) {
    test(`keeps the fraction but strips a malformed step set (${steps})`, () => {
      const frame = { event: 'tile', data: `{"tileId":"t1","tileIndex":0,"status":"progress","progress":0.4,${steps}}` };

      expect(toGenerateEvent(frame)).toEqual({
        event: 'tile',
        data: { tileId: 't1', tileIndex: 0, status: 'progress', progress: 0.4 },
      });
    });
  }
});

describe('batch, queue and done SSE events', () => {
  test('accepts queue and done events', () => {
    expect(toGenerateEvent({ event: 'queue', data: '{"batchId":"b1","status":"running","startedAt":5}' }))
      .toEqual({ event: 'queue', data: { batchId: 'b1', status: 'running', startedAt: 5 } });
    expect(toGenerateEvent({ event: 'done', data: '{"batchId":"b1"}' })).toEqual({ event: 'done', data: { batchId: 'b1' } });
  });

  test('rejects queue and done events outside their shape', () => {
    expect(() => toGenerateEvent({ event: 'queue', data: '{"batchId":"b1","status":"queued"}' })).toThrow('invalid queue SSE payload');
    expect(() => toGenerateEvent({ event: 'done', data: '{}' })).toThrow('invalid done SSE payload');
  });

  test('accepts a batch event with status and queue position, and rejects an unknown status', () => {
    const data = { batchId: 'b1', createdAt: 1, startedAt: 2, status: 'queued', queueLengthAhead: 3, tiles: [{ tileId: 't1', tileIndex: 0, seed: 7 }] } as const;
    expect(toGenerateEvent({ event: 'batch', data: JSON.stringify(data) })).toEqual({ event: 'batch', data });
    expect(() => toGenerateEvent({ event: 'batch', data: JSON.stringify({ ...data, status: 'paused' }) })).toThrow('invalid batch SSE payload');
    expect(() => toGenerateEvent({ event: 'batch', data: JSON.stringify({ ...data, tiles: [{ tileId: 't1', tileIndex: 0 }] }) })).toThrow('invalid batch SSE payload');
  });

  test('accepts failed tiles with a moderation notice and rejects a malformed one', () => {
    const failed = { tileId: 't1', tileIndex: 0, status: 'failed', error: 'content-policy violation', completedAt: 1, moderation: { reason: 'graphic-violence', target: 'image' } } as const;
    expect(toGenerateEvent({ event: 'tile', data: JSON.stringify(failed) })).toEqual({ event: 'tile', data: failed });
    expect(() => toGenerateEvent({ event: 'tile', data: JSON.stringify({ ...failed, moderation: { reason: 'other', target: 'image' } }) }))
      .toThrow('invalid tile SSE payload');
  });

  test('rejects a malformed progress event without stripping its step set', () => {
    const value: Record<string, unknown> = { tileId: 't1', tileIndex: 0, status: 'progress', progress: 3, step: 0 };
    expect(isTileEvent(value)).toBe(false);
    expect(value.step).toBe(0);
  });
});
