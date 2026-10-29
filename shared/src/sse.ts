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
