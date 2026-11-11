// SSE frame grammar — the pure splitter and parser both sides of the wire
// share. The api provider adapters (api/src/providers/_sse.ts) and the web
// client (web/src/api/sse.ts) each add their own streaming/byte-limit
// wrappers, but frame boundaries and `event:`/`data:` field parsing live here
// so the two never drift.

export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Parse one SSE frame's raw text (the content between two blank-line
 * terminators, terminator excluded). Returns `null` when the frame carries
 * no `data:` field — comment-only or empty frames are not surfaced.
 */
export function parseSseFrame(raw: string): SseFrame | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

// A blank line ends a frame. Lines end in LF or CRLF, so the terminator is
// 2-4 characters (`\n\n`, `\r\n\n`, `\n\r\n`, `\r\n\r\n`).
const FRAME_TERMINATOR = /\r?\n\r?\n/g;

/** Longest terminator minus one: rewind this far so a split terminator still matches. */
export const SSE_TERMINATOR_REWIND = 3;

/**
 * Split the first complete frame off `buffer`, scanning for its terminator
 * from `from`. Returns the frame's raw text (terminator excluded) and the
 * remaining buffer, or `null` when no complete frame is buffered yet.
 */
export function nextSseFrame(buffer: string, from = 0): { raw: string; rest: string } | null {
  FRAME_TERMINATOR.lastIndex = from;
  const match = FRAME_TERMINATOR.exec(buffer);
  if (!match) return null;
  return { raw: buffer.slice(0, match.index), rest: buffer.slice(match.index + match[0].length) };
}

export interface SseFrameAssembler {
  /** Feed one decoded chunk; returns the raw text of every frame it completes, in order. */
  push(text: string): string[];
  /** The unterminated remainder (dropped at end of stream, like the readers always did). */
  pending(): string;
}

/**
 * Reassembles frames from decoded chunks without re-flattening a growing
 * string. A frame of a multi-MB base64 image arrives in many chunks; appending
 * each to one string and running the terminator regex over it copied the
 * whole buffer per chunk. Here the in-progress frame stays a list of chunks,
 * the terminator is looked for only in the new chunk plus the last
 * SSE_TERMINATOR_REWIND characters carried over (a terminator split across
 * chunks still matches), and the list is joined once per completed frame.
 */
export function createSseFrameAssembler(): SseFrameAssembler {
  let parts: string[] = [];
  // The last few characters of `parts`, for terminators straddling chunks.
  let tail = '';
  return {
    push(text: string): string[] {
      const window = tail + text;
      FRAME_TERMINATOR.lastIndex = 0;
      const first = FRAME_TERMINATOR.exec(window);
      if (!first) {
        if (text.length > 0) parts.push(text);
        tail = window.slice(-SSE_TERMINATOR_REWIND);
        return [];
      }
      // `parts` holds no terminator, so the first match in the window is the
      // first in the whole buffer. Join once and split every frame in it.
      parts.push(text);
      const buffer = parts.join('');
      const offset = buffer.length - window.length;
      const frames = [buffer.slice(0, offset + first.index)];
      let start = offset + first.index + first[0].length;
      for (;;) {
        FRAME_TERMINATOR.lastIndex = start;
        const match = FRAME_TERMINATOR.exec(buffer);
        if (!match) break;
        frames.push(buffer.slice(start, match.index));
        start = match.index + match[0].length;
      }
      const rest = buffer.slice(start);
      parts = rest.length > 0 ? [rest] : [];
      tail = rest.slice(-SSE_TERMINATOR_REWIND);
      return frames;
    },
    pending: () => parts.join(''),
  };
}
