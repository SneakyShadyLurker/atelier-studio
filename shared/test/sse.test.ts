import { describe, expect, test } from 'bun:test';
import { createSseFrameAssembler, nextSseFrame, parseSseFrame, SSE_TERMINATOR_REWIND } from '../src/sse';

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

// The reassembly loop both readers ran before the assembler: append every
// chunk to one string and rescan it from just before the previous end.
function legacyFrames(chunks: readonly string[]): { frames: string[]; pending: string } {
  const frames: string[] = [];
  let buffer = '';
  let searchFrom = 0;
  for (const chunk of chunks) {
    buffer += chunk;
    for (;;) {
      const next = nextSseFrame(buffer, searchFrom);
      if (!next) {
        searchFrom = Math.max(0, buffer.length - SSE_TERMINATOR_REWIND);
        break;
      }
      buffer = next.rest;
      searchFrom = 0;
      frames.push(next.raw);
    }
  }
  return { frames, pending: buffer };
}

function assembledFrames(chunks: readonly string[]): { frames: string[]; pending: string } {
  const assembler = createSseFrameAssembler();
  const frames = chunks.flatMap((chunk) => assembler.push(chunk));
  return { frames, pending: assembler.pending() };
}

const TERMINATORS = ['\n\n', '\r\n\n', '\n\r\n', '\r\n\r\n'] as const;

describe('createSseFrameAssembler', () => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ...TERMINATORS.map((t) => [`one chunk, ${JSON.stringify(t)}`, [`data: a${t}`]] as const),
    ...TERMINATORS.flatMap((t) => Array.from({ length: t.length - 1 }, (_unused, cut) => [
      `terminator ${JSON.stringify(t)} split after ${cut + 1}`,
      [`data: a${t.slice(0, cut + 1)}`, `${t.slice(cut + 1)}data: b${t}`],
    ] as const)),
    ['mixed terminators in one chunk', ['event: a\ndata: 1\r\n\nevent: b\ndata: 2\n\r\ndata: 3\r\n\r\ndata: 4\n\n']],
    ['many frames in one chunk with a partial tail', ['data: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4']],
    ['trailing partial frame at end of stream', ['data: a\n\n', 'data: b', '\r\n']],
    ['a frame spread over many chunks', ['da', 'ta', ': ', 'xx', 'xx', '\r', '\n', '\r', '\n', 'data: y\n', '\n']],
    ['a lone CR before a LF pair', ['data: a\r', '\n\n']],
    ['CR runs that never terminate', ['data: a\r\r\n\r\r\n']],
    ['empty chunks', ['', 'data: a', '', '\n', '', '\n', '']],
    ['comment-only frames', [':keepalive\n\n:keepalive\n', '\n']],
    ['blank frames between terminators', ['\n\n\n\n\r\n\r\n']],
  ];

  test.each(cases)('matches the legacy reassembly: %s', (_label, chunks) => {
    expect(assembledFrames(chunks)).toEqual(legacyFrames(chunks));
  });

  test('matches the legacy reassembly at random chunk boundaries (seeded)', () => {
    let state = 0x5eed;
    const random = (): number => {
      // mulberry32: deterministic, so a failure reproduces from the seed.
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const alphabet = ['\n', '\r', 'a', ':', ' ', 'data', 'event', '\r\n', '\n\n', '\r\n\r\n', 'xyz'];
    for (let run = 0; run < 500; run += 1) {
      let stream = '';
      const length = Math.floor(random() * 80);
      for (let i = 0; i < length; i += 1) stream += alphabet[Math.floor(random() * alphabet.length)] ?? '';
      const chunks: string[] = [];
      for (let at = 0; at < stream.length;) {
        const size = Math.floor(random() * 8);
        chunks.push(stream.slice(at, at + size));
        at += size;
      }
      expect(assembledFrames(chunks)).toEqual(legacyFrames([stream]));
      expect(assembledFrames(chunks)).toEqual(legacyFrames(chunks));
    }
  });
});
